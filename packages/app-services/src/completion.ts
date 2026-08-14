import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GateFailedError, StateTransitionError } from "@atlas/domain";
import { writeImmutableArtifactContent } from "@atlas/artifacts";
import {
  appendEvent,
  createApproval,
  createArtifactRecord,
  listArtifactsForSession,
  listFindingsForSession,
  listSessionsForRepository,
  updateSessionState,
  type ArtifactRecord,
  type FindingRecord,
  type SessionRecord
} from "@atlas/persistence";
import { completionReportSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { hasStaleGitFingerprint, readWorkflowGitSnapshot, type WorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";
import { visualCheckConfigFingerprint } from "./visual-gates.js";

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
  const runtime = await openAtlasRuntime(options);
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
      actorType: "atlas",
      occurredAt: now,
      summary: "Completion gates passed",
      metadata: {
        contractArtifactId: gates.contractArtifact.artifactId,
        checkResultArtifactIds: gates.checkResultArtifacts.map((artifact) => artifact.artifactId)
      }
    });

    return { sessionId: session.sessionId, state: next, nextCommand: "atlas approve completion --yes" };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

export async function approveCompletion(input: ApproveCompletionInput = {}): Promise<ApproveCompletionResult> {
  const runtime = await openAtlasRuntime(input);
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
      schema_version: 1,
      content_version: 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [
        gates.contractArtifact.artifactId,
        ...gates.checkResultArtifacts.map((artifact) => artifact.artifactId)
      ],
      content_sha256: "0".repeat(64),
      metadata: {},
      contract_artifact_id: gates.contractArtifact.artifactId,
      contract_sha256: gates.contractArtifact.sha256,
      check_result_artifact_ids: gates.checkResultArtifacts.map((artifact) => artifact.artifactId),
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
      schemaVersion: 1,
      contentVersion: artifacts.filter((artifact) => artifact.type === "completion_report").length + 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "approved",
      producerType: "atlas",
      createdAt: now,
      approvedAt: now
    });
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
    closeAtlasRuntime(runtime);
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
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  const contractArtifact = artifacts.find(
    (artifact) => artifact.type === "implementation_contract" && artifact.status === "approved"
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

  const unresolvedBlockingFindings = findings.filter(
    (finding) => finding.severity === "blocking" && (finding.status === "open" || finding.status === "reopened")
  );
  if (unresolvedBlockingFindings.length > 0) {
    failures.push(`unresolved blocking findings: ${unresolvedBlockingFindings.map((finding) => finding.findingId).join(", ")}`);
  }

  if (contractArtifact === undefined || failures.length > 0) {
    throw new GateFailedError("Completion gates failed", { failures });
  }

  return {
    contractArtifact,
    checkResultArtifacts,
    unresolvedBlockingFindings,
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
      failures.push("context manifest is stale against current Git HEAD; rerun atlas context build");
    }

    const checkFingerprint = latestCheck === undefined ? undefined : readArtifactGitFingerprint(input.artifactRoot, latestCheck);
    if (hasStaleGitFingerprint({ recorded: checkFingerprint, current: input.currentGit.fingerprint })) {
      failures.push("check result is stale against current Git state; rerun atlas checks run");
    }
  }

  const recordedVisualFingerprint =
    latestCheck === undefined ? undefined : readArtifactVisualFingerprint(input.artifactRoot, latestCheck);
  try {
    const currentVisualFingerprint = visualCheckConfigFingerprint(input.cwd);
    if (recordedVisualFingerprint !== currentVisualFingerprint) {
      failures.push("visual check configuration or local baseline is stale; rerun atlas checks run");
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
