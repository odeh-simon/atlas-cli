import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError, StateTransitionError } from "@atlas/domain";
import { appendEvent, createArtifactRecord, listArtifactsForSession, listSessionsForRepository, updateSessionState } from "@atlas/persistence";
import { reviewPackageSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

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
    const checks = artifacts.filter((artifact) => artifact.type === "check_result" && artifact.status === "valid");
    if (contract === undefined || execution === undefined || checks.length === 0) {
      throw new GateFailedError("Review package requires approved contract, execution report, and passing check result");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const reviewPackage = reviewPackageSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "review_package",
      schema_version: 1,
      content_version: 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [contract.artifactId, execution.artifactId, ...checks.map((check) => check.artifactId)],
      content_sha256: "0".repeat(64),
      metadata: {},
      contract_artifact_id: contract.artifactId,
      execution_report_artifact_id: execution.artifactId,
      check_result_artifact_ids: checks.map((check) => check.artifactId),
      review_ready_label: "ready",
      rubric_markdown:
        "Review the implementation against the approved contract. Classify findings as blocking, important, suggestion, question, or accepted_deviation."
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
      contentVersion: 1,
      mediaType: "application/json",
      content: `${JSON.stringify(reviewPackage, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "review_package",
      schemaVersion: 1,
      contentVersion: 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "atlas",
      createdAt: now
    });
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "review_package.prepared",
      actorType: "atlas",
      occurredAt: now,
      summary: "Review package prepared",
      metadata: { reviewPackageArtifactId: artifactId }
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
