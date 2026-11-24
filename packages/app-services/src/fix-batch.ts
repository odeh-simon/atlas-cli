import { writeImmutableArtifactContent } from "@sigil/artifacts";
import { ApprovalRequiredError, StateTransitionError } from "@sigil/domain";
import {
  appendEvent,
  createArtifactRecord,
  getArtifactRecord,
  listArtifactsForSession,
  listFindingsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@sigil/persistence";
import { fixBatchSchema } from "@sigil/schemas";
import { transition } from "@sigil/workflow-engine";

import { closeSigilRuntime, newId, openSigilRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface PrepareFixBatchResult {
  readonly sessionId: string;
  readonly fixBatchArtifactId: string;
  readonly findingIds: readonly string[];
  readonly state: string;
  readonly nextCommand: string;
}

export async function prepareFixBatch(options: RuntimeOptions = {}): Promise<PrepareFixBatchResult> {
  const runtime = await openSigilRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) throw new StateTransitionError("No active session found for fix preparation");
    if (session.currentContractArtifactId === undefined) {
      throw new ApprovalRequiredError("Fix batch requires an approved contract");
    }
    const contract = getArtifactRecord(runtime.db, session.currentContractArtifactId);
    if (contract === undefined || contract.type !== "implementation_contract" || contract.status !== "approved") {
      throw new ApprovalRequiredError("Fix batch requires an approved contract");
    }

    const actionable = listFindingsForSession(runtime.db, session.sessionId).filter(
      (finding) =>
        (finding.status === "open" || finding.status === "reopened") &&
        (finding.severity === "blocking" || finding.severity === "important" || finding.severity === "suggestion")
    );
    if (actionable.length === 0) {
      throw new StateTransitionError("No open actionable findings found for fix preparation");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const contentVersion = listArtifactsForSession(runtime.db, session.sessionId).filter(
      (artifact) => artifact.type === "fix_batch"
    ).length + 1;
    const instructions = `# Sigil Fix Batch

Session: ${session.sessionId}
Contract: ${contract.artifactId} (${contract.sha256})

## Findings To Fix

${actionable
  .map(
    (finding) => `- ${finding.findingId} [${finding.severity}]: ${finding.title}
  - Status: ${finding.status}
  - Proposed action: ${finding.proposedAction ?? "Address according to finding evidence."}`
  )
  .join("\n")}

## Rules

Only address the findings listed in this batch. Preserve finding IDs in the execution result limitations or notes when work is partial.
`;
    const fixBatch = fixBatchSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "fix_batch",
      schema_version: 1,
      content_version: contentVersion,
      created_at: now,
      producer: { type: "sigil" },
      sensitivity: "confidential",
      parents: [contract.artifactId, ...new Set(actionable.map((finding) => finding.reviewReportArtifactId))],
      content_sha256: "0".repeat(64),
      metadata: { review_iterations: [...new Set(actionable.map((finding) => finding.reviewIteration))] },
      contract_artifact_id: contract.artifactId,
      contract_sha256: contract.sha256,
      finding_ids: actionable.map((finding) => finding.findingId),
      instructions_markdown: instructions
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "fix_batch",
      contentVersion,
      mediaType: "application/json",
      content: `${JSON.stringify(fixBatch, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "fix_batch",
      schemaVersion: 1,
      contentVersion,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "sigil",
      createdAt: now
    });

    const next = transition({
      state: session.primaryState,
      command: "prepare_fix_batch",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "fix_batch.prepared",
      actorType: "sigil",
      occurredAt: now,
      summary: "Fix batch prepared",
      metadata: { fixBatchArtifactId: artifactId, findingIds: actionable.map((finding) => finding.findingId) }
    });

    return {
      sessionId: session.sessionId,
      fixBatchArtifactId: artifactId,
      findingIds: actionable.map((finding) => finding.findingId),
      state: next,
      nextCommand: "sigil implement export --manual"
    };
  } finally {
    closeSigilRuntime(runtime);
  }
}
