import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@sigil/artifacts";
import { StateTransitionError, ValidationError } from "@sigil/domain";
import { addArtifactDependency, appendEvent, createArtifactRecord, listArtifactsForSession, listSessionsForRepository, updateSessionState } from "@sigil/persistence";
import { executionReportSchema } from "@sigil/schemas";
import { transition } from "@sigil/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { closeSigilRuntime, newId, openSigilRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";
import { captureImplementationDiff } from "./implementation-diff.js";
import { assertImplementationGitBase, readAndValidateImplementationPackage } from "./implementation-bindings.js";

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
  const runtime = await openSigilRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for execution import");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const git = readWorkflowGitSnapshot(runtime.paths.cwd);
    if (git === undefined) {
      throw new StateTransitionError("Execution import requires a Git repository to capture reviewable implementation evidence");
    }
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const implementationPackage = artifacts.filter((artifact) => artifact.type === "agent_implementation_package" && artifact.status === "valid").at(-1);
    if (implementationPackage === undefined) {
      throw new StateTransitionError("Execution import requires the current implementation package");
    }
    const parsedPackage = readAndValidateImplementationPackage({ runtime, session, artifacts, implementationPackage });
    assertImplementationGitBase({ package: parsedPackage, git, requireClean: false });
    const raw = JSON.parse(readFileSync(input.filePath, "utf8")) as Record<string, unknown>;
    const runId = newId("run");
    const cleanBase = {
      ...git,
      fingerprint: parsedPackage.git_snapshot_fingerprint!,
      dirty: false,
      changed_file_count: 0,
      changed_files: [],
      diff_summary: undefined
    };
    const diffRecord = captureImplementationDiff({
      runtime,
      sessionId: session.sessionId,
      runId,
      before: cleanBase,
      after: git,
      parentArtifactIds: [implementationPackage.artifactId],
      contentVersion: artifacts.filter((artifact) => artifact.type === "implementation_diff").length + 1,
      now
    });
    const report = executionReportSchema.parse({
      ...raw,
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "execution_report",
      schema_version: 2,
      content_version: 1,
      created_at: now,
      producer: { type: "import" },
      sensitivity: "confidential",
      parents: [implementationPackage.artifactId, diffRecord.artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        ...(git === undefined
          ? {}
          : {
              git,
              git_fingerprint: git.fingerprint
            })
      },
      run_id: runId,
      implementation_actor_id: "manual-agent",
      implementation_diff_artifact_id: diffRecord.artifactId,
      implementation_diff_sha256: diffRecord.sha256,
      implementation_package_artifact_id: implementationPackage.artifactId,
      implementation_package_sha256: implementationPackage.sha256,
      contract_artifact_id: parsedPackage.contract_artifact_id,
      contract_sha256: parsedPackage.contract_sha256,
      context_content_pack_artifact_id: parsedPackage.context_content_pack_artifact_id,
      context_content_pack_sha256: parsedPackage.context_content_pack_sha256,
      changed_files: git.changed_files.map((entry) => entry.path)
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
      schemaVersion: 2,
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
    for (const dependsOnArtifactId of report.parents) {
      addArtifactDependency(runtime.db, { artifactId, dependsOnArtifactId, dependencyKind: "parent" });
    }
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "execution.imported",
      actorType: "user",
      occurredAt: now,
      summary: "Manual execution result and exact Git diff imported",
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
      nextCommand: "sigil checks run"
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError("Execution result must be valid JSON", undefined, error);
    }
    throw error;
  } finally {
    closeSigilRuntime(runtime);
  }
}
