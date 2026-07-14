import { ApprovalRequiredError, StateTransitionError } from "@atlas/domain";
import {
  appendEvent,
  createApproval,
  getArtifactRecord,
  listSessionsForRepository,
  updateArtifactStatus,
  updateSessionState
} from "@atlas/persistence";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ApproveContractInput extends RuntimeOptions {
  readonly actorId?: string | undefined;
  readonly rationale?: string | undefined;
}

export interface ApproveContractResult {
  readonly sessionId: string;
  readonly contractArtifactId: string;
  readonly approvalId: string;
  readonly state: string;
  readonly nextCommand: string;
}

export async function approveContract(input: ApproveContractInput = {}): Promise<ApproveContractResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for contract approval");
    }

    if (session.currentContractArtifactId === undefined) {
      throw new ApprovalRequiredError("No imported contract is available for approval");
    }

    const contract = getArtifactRecord(runtime.db, session.currentContractArtifactId);
    if (contract === undefined || contract.type !== "implementation_contract" || contract.status !== "valid") {
      throw new ApprovalRequiredError("Current contract must be valid before approval");
    }

    const now = new Date().toISOString();
    const next = transition({
      state: session.primaryState,
      command: "approve_contract",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const approval = createApproval(runtime.db, {
      approvalId: newId("appr"),
      sessionId: session.sessionId,
      artifactId: contract.artifactId,
      approvalType: "contract",
      artifactSha256: contract.sha256,
      actorId: input.actorId ?? "local-user",
      rationale: input.rationale,
      createdAt: now
    });
    updateArtifactStatus(runtime.db, { artifactId: contract.artifactId, status: "approved", approvedAt: now });
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "contract.approved",
      actorType: "user",
      actorId: input.actorId ?? "local-user",
      occurredAt: now,
      summary: "Implementation contract approved",
      metadata: { contractArtifactId: contract.artifactId, approvalId: approval.approvalId }
    });

    return {
      sessionId: session.sessionId,
      contractArtifactId: contract.artifactId,
      approvalId: approval.approvalId,
      state: next,
      nextCommand: "atlas implement export --manual"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}
