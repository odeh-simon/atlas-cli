import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError, StateTransitionError } from "@atlas/domain";
import {
  addArtifactDependency,
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@atlas/persistence";
import { reviewPackageSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface PrepareReviewResult {
  readonly sessionId: string;
  readonly reviewPackageArtifactId: string;
  readonly state: string;
  readonly nextCommand: string;
}

export async function prepareReviewPackage(options: RuntimeOptions = {}): Promise<PrepareReviewResult> {
  const runtime = await openAtlasRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) throw new StateTransitionError("No active session found for review preparation");

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const contract = artifacts.find((artifact) => artifact.type === "implementation_contract" && artifact.status === "approved");
    const execution = artifacts.find((artifact) => artifact.type === "execution_report");
    const latestCheck = artifacts.filter((artifact) => artifact.type === "check_result").at(-1);
    const checks = latestCheck?.status === "valid" ? [latestCheck] : [];
    if (contract === undefined || execution === undefined || checks.length === 0) {
      throw new GateFailedError("Review package requires approved contract, execution report, and passing check result");
    }
    const visualEvidenceArtifactIds = readVisualEvidenceIds(runtime.paths.artifactRoot, checks.at(-1)).filter((id) =>
      artifacts.some((artifact) => artifact.artifactId === id && artifact.status === "valid")
    );
    const git = readWorkflowGitSnapshot(runtime.paths.cwd);

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const contentVersion = artifacts.filter((artifact) => artifact.type === "review_package").length + 1;
    const reviewPackage = reviewPackageSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "review_package",
      schema_version: 1,
      content_version: contentVersion,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [
        contract.artifactId,
        execution.artifactId,
        ...checks.map((check) => check.artifactId),
        ...visualEvidenceArtifactIds
      ],
      content_sha256: "0".repeat(64),
      metadata: {
        ...(git === undefined
          ? {}
          : {
              git,
              git_fingerprint: git.fingerprint
            })
      },
      contract_artifact_id: contract.artifactId,
      execution_report_artifact_id: execution.artifactId,
      check_result_artifact_ids: checks.map((check) => check.artifactId),
      visual_evidence_artifact_ids: visualEvidenceArtifactIds,
      review_ready_label: "ready",
      rubric_markdown:
        "Review the implementation against the approved contract and attached visual evidence. Classify findings as blocking, important, suggestion, question, or accepted_deviation."
    });
    const next = transition({
      state: session.primaryState,
      command: "prepare_review",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "review_package",
      contentVersion,
      mediaType: "application/json",
      content: `${JSON.stringify(reviewPackage, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "review_package",
      schemaVersion: 1,
      contentVersion,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "atlas",
      createdAt: now
    });
    for (const parentId of reviewPackage.parents) {
      addArtifactDependency(runtime.db, {
        artifactId,
        dependsOnArtifactId: parentId,
        dependencyKind: visualEvidenceArtifactIds.includes(parentId) ? "evidence" : "parent"
      });
    }
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "review_package.prepared",
      actorType: "atlas",
      occurredAt: now,
      summary: "Review package prepared",
      metadata: { reviewPackageArtifactId: artifactId, gitFingerprint: git?.fingerprint }
    });

    return {
      sessionId: session.sessionId,
      reviewPackageArtifactId: artifactId,
      state: next,
      nextCommand: "atlas review import <file>"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function readVisualEvidenceIds(
  artifactRoot: string,
  check: { readonly storageUri: string } | undefined
): string[] {
  if (check === undefined) return [];
  try {
    const raw = JSON.parse(readFileSync(join(artifactRoot, check.storageUri), "utf8")) as {
      metadata?: { visual_evidence_artifact_ids?: unknown };
    };
    return Array.isArray(raw.metadata?.visual_evidence_artifact_ids)
      ? raw.metadata.visual_evidence_artifact_ids.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}
