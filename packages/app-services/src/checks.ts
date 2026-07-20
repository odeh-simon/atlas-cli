import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Bytes, writeImmutableArtifactContent } from "@atlas/artifacts";
import { runCheckSet, type CheckDefinition, type CheckExecutionResult } from "@atlas/checks";
import { GateFailedError, StateTransitionError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@atlas/persistence";
import { checkResultSchema, checkRunLogSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface RunBasicCheckResult {
  readonly sessionId: string;
  readonly checkResultArtifactId: string;
  readonly status: "passed" | "failed";
  readonly checkCount: number;
  readonly state: string;
  readonly nextCommand: string;
}

export async function runBasicCheck(options: RuntimeOptions = {}): Promise<RunBasicCheckResult> {
  const runtime = await openAtlasRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for checks");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const git = readWorkflowGitSnapshot(runtime.paths.cwd);
    const configuredChecks = readConfiguredChecks(runtime.paths.cwd);
    const checkSet = await runCheckSet({
      cwd: runtime.paths.cwd,
      env: options.env,
      changedFiles: git?.changed_files.map((file) => file.path),
      checks: [{ name: "basic-session-integrity", required: true }, ...configuredChecks],
      builtIns: [
        {
          name: "basic-session-integrity",
          run: () => runBasicSessionIntegrityCheck(runtime.paths.artifactRoot, artifacts)
        }
      ]
    });

    const status = checkSet.status;
    const failures = checkSet.results
      .filter((result) => result.required && result.status !== "passed" && result.status !== "skipped")
      .map((result) => `${result.name}: ${result.summary}`);
    const now = new Date().toISOString();
    const runLogArtifactId = newId("art");
    const runLog = checkRunLogSchema.parse({
      artifact_id: runLogArtifactId,
      session_id: session.sessionId,
      type: "check_run_log",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "check_run_log").length + 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "internal",
      parents: [],
      content_sha256: "0".repeat(64),
      metadata: {
        ...(git === undefined
          ? {}
          : {
              git,
              git_fingerprint: git.fingerprint
            })
      },
      run_id: checkSet.runId,
      status: checkSet.status,
      failed_required: checkSet.failedRequired,
      results: checkSet.results.map((result) => ({
        name: result.name,
        required: result.required,
        status: result.status,
        summary: result.summary,
        dependencies: result.dependencies,
        affected: result.affected,
        ...(result.skippedReason === undefined ? {} : { skipped_reason: result.skippedReason }),
        process: result.process
          ? {
              run_id: result.process.runId,
              command: result.process.command,
              args: [...result.process.args],
              status: result.process.status,
              ...(result.process.exitCode === undefined ? {} : { exit_code: result.process.exitCode }),
              timed_out: result.process.timedOut,
              stdout_truncated: result.process.stdoutTruncated,
              stderr_truncated: result.process.stderrTruncated,
              redacted: result.process.redacted
            }
          : undefined
      }))
    });
    const writtenRunLog = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId: runLogArtifactId,
      type: "check_run_log",
      contentVersion: runLog.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(runLog, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId: runLogArtifactId,
      sessionId: session.sessionId,
      type: "check_run_log",
      schemaVersion: 1,
      contentVersion: runLog.content_version,
      storageUri: writtenRunLog.storageUri,
      sha256: writtenRunLog.sha256,
      byteLength: writtenRunLog.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: status === "passed" ? "valid" : "rejected",
      producerType: "atlas",
      createdAt: now
    });

    const artifactId = newId("art");
    const checkResult = checkResultSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "check_result",
      schema_version: 1,
      content_version: 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "internal",
      parents: [runLogArtifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        run_id: checkSet.runId,
        check_run_log_artifact_id: runLogArtifactId,
        check_count: checkSet.results.length,
        failed_required: checkSet.failedRequired,
        ...(git === undefined
          ? {}
          : {
              git,
              git_fingerprint: git.fingerprint
            }),
        results: checkSet.results.map((result) => ({
          name: result.name,
          required: result.required,
          status: result.status,
          summary: result.summary,
          dependencies: result.dependencies,
          affected: result.affected,
          skippedReason: result.skippedReason,
          process: result.process
            ? {
                runId: result.process.runId,
                command: result.process.command,
                args: result.process.args,
                status: result.process.status,
                exitCode: result.process.exitCode,
                timedOut: result.process.timedOut,
                stdoutTruncated: result.process.stdoutTruncated,
                stderrTruncated: result.process.stderrTruncated,
                redacted: result.process.redacted
              }
            : undefined
        }))
      },
      check_name: "full-check-set",
      status,
      required: true,
      summary: status === "passed" ? "All required checks passed" : failures.join("; "),
      ...(git === undefined ? {} : { git_fingerprint: git.fingerprint })
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "check_result",
      contentVersion: artifacts.filter((artifact) => artifact.type === "check_result").length + 1,
      mediaType: "application/json",
      content: `${JSON.stringify(checkResult, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "check_result",
      schemaVersion: 1,
      contentVersion: artifacts.filter((artifact) => artifact.type === "check_result").length + 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: status === "passed" ? "valid" : "rejected",
      producerType: "atlas",
      createdAt: now
    });

    if (status === "failed") {
      appendEvent(runtime.db, {
        eventId: newId("evt"),
        sessionId: session.sessionId,
        eventType: "checks.failed",
        actorType: "atlas",
        occurredAt: now,
        summary: "Required checks failed",
        metadata: {
          checkResultArtifactId: artifactId,
          checkRunLogArtifactId: runLogArtifactId,
          failures,
          gitFingerprint: git?.fingerprint
        }
      });
      throw new GateFailedError("Required check failed", { failures, checkResultArtifactId: artifactId });
    }

    const next = transition({
      state: session.primaryState,
      command: "run_basic_check",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "checks.passed",
      actorType: "atlas",
      occurredAt: now,
      summary: "Required checks passed",
      metadata: {
        checkResultArtifactId: artifactId,
        checkRunLogArtifactId: runLogArtifactId,
        runId: checkSet.runId,
        checkCount: checkSet.results.length,
        gitFingerprint: git?.fingerprint
      }
    });

    return {
      sessionId: session.sessionId,
      checkResultArtifactId: artifactId,
      status,
      checkCount: checkSet.results.length,
      state: next,
      nextCommand: "atlas review prepare"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function runBasicSessionIntegrityCheck(artifactRoot: string, artifacts: ReturnType<typeof listArtifactsForSession>): CheckExecutionResult {
  const failures: string[] = [];
  if (!artifacts.some((artifact) => artifact.type === "implementation_contract" && artifact.status === "approved")) {
    failures.push("approved contract missing");
  }
  if (!artifacts.some((artifact) => artifact.type === "execution_report")) {
    failures.push("execution report missing");
  }
  for (const artifact of artifacts) {
    const bytes = readFileSync(join(artifactRoot, artifact.storageUri));
    if (sha256Bytes(bytes) !== artifact.sha256) {
      failures.push(`artifact hash mismatch: ${artifact.artifactId}`);
    }
    const text = bytes.toString("utf8");
    if (/SECRET_FIXTURE|BEGIN PRIVATE KEY|AKIA[0-9A-Z]{16}/.test(text)) {
      failures.push(`secret-like content detected: ${artifact.artifactId}`);
    }
  }
  return {
    status: failures.length === 0 ? "passed" : "failed",
    summary: failures.length === 0 ? "Basic session integrity passed" : failures.join("; ")
  };
}

function readConfiguredChecks(cwd: string): CheckDefinition[] {
  try {
    const raw = JSON.parse(readFileSync(join(cwd, "atlas.config.json"), "utf8")) as { checks?: unknown };
    if (!Array.isArray(raw.checks)) return [];
    return raw.checks.map((value): CheckDefinition => {
      if (typeof value !== "object" || value === null) {
        throw new TypeError("Check config entries must be objects");
      }
      const record = value as Record<string, unknown>;
      if (typeof record.name !== "string" || record.name.length === 0) {
        throw new TypeError("Check config entry requires name");
      }
      if (record.kind !== "design-scan" && (typeof record.command !== "string" || record.command.length === 0)) {
        throw new TypeError(`Check config entry requires command: ${record.name}`);
      }
      const definition: CheckDefinition = {
        name: record.name,
        required: record.required !== false,
        ...(record.kind === "command" || record.kind === "design-scan" ? { kind: record.kind } : {}),
        ...(typeof record.command === "string" ? { command: record.command } : {}),
        args: Array.isArray(record.args) ? record.args.map(String) : [],
        dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn.map(String) : [],
        affected: Array.isArray(record.affected) ? record.affected.map(String) : [],
        ...(typeof record.root === "string" ? { root: record.root } : {}),
        ...(typeof record.maxFiles === "number" ? { maxFiles: record.maxFiles } : {})
      };
      if (typeof record.timeoutMs === "number") {
        return { ...definition, timeoutMs: record.timeoutMs };
      }
      return definition;
    });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
