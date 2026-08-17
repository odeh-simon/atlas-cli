import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError, ValidationError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  createFinding,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@atlas/persistence";
import { findingSchema, reviewReportSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ImportReviewReportInput extends RuntimeOptions {
  readonly filePath?: string | undefined;
  readonly report?: ImportedReviewReportPayload | undefined;
}

export interface ImportedReviewReportPayload {
  readonly summary?: string | undefined;
  readonly findings?: readonly Record<string, unknown>[] | undefined;
}

export interface ImportReviewReportResult {
  readonly sessionId: string;
  readonly reviewReportArtifactId: string;
  readonly findingIds: readonly string[];
  readonly state: string;
  readonly nextCommand: string;
}

export async function importReviewReport(input: ImportReviewReportInput): Promise<ImportReviewReportResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) throw new StateTransitionError("No active session found for review import");

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const reviewPackage = artifacts.filter((artifact) => artifact.type === "review_package").at(-1);
    if (reviewPackage === undefined) {
      throw new StateTransitionError("Review import requires a prepared review package");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const contentVersion = artifacts.filter((artifact) => artifact.type === "review_report").length + 1;
    const git = readWorkflowGitSnapshot(runtime.paths.cwd);
    const raw = readReviewReportPayload(input);
    const findings = (raw.findings ?? []).map((finding, index) =>
      findingSchema.parse({
        ...finding,
        artifact_id: newId("art"),
        session_id: session.sessionId,
        type: "finding",
        schema_version: 1,
        content_version: 1,
        created_at: now,
        producer: { type: "import" },
        sensitivity: "internal",
        parents: [artifactId],
        content_sha256: "0".repeat(64),
        metadata: {},
        finding_id: finding.finding_id ?? `REV-${String(index + 1).padStart(3, "0")}`,
        review_iteration: finding.review_iteration ?? 1,
        status: finding.status ?? "open",
        evidence: finding.evidence ?? []
      })
    );
    const report = reviewReportSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "review_report",
      schema_version: 1,
      content_version: contentVersion,
      created_at: now,
      producer: { type: "import" },
      sensitivity: "confidential",
      parents: [reviewPackage.artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        ...(git === undefined
          ? {}
          : {
              git,
              git_fingerprint: git.fingerprint
            })
      },
      review_package_artifact_id: reviewPackage.artifactId,
      review_package_sha256: reviewPackage.sha256,
      summary: raw.summary ?? "Imported review report",
      findings
    });
    const next = transition({
      state: session.primaryState,
      command: "import_review",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "review_report",
      contentVersion,
      mediaType: "application/json",
      content: `${JSON.stringify(report, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "review_report",
      schemaVersion: 1,
      contentVersion,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "import",
      createdAt: now
    });
    for (const finding of report.findings) {
      createFinding(runtime.db, {
        findingId: finding.finding_id,
        sessionId: session.sessionId,
        reviewReportArtifactId: artifactId,
        reviewIteration: finding.review_iteration,
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        evidence: finding.evidence,
        affectedFiles: finding.affected_files,
        requirementIds: finding.requirement_ids,
        proposedAction: finding.proposed_action,
        status: finding.status,
        now
      });
    }
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "review.imported",
      actorType: "user",
      occurredAt: now,
      summary: "Review report imported",
      metadata: {
        reviewReportArtifactId: artifactId,
        findingIds: report.findings.map((finding) => finding.finding_id),
        gitFingerprint: git?.fingerprint
      }
    });

    return {
      sessionId: session.sessionId,
      reviewReportArtifactId: artifactId,
      findingIds: report.findings.map((finding) => finding.finding_id),
      state: next,
      nextCommand: report.findings.some((finding) => finding.status === "open" || finding.status === "reopened")
        ? "atlas findings disposition <id>"
        : "atlas complete --check"
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError("Review report must be valid JSON", undefined, error);
    }
    throw error;
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function readReviewReportPayload(input: ImportReviewReportInput): ImportedReviewReportPayload {
  if (input.report !== undefined) return input.report;
  if (input.filePath === undefined) {
    throw new ValidationError("Review report import requires filePath or report");
  }
  return JSON.parse(readFileSync(input.filePath, "utf8")) as ImportedReviewReportPayload;
}
