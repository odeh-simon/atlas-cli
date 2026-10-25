import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { invokeClaudeCode } from "@atlas/adapters-claude-code";
import { invokeCodex } from "@atlas/adapters-codex";
import { StateTransitionError } from "@atlas/domain";
import { addArtifactDependency, appendEvent, createArtifactRecord, listArtifactsForSession, listSessionsForRepository, updateSessionState } from "@atlas/persistence";
import { type ProcessRunResult } from "@atlas/process-runner";
import { agentRunLogSchema, executionReportSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot, type WorkflowGitChangedFile, type WorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";
import { captureImplementationDiff } from "./implementation-diff.js";
import { assertImplementationGitBase, readAndValidateImplementationPackage } from "./implementation-bindings.js";

export type ImplementationAgentProvider = "codex" | "claude";

export interface InvokeImplementationAgentInput extends RuntimeOptions {
  readonly provider: ImplementationAgentProvider;
  readonly command?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly agentInvoker?: AgentInvoker | undefined;
}

export interface InvokeImplementationAgentResult {
  readonly sessionId: string;
  readonly provider: "codex" | "claude-code";
  readonly packageArtifactId: string;
  readonly agentRunLogArtifactId: string;
  readonly executionReportArtifactId: string;
  readonly implementationDiffArtifactId: string;
  readonly processStatus: string;
  readonly agentClaimsComplete: boolean;
  readonly changedFiles: readonly string[];
  readonly state: string;
  readonly nextCommand: string;
}

export interface AgentInvokerInput {
  readonly provider: ImplementationAgentProvider;
  readonly command?: string | undefined;
  readonly package: {
    readonly mode: "implement" | "fix";
    readonly instructions: string;
    readonly artifactIds: readonly string[];
    readonly cwd: string;
  };
  readonly timeoutMs?: number | undefined;
}

export interface AgentInvocation {
  readonly provider: "codex" | "claude-code";
  readonly process: ProcessRunResult;
}

export type AgentInvoker = (input: AgentInvokerInput) => Promise<AgentInvocation>;

export async function invokeImplementationAgent(
  input: InvokeImplementationAgentInput
): Promise<InvokeImplementationAgentResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for agent invocation");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const implementationPackage = artifacts
      .filter((artifact) => artifact.type === "agent_implementation_package" && artifact.status === "valid")
      .at(-1);
    if (implementationPackage === undefined) {
      throw new StateTransitionError("Agent invocation requires an exported implementation package");
    }

    const parsedPackage = readAndValidateImplementationPackage({ runtime, session, artifacts, implementationPackage });
    const instructions = parsedPackage.instructions_markdown;
    const mode = parsedPackage.mode;
    const gitBefore = assertImplementationGitBase({
      package: parsedPackage,
      git: readWorkflowGitSnapshot(runtime.paths.cwd),
      requireClean: true
    });
    const next = transition({
      state: session.primaryState,
      command: "import_execution_result",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const invocationPackage = {
      mode,
      instructions,
      artifactIds: [implementationPackage.artifactId],
      cwd: runtime.paths.cwd
    } as const;

    const invocation =
      input.agentInvoker === undefined
        ? input.provider === "claude"
          ? await invokeClaudeCode({ command: input.command, package: invocationPackage, timeoutMs: input.timeoutMs })
          : await invokeCodex({ command: input.command, package: invocationPackage, timeoutMs: input.timeoutMs })
        : await input.agentInvoker({
            provider: input.provider,
            command: input.command,
            package: invocationPackage,
            timeoutMs: input.timeoutMs
          });
    const gitAfter = readWorkflowGitSnapshot(runtime.paths.cwd);
    const parsedCompletionReport = parseAgentCompletionReport(invocation.process.stdout, invocation.process.stderr);
    const changedFiles = changedFilesIntroduced(gitBefore, gitAfter);

    const now = new Date().toISOString();
    const runLogArtifactId = newId("art");
    const runLog = agentRunLogSchema.parse({
      artifact_id: runLogArtifactId,
      session_id: session.sessionId,
      type: "agent_run_log",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "agent_run_log").length + 1,
      created_at: now,
      producer: { type: "agent", id: invocation.provider },
      sensitivity: "confidential",
      parents: [implementationPackage.artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        provider: invocation.provider,
        command: invocation.process.command,
        processStatus: invocation.process.status,
        gitBeforeFingerprint: gitBefore?.fingerprint,
        gitAfterFingerprint: gitAfter?.fingerprint
      },
      provider: invocation.provider,
      run_id: invocation.process.runId,
      package_artifact_id: implementationPackage.artifactId,
      process: processForArtifact(invocation.process),
      ...(gitBefore === undefined ? {} : { git_before: gitSnapshotForArtifact(gitBefore) }),
      ...(gitAfter === undefined ? {} : { git_after: gitSnapshotForArtifact(gitAfter) }),
      ...(parsedCompletionReport.present ? { parsed_completion_report: parsedCompletionReportForArtifact(parsedCompletionReport) } : {})
    });
    const writtenRunLog = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId: runLogArtifactId,
      type: "agent_run_log",
      contentVersion: runLog.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(runLog, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId: runLogArtifactId,
      sessionId: session.sessionId,
      type: "agent_run_log",
      schemaVersion: 1,
      contentVersion: runLog.content_version,
      storageUri: writtenRunLog.storageUri,
      sha256: writtenRunLog.sha256,
      byteLength: writtenRunLog.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "agent",
      createdAt: now
    });
    const diffRecord = captureImplementationDiff({
      runtime,
      sessionId: session.sessionId,
      runId: invocation.process.runId,
      before: gitBefore,
      after: gitAfter,
      parentArtifactIds: [implementationPackage.artifactId, runLogArtifactId],
      contentVersion: artifacts.filter((artifact) => artifact.type === "implementation_diff").length + 1,
      now,
      requireCleanBase: true
    });

    const artifactId = newId("art");
    const report = executionReportSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "execution_report",
      schema_version: 2,
      content_version: artifacts.filter((artifact) => artifact.type === "execution_report").length + 1,
      created_at: now,
      producer: { type: "agent", id: invocation.provider },
      sensitivity: "confidential",
      parents: [implementationPackage.artifactId, runLogArtifactId, diffRecord.artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        provider: invocation.provider,
        command: invocation.process.command,
        exitCode: invocation.process.exitCode,
        agentRunLogArtifactId: runLogArtifactId,
        gitBeforeFingerprint: gitBefore?.fingerprint,
        gitAfterFingerprint: gitAfter?.fingerprint,
        gitBeforeHead: gitBefore?.head_sha,
        gitAfterHead: gitAfter?.head_sha
      },
      run_id: invocation.process.runId,
      implementation_actor_id: invocation.provider,
      implementation_diff_artifact_id: diffRecord.artifactId,
      implementation_diff_sha256: diffRecord.sha256,
      implementation_package_artifact_id: implementationPackage.artifactId,
      implementation_package_sha256: implementationPackage.sha256,
      contract_artifact_id: parsedPackage.contract_artifact_id,
      contract_sha256: parsedPackage.contract_sha256,
      context_content_pack_artifact_id: parsedPackage.context_content_pack_artifact_id,
      context_content_pack_sha256: parsedPackage.context_content_pack_sha256,
      process_status: invocation.process.status,
      agent_claims_complete: parsedCompletionReport.agentClaimsComplete,
      changed_files: changedFiles,
      limitations: limitationsForProcess(invocation.process.status, invocation.process.stderr, parsedCompletionReport.limitations)
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "execution_report",
      contentVersion: report.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(report, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "execution_report",
      schemaVersion: 2,
      contentVersion: report.content_version,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "agent",
      createdAt: now
    });
    for (const dependsOnArtifactId of report.parents) {
      addArtifactDependency(runtime.db, { artifactId, dependsOnArtifactId, dependencyKind: "parent" });
    }
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "agent.invoked",
      actorType: "agent",
      actorId: invocation.provider,
      occurredAt: now,
      summary: "Implementation agent invocation recorded",
      metadata: {
        provider: invocation.provider,
        packageArtifactId: implementationPackage.artifactId,
        agentRunLogArtifactId: runLogArtifactId,
        executionReportArtifactId: artifactId,
        implementationDiffArtifactId: diffRecord.artifactId,
        runId: invocation.process.runId,
        processStatus: invocation.process.status,
        agentClaimsComplete: report.agent_claims_complete,
        changedFiles: report.changed_files,
        gitBeforeFingerprint: gitBefore?.fingerprint,
        gitAfterFingerprint: gitAfter?.fingerprint
      }
    });

    return {
      sessionId: session.sessionId,
      provider: invocation.provider,
      packageArtifactId: implementationPackage.artifactId,
      agentRunLogArtifactId: runLogArtifactId,
      executionReportArtifactId: artifactId,
      implementationDiffArtifactId: diffRecord.artifactId,
      processStatus: invocation.process.status,
      agentClaimsComplete: report.agent_claims_complete ?? false,
      changedFiles: report.changed_files,
      state: next,
      nextCommand: "atlas checks run"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function limitationsForProcess(status: string, stderr: string, parsedLimitations: readonly string[]): string[] {
  if (parsedLimitations.length > 0) return [...parsedLimitations];
  if (status === "succeeded") return [];
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(0);
  return [detail === undefined ? `Agent process ended with status ${status}` : detail.slice(0, 500)];
}

function processForArtifact(process: ProcessRunResult) {
  return {
    command: process.command,
    args: [...process.args],
    ...(process.cwd === undefined ? {} : { cwd: process.cwd }),
    status: process.status,
    ...(process.exitCode === undefined ? {} : { exit_code: process.exitCode }),
    ...(process.signal === undefined ? {} : { signal: process.signal }),
    started_at: process.startedAt,
    ended_at: process.endedAt,
    duration_ms: process.durationMs,
    stdout: process.stdout,
    stderr: process.stderr,
    stdout_truncated: process.stdoutTruncated,
    stderr_truncated: process.stderrTruncated,
    redacted: process.redacted
  };
}

function gitSnapshotForArtifact(snapshot: WorkflowGitSnapshot) {
  return snapshot;
}

interface ParsedAgentCompletionReport {
  readonly present: boolean;
  readonly agentClaimsComplete: boolean;
  readonly changedFiles: readonly string[];
  readonly limitations: readonly string[];
}

function parseAgentCompletionReport(stdout: string, stderr: string): ParsedAgentCompletionReport {
  const marker = "ATLAS_EXECUTION_REPORT_JSON:";
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(marker));
  if (line === undefined) {
    return { present: false, agentClaimsComplete: false, changedFiles: [], limitations: [] };
  }

  try {
    const parsed = JSON.parse(line.slice(marker.length).trim()) as {
      agent_claims_complete?: unknown;
      changed_files?: unknown;
      limitations?: unknown;
    };
    const changedFiles = Array.isArray(parsed.changed_files)
      ? parsed.changed_files.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const limitations = Array.isArray(parsed.limitations)
      ? parsed.limitations.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    return {
      present: true,
      agentClaimsComplete: parsed.agent_claims_complete === true,
      changedFiles,
      limitations
    };
  } catch {
    return {
      present: true,
      agentClaimsComplete: false,
      changedFiles: [],
      limitations: ["Agent emitted malformed ATLAS_EXECUTION_REPORT_JSON"]
    };
  }
}

function parsedCompletionReportForArtifact(report: ParsedAgentCompletionReport) {
  return {
    agent_claims_complete: report.agentClaimsComplete,
    changed_files: [...report.changedFiles],
    limitations: [...report.limitations]
  };
}

function changedFilesIntroduced(before: WorkflowGitSnapshot | undefined, after: WorkflowGitSnapshot | undefined): string[] {
  if (after === undefined) return [];
  if (before === undefined) return after.changed_files.map((entry) => entry.path);
  const beforeEntries = new Map(before.changed_files.map((entry) => [entry.path, statusSignature(entry)]));
  return after.changed_files
    .filter((entry) => beforeEntries.get(entry.path) !== statusSignature(entry))
    .map((entry) => entry.path);
}

function statusSignature(entry: WorkflowGitChangedFile): string {
  return `${entry.index}${entry.working_tree}:${entry.original_path ?? ""}`;
}
