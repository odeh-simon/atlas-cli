import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GateFailedError, StateTransitionError } from "@sigil/domain";
import { writeImmutableArtifactContent } from "@sigil/artifacts";
import {
  appendEvent,
  addArtifactDependency,
  createApproval,
  createArtifactRecord,
  listArtifactsForSession,
  listFindingsForSession,
  listSessionsForRepository,
  updateSessionState,
  type ArtifactRecord,
  type FindingRecord,
  type SessionRecord
} from "@sigil/persistence";
import { completionReportSchema } from "@sigil/schemas";
import { implementationDiffSchema, reviewPackageSchema, reviewReportSchema } from "@sigil/schemas";
import { transition } from "@sigil/workflow-engine";

import { hasStaleGitFingerprint, readWorkflowGitSnapshot, type WorkflowGitSnapshot } from "./git-safeguards.js";
import { closeSigilRuntime, newId, openSigilRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";
import { visualCheckConfigFingerprint } from "./visual-gates.js";
import { readVerifiedArtifactText } from "./evidence.js";

export interface EvaluateCompletionResult {
  readonly sessionId: string;
  readonly state: string;
  readonly nextCommand: string;
}

export interface ApproveCompletionInput extends RuntimeOptions {
  readonly actorId?: string | undefined;
  readonly rationale?: string | undefined;
}

export interface ApproveCompletionResult {
  readonly sessionId: string;
  readonly completionReportArtifactId: string;
  readonly approvalId: string;
  readonly state: string;
}

export async function evaluateCompletion(options: RuntimeOptions = {}): Promise<EvaluateCompletionResult> {
  const runtime = await openSigilRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for completion evaluation");
    }

    const gates = assertCompletionGates(
      session,
      listArtifactsForSession(runtime.db, session.sessionId),
      listFindingsForSession(runtime.db, session.sessionId),
      runtime.paths.artifactRoot,
      readWorkflowGitSnapshot(runtime.paths.cwd),
      runtime.paths.cwd
    );

    const now = new Date().toISOString();
    const next = transition({
      state: session.primaryState,
      command: "evaluate_completion",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "completion.evaluated",
      actorType: "sigil",
      occurredAt: now,
      summary: "Completion gates passed",
      metadata: {
        contractArtifactId: gates.contractArtifact.artifactId,
        checkResultArtifactIds: gates.checkResultArtifacts.map((artifact) => artifact.artifactId)
      }
    });

    return { sessionId: session.sessionId, state: next, nextCommand: "sigil approve completion --yes" };
  } finally {
    closeSigilRuntime(runtime);
  }
}

export async function approveCompletion(input: ApproveCompletionInput = {}): Promise<ApproveCompletionResult> {
  const runtime = await openSigilRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for completion approval");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const gates = assertCompletionGates(
      session,
      artifacts,
      listFindingsForSession(runtime.db, session.sessionId),
      runtime.paths.artifactRoot,
      readWorkflowGitSnapshot(runtime.paths.cwd),
      runtime.paths.cwd
    );

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const actorId = input.actorId ?? "local-user";
    const completionReport = completionReportSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "completion_report",
      schema_version: 2,
      content_version: 1,
      created_at: now,
      producer: { type: "sigil" },
      sensitivity: "confidential",
      parents: [
        gates.contractArtifact.artifactId,
        ...gates.checkResultArtifacts.map((artifact) => artifact.artifactId),
        gates.reviewReportArtifact.artifactId,
        gates.implementationDiffArtifact.artifactId
      ],
      content_sha256: "0".repeat(64),
      metadata: {},
      contract_artifact_id: gates.contractArtifact.artifactId,
      contract_sha256: gates.contractArtifact.sha256,
      check_result_artifact_ids: gates.checkResultArtifacts.map((artifact) => artifact.artifactId),
      review_report_artifact_id: gates.reviewReportArtifact.artifactId,
      implementation_diff_artifact_id: gates.implementationDiffArtifact.artifactId,
      unresolved_blocking_findings: gates.unresolvedBlockingFindings.map((finding) => finding.findingId),
      approved_by: actorId,
      approved_at: now,
      completion_gate_status: "passed"
    });
    const content = `${JSON.stringify(completionReport, null, 2)}\n`;
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "completion_report",
      contentVersion: artifacts.filter((artifact) => artifact.type === "completion_report").length + 1,
      mediaType: "application/json",
      content
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "completion_report",
      schemaVersion: 2,
      contentVersion: artifacts.filter((artifact) => artifact.type === "completion_report").length + 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "approved",
      producerType: "sigil",
      createdAt: now,
      approvedAt: now
    });
    for (const dependsOnArtifactId of completionReport.parents) {
      addArtifactDependency(runtime.db, { artifactId, dependsOnArtifactId, dependencyKind: "evidence" });
    }
    const approval = createApproval(runtime.db, {
      approvalId: newId("appr"),
      sessionId: session.sessionId,
      artifactId,
      approvalType: "completion",
      artifactSha256: written.sha256,
      actorId,
      rationale: input.rationale,
      createdAt: now
    });
    const next = transition({
      state: session.primaryState,
      command: "approve_completion",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "completion.approved",
      actorType: "user",
      actorId,
      occurredAt: now,
      summary: "Completion approved",
      metadata: { completionReportArtifactId: artifactId, approvalId: approval.approvalId }
    });

    return {
      sessionId: session.sessionId,
      completionReportArtifactId: artifactId,
      approvalId: approval.approvalId,
      state: next
    };
  } finally {
    closeSigilRuntime(runtime);
  }
}

function assertCompletionGates(
  session: SessionRecord,
  artifacts: readonly ArtifactRecord[],
  findings: readonly FindingRecord[],
  artifactRoot: string,
  currentGit: WorkflowGitSnapshot | undefined,
  cwd: string
): {
  readonly contractArtifact: ArtifactRecord;
  readonly checkResultArtifacts: readonly ArtifactRecord[];
  readonly unresolvedBlockingFindings: readonly FindingRecord[];
  readonly reviewReportArtifact: ArtifactRecord;
  readonly implementationDiffArtifact: ArtifactRecord;
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  const contractArtifact = artifacts.find(
    (artifact) => artifact.artifactId === session.currentContractArtifactId && artifact.type === "implementation_contract" && artifact.status === "approved"
  );
  if (contractArtifact === undefined) {
    failures.push("approved contract missing");
  }

  const latestCheckResult = artifacts.filter((artifact) => artifact.type === "check_result").at(-1);
  const checkResultArtifacts = latestCheckResult?.status === "valid" ? [latestCheckResult] : [];
  if (checkResultArtifacts.length === 0) {
    failures.push(
      latestCheckResult === undefined ? "passing required check result missing" : "latest required check result is not passing"
    );
  }
  failures.push(...gitFreshnessFailures({ session, artifacts, checkResultArtifacts, artifactRoot, currentGit, cwd }));

  const reviewReportArtifact = artifacts.filter((artifact) => artifact.type === "review_report" && artifact.status === "valid").at(-1);
  let implementationDiffArtifact: ArtifactRecord | undefined;
  if (reviewReportArtifact === undefined) {
    failures.push("fresh independent review report missing; run sigil review prepare/import");
  } else if (contractArtifact !== undefined) {
    try {
      const review = reviewReportSchema.parse(JSON.parse(readVerifiedArtifactText(artifactRoot, reviewReportArtifact)) as unknown);
      const reviewPackageArtifact = artifacts.find((artifact) => artifact.artifactId === review.review_package_artifact_id && artifact.status === "valid");
      if (reviewPackageArtifact === undefined || reviewPackageArtifact.sha256 !== review.review_package_sha256) {
        failures.push("review report package binding is invalid");
      } else {
        const reviewPackage = reviewPackageSchema.parse(JSON.parse(readVerifiedArtifactText(artifactRoot, reviewPackageArtifact)) as unknown);
        implementationDiffArtifact = artifacts.find(
          (artifact) => artifact.artifactId === reviewPackage.implementation_diff_artifact_id && artifact.type === "implementation_diff" && artifact.status === "valid"
        );
        if (
          review.reviewer_actor_id === undefined ||
          review.reviewer_run_id === undefined ||
          review.reviewed_contract_sha256 !== contractArtifact.sha256 ||
          review.reviewed_diff_sha256 !== implementationDiffArtifact?.sha256 ||
          review.reviewed_git_fingerprint !== currentGit?.fingerprint ||
          reviewPackage.contract_artifact_id !== contractArtifact.artifactId ||
          reviewPackage.contract_sha256 !== contractArtifact.sha256 ||
          reviewPackage.implementation_actor_id === undefined ||
          reviewPackage.implementation_run_id === undefined ||
          review.reviewer_actor_id === reviewPackage.implementation_actor_id ||
          review.reviewer_run_id === reviewPackage.implementation_run_id ||
          !reviewPackage.check_result_artifact_ids.includes(latestCheckResult?.artifactId ?? "")
        ) {
          failures.push("independent review is legacy, stale, self-reviewed, or not bound to the current contract/diff/checks");
        }
        if (implementationDiffArtifact !== undefined) {
          const diff = implementationDiffSchema.parse(JSON.parse(readVerifiedArtifactText(artifactRoot, implementationDiffArtifact)) as unknown);
          if (!diff.reviewable || diff.result_fingerprint !== currentGit?.fingerprint) {
            failures.push("implementation diff is stale or not safely reviewable");
          }
        }
      }
    } catch (error) {
      failures.push(`independent review evidence is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const unresolvedBlockingFindings = findings.filter(
    (finding) => finding.severity === "blocking" && (finding.status === "open" || finding.status === "reopened")
  );
  if (unresolvedBlockingFindings.length > 0) {
    failures.push(`unresolved blocking findings: ${unresolvedBlockingFindings.map((finding) => finding.findingId).join(", ")}`);
  }

  if (contractArtifact === undefined || reviewReportArtifact === undefined || implementationDiffArtifact === undefined || failures.length > 0) {
    throw new GateFailedError("Completion gates failed", { failures });
  }

  return {
    contractArtifact,
    checkResultArtifacts,
    unresolvedBlockingFindings,
    reviewReportArtifact,
    implementationDiffArtifact,
    failures
  };
}

function gitFreshnessFailures(input: {
  readonly session: SessionRecord;
  readonly artifacts: readonly ArtifactRecord[];
  readonly checkResultArtifacts: readonly ArtifactRecord[];
  readonly artifactRoot: string;
  readonly currentGit: WorkflowGitSnapshot | undefined;
  readonly cwd: string;
}): string[] {
  const failures: string[] = [];
  const latestCheck = input.checkResultArtifacts.at(-1);
  if (input.currentGit !== undefined) {
    const context = input.artifacts.find((artifact) => artifact.artifactId === input.session.currentContextArtifactId);
    const contextFingerprint = context === undefined ? undefined : readArtifactGitFingerprint(input.artifactRoot, context);
    if (hasStaleGitFingerprint({ recorded: contextFingerprint, current: input.currentGit.base_fingerprint })) {
      failures.push("context manifest is stale against current Git HEAD; rerun sigil context build");
    }

    const checkFingerprint = latestCheck === undefined ? undefined : readArtifactGitFingerprint(input.artifactRoot, latestCheck);
    if (hasStaleGitFingerprint({ recorded: checkFingerprint, current: input.currentGit.fingerprint })) {
      failures.push("check result is stale against current Git state; rerun sigil checks run");
    }
  }

  const recordedVisualFingerprint =
    latestCheck === undefined ? undefined : readArtifactVisualFingerprint(input.artifactRoot, latestCheck);
  try {
    const currentVisualFingerprint = visualCheckConfigFingerprint(input.cwd);
    if (recordedVisualFingerprint !== currentVisualFingerprint) {
      failures.push("visual check configuration or local baseline is stale; rerun sigil checks run");
    }
  } catch (error) {
    failures.push(`visual check configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  return failures;
}

function readArtifactVisualFingerprint(artifactRoot: string, artifact: ArtifactRecord): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(artifactRoot, artifact.storageUri), "utf8")) as {
      visual_config_fingerprint?: unknown;
      metadata?: { visual_config_fingerprint?: unknown };
    };
    if (typeof raw.visual_config_fingerprint === "string") return raw.visual_config_fingerprint;
    return typeof raw.metadata?.visual_config_fingerprint === "string"
      ? raw.metadata.visual_config_fingerprint
      : undefined;
  } catch {
    return undefined;
  }
}

function readArtifactGitFingerprint(artifactRoot: string, artifact: ArtifactRecord): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(artifactRoot, artifact.storageUri), "utf8")) as {
      git_fingerprint?: unknown;
      metadata?: { git_fingerprint?: unknown };
    };
    if (typeof raw.git_fingerprint === "string") return raw.git_fingerprint;
    return typeof raw.metadata?.git_fingerprint === "string" ? raw.metadata.git_fingerprint : undefined;
  } catch {
    return undefined;
  }
}
