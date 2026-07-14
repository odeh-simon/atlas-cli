import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { invokeClaudeCode } from "@atlas/adapters-claude-code";
import { invokeCodex } from "@atlas/adapters-codex";
import { StateTransitionError } from "@atlas/domain";
import { appendEvent, createArtifactRecord, listArtifactsForSession, listSessionsForRepository, updateSessionState } from "@atlas/persistence";
import { executionReportSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export type ImplementationAgentProvider = "codex" | "claude";

export interface InvokeImplementationAgentInput extends RuntimeOptions {
  readonly provider: ImplementationAgentProvider;
  readonly command?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface InvokeImplementationAgentResult {
  readonly sessionId: string;
  readonly provider: "codex" | "claude-code";
  readonly packageArtifactId: string;
  readonly executionReportArtifactId: string;
  readonly processStatus: string;
  readonly state: string;
  readonly nextCommand: string;
}

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

    const packagePath = join(runtime.paths.artifactRoot, ...implementationPackage.storageUri.split("/"));
    const instructions = readFileSync(packagePath, "utf8");
    const mode = instructions.includes("Mode: fix") ? "fix" : "implement";
    const invocationPackage = {
      mode,
      instructions,
      artifactIds: [implementationPackage.artifactId],
      cwd: runtime.paths.cwd
    } as const;

    const invocation =
      input.provider === "claude"
        ? await invokeClaudeCode({ command: input.command, package: invocationPackage, timeoutMs: input.timeoutMs })
        : await invokeCodex({ command: input.command, package: invocationPackage, timeoutMs: input.timeoutMs });

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const report = executionReportSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "execution_report",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "execution_report").length + 1,
      created_at: now,
      producer: { type: "agent", id: invocation.provider },
      sensitivity: "confidential",
      parents: [implementationPackage.artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        provider: invocation.provider,
        command: invocation.process.command,
        exitCode: invocation.process.exitCode
      },
      run_id: newId("run"),
      process_status: invocation.process.status,
      agent_claims_complete: false,
      changed_files: [],
      limitations: limitationsForProcess(invocation.process.status, invocation.process.stderr)
    });
    const next = transition({
      state: session.primaryState,
      command: "import_execution_result",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
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
      schemaVersion: 1,
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
        executionReportArtifactId: artifactId,
        processStatus: invocation.process.status
      }
    });

    return {
      sessionId: session.sessionId,
      provider: invocation.provider,
      packageArtifactId: implementationPackage.artifactId,
      executionReportArtifactId: artifactId,
      processStatus: invocation.process.status,
      state: next,
      nextCommand: "atlas checks run"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function limitationsForProcess(status: string, stderr: string): string[] {
  if (status === "succeeded") return [];
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(0);
  return [detail === undefined ? `Agent process ended with status ${status}` : detail.slice(0, 500)];
}
