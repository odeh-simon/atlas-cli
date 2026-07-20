import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError, ValidationError } from "@atlas/domain";
import { appendEvent, createArtifactRecord, listSessionsForRepository, updateSessionState } from "@atlas/persistence";
import { executionReportSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ImportExecutionResultInput extends RuntimeOptions {
  readonly filePath: string;
}

export interface ImportExecutionResultResult {
  readonly sessionId: string;
  readonly executionReportArtifactId: string;
  readonly state: string;
  readonly processStatus: string;
  readonly nextCommand: string;
}

export async function importExecutionResult(input: ImportExecutionResultInput): Promise<ImportExecutionResultResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for execution import");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const git = readWorkflowGitSnapshot(runtime.paths.cwd);
    const raw = JSON.parse(readFileSync(input.filePath, "utf8")) as Record<string, unknown>;
    const report = executionReportSchema.parse({
      ...raw,
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "execution_report",
      schema_version: 1,
      content_version: 1,
      created_at: now,
      producer: { type: "import" },
      sensitivity: "confidential",
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
      run_id: raw.run_id ?? newId("run")
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
      contentVersion: 1,
      mediaType: "application/json",
      content: `${JSON.stringify(report, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "execution_report",
      schemaVersion: 1,
      contentVersion: 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "import",
      createdAt: now
    });
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "execution.imported",
      actorType: "user",
      occurredAt: now,
      summary: "Simulated execution result imported",
      metadata: {
        executionReportArtifactId: artifactId,
        processStatus: report.process_status,
        agentClaimsComplete: report.agent_claims_complete,
        gitFingerprint: git?.fingerprint
      }
    });

    return {
      sessionId: session.sessionId,
      executionReportArtifactId: artifactId,
      state: next,
      processStatus: report.process_status,
      nextCommand: "atlas checks run"
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError("Execution result must be valid JSON", undefined, error);
    }
    throw error;
  } finally {
    closeAtlasRuntime(runtime);
  }
}
