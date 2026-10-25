import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError, ValidationError } from "@atlas/domain";
import {
  appendEvent,
  addArtifactDependency,
  createArtifactRecord,
  createFindingDisposition,
  createFinding,
  listFindingsForSession,
  listArtifactsForSession,
  listSessionsForRepository,
  updateFindingStatus,
  updateSessionState
} from "@atlas/persistence";
import { findingSchema, reviewPackageSchema, reviewReportSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";
import { readVerifiedArtifactText } from "./evidence.js";

export interface ImportReviewReportInput extends RuntimeOptions {
  readonly filePath?: string | undefined;
  readonly report?: ImportedReviewReportPayload | undefined;
  readonly reviewerActorId?: string | undefined;
  readonly reviewerRunId?: string | undefined;
}

export interface ResolutionEvidenceReference {
  readonly artifact_id: string;
  readonly claim?: string | undefined;
  readonly location?: string | undefined;
}

export interface ImportedReviewReportPayload {
  readonly summary?: string | undefined;
  readonly findings?: readonly Record<string, unknown>[] | undefined;
  readonly reviewer_actor_id?: string | undefined;
  readonly reviewer_run_id?: string | undefined;
  readonly resolved_findings?: readonly {
    readonly finding_id: string;
    readonly resolution_evidence: readonly (string | ResolutionEvidenceReference)[];
  }[] | undefined;
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

    const reviewPackageContent = readVerifiedArtifactText(runtime.paths.artifactRoot, reviewPackage);
    const parsedPackage = reviewPackageSchema.parse(JSON.parse(reviewPackageContent) as unknown);
    if (
      parsedPackage.contract_sha256 === undefined ||
      parsedPackage.implementation_diff_sha256 === undefined ||
      parsedPackage.git_fingerprint === undefined ||
      parsedPackage.implementation_actor_id === undefined ||
      parsedPackage.implementation_run_id === undefined
    ) {
      throw new StateTransitionError("Legacy review package lacks independent-review bindings; rerun atlas review prepare");
    }
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const contentVersion = artifacts.filter((artifact) => artifact.type === "review_report").length + 1;
    const git = readWorkflowGitSnapshot(runtime.paths.cwd);
    if (git === undefined || git.fingerprint !== parsedPackage.git_fingerprint) {
      throw new ValidationError("Review package is stale against current Git state; rerun checks and review preparation");
    }
    const raw = readReviewReportPayload(input);
    const reviewerActorId = input.reviewerActorId?.trim();
    if (reviewerActorId === undefined || reviewerActorId.length === 0) {
      throw new ValidationError("Review import requires an explicit trusted reviewer actor identity");
    }
    const reviewerRunId = input.reviewerRunId ?? newId("reviewrun");
    if (reviewerActorId === parsedPackage.implementation_actor_id || reviewerRunId === parsedPackage.implementation_run_id) {
      throw new ValidationError("Reviewer identity/run must be independent from the implementing agent run");
    }
    const existingFindings = listFindingsForSession(runtime.db, session.sessionId);
    const resolvedFindings = raw.resolved_findings ?? [];
    for (const resolution of resolvedFindings) {
      const prior = existingFindings.find((finding) => finding.findingId === resolution.finding_id);
      if (prior === undefined || (prior.status !== "open" && prior.status !== "reopened")) {
        throw new ValidationError("Review resolution must reference an open/reopened prior finding", { findingId: resolution.finding_id });
      }
      const acceptedEvidenceIds = [parsedPackage.implementation_diff_artifact_id, ...parsedPackage.check_result_artifact_ids].filter(
        (value): value is string => value !== undefined
      );
      if (resolution.resolution_evidence.some((evidence) => typeof evidence === "string")) {
        throw new ValidationError("Legacy free-form resolution evidence cannot automatically resolve a finding", {
          findingId: resolution.finding_id
        });
      }
      for (const evidence of resolution.resolution_evidence as readonly ResolutionEvidenceReference[]) {
        const record = artifacts.find((artifact) => artifact.artifactId === evidence.artifact_id);
        if (
          !acceptedEvidenceIds.includes(evidence.artifact_id) ||
          record === undefined ||
          record.sessionId !== session.sessionId ||
          record.status !== "valid"
        ) {
          throw new ValidationError("Review resolution evidence must reference a valid current diff or check artifact", {
            findingId: resolution.finding_id,
            artifactId: evidence.artifact_id
          });
        }
      }
    }
    const findings = (raw.findings ?? []).map((finding, index) =>
      findingSchema.parse({
        ...finding,
        artifact_id: newId("art"),
        session_id: session.sessionId,
        type: "finding",
        schema_version: 1,
        content_version: 1,
        created_at: now,
        producer: { type: "import", id: reviewerActorId },
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
      schema_version: 2,
      content_version: contentVersion,
      created_at: now,
      producer: { type: "import", id: reviewerActorId },
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
      reviewer_actor_id: reviewerActorId,
      reviewer_run_id: reviewerRunId,
      reviewed_contract_sha256: parsedPackage.contract_sha256,
      reviewed_diff_sha256: parsedPackage.implementation_diff_sha256,
      reviewed_git_fingerprint: parsedPackage.git_fingerprint,
      summary: raw.summary ?? "Imported review report",
      findings,
      resolved_findings: resolvedFindings
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
      schemaVersion: 2,
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
    addArtifactDependency(runtime.db, {
      artifactId,
      dependsOnArtifactId: reviewPackage.artifactId,
      dependencyKind: "parent"
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
    for (const resolution of report.resolved_findings) {
      createFindingDisposition(runtime.db, {
        dispositionId: newId("disp"),
        findingId: resolution.finding_id,
        sessionId: session.sessionId,
        disposition: "resolve",
        actorId: reviewerActorId,
        reason: `Fresh independent review ${reviewerRunId} verified resolution`,
        resolutionEvidence: resolution.resolution_evidence.map((evidence) => JSON.stringify(evidence)),
        createdAt: now
      });
      updateFindingStatus(runtime.db, { findingId: resolution.finding_id, status: "resolved", now });
    }
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "review.imported",
      actorType: "user",
      actorId: reviewerActorId,
      occurredAt: now,
      summary: "Review report imported",
      metadata: {
        reviewReportArtifactId: artifactId,
        findingIds: report.findings.map((finding) => finding.finding_id),
        resolvedFindingIds: report.resolved_findings.map((finding) => finding.finding_id),
        reviewerActorId,
        reviewerRunId,
        gitFingerprint: git?.fingerprint
      }
    });

    const remainingOpenFindings = listFindingsForSession(runtime.db, session.sessionId).filter(
      (finding) => finding.status === "open" || finding.status === "reopened"
    );
    return {
      sessionId: session.sessionId,
      reviewReportArtifactId: artifactId,
      findingIds: report.findings.map((finding) => finding.finding_id),
      state: next,
      nextCommand: remainingOpenFindings.length > 0
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
