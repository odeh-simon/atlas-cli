import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { ApprovalRequiredError, StateTransitionError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  getArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@atlas/persistence";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ExportManualAgentPackageResult {
  readonly sessionId: string;
  readonly packageArtifactId: string;
  readonly state: string;
  readonly nextCommand: string;
}

export async function exportManualAgentPackage(options: RuntimeOptions = {}): Promise<ExportManualAgentPackageResult> {
  const runtime = await openAtlasRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for agent package export");
    }

    if (session.currentContractArtifactId === undefined) {
      throw new ApprovalRequiredError("Agent package export requires an approved contract");
    }

    const contract = getArtifactRecord(runtime.db, session.currentContractArtifactId);
    if (contract === undefined || contract.type !== "implementation_contract" || contract.status !== "approved") {
      throw new ApprovalRequiredError("Agent package export requires an approved contract");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const latestFixBatch = artifacts
      .filter((artifact) => artifact.type === "fix_batch" && artifact.status === "valid")
      .at(-1);
    const mode = session.primaryState === "fix_ready" ? "fix" : "implement";
    if (mode === "fix" && latestFixBatch === undefined) {
      throw new StateTransitionError("Fix package export requires a prepared fix batch");
    }

    const now = new Date().toISOString();
    const next = transition({
      state: session.primaryState,
      command: "export_agent_package",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const artifactId = newId("art");
    const markdown = `# Atlas Manual Agent Package

Session: ${session.sessionId}
Contract: ${contract.artifactId} (${contract.sha256})
Mode: ${mode}
${latestFixBatch === undefined ? "" : `Fix batch: ${latestFixBatch.artifactId} (${latestFixBatch.sha256})\n`}

## Instructions

${mode === "fix" ? "Address only the prepared fix batch against the approved contract." : "Implement only the approved contract."} Do not perform destructive Git operations. When done, create an execution result JSON for \`atlas execution import <file>\`.

## Completion Report Shape

\`\`\`json
{
  "process_status": "succeeded",
  "agent_claims_complete": true,
  "changed_files": [],
  "limitations": []
}
\`\`\`
`;
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "agent_implementation_package",
      contentVersion: artifacts.filter((artifact) => artifact.type === "agent_implementation_package").length + 1,
      mediaType: "text/markdown",
      content: markdown
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "agent_implementation_package",
      schemaVersion: 1,
      contentVersion: artifacts.filter((artifact) => artifact.type === "agent_implementation_package").length + 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "text/markdown",
      sensitivity: "confidential",
      status: "valid",
      producerType: "atlas",
      createdAt: now
    });
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "agent_package.exported",
      actorType: "atlas",
      occurredAt: now,
      summary: "Manual agent package exported",
      metadata: { packageArtifactId: artifactId, contractArtifactId: contract.artifactId, mode }
    });

    return {
      sessionId: session.sessionId,
      packageArtifactId: artifactId,
      state: next,
      nextCommand: "atlas execution import <file>"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}
