import { StateTransitionError, ValidationError, type FindingStatus } from "@atlas/domain";
import {
  appendEvent,
  createFindingDisposition,
  getFinding,
  listSessionsForRepository,
  updateFindingStatus,
  updateSessionState,
  type FindingDispositionAction
} from "@atlas/persistence";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface DisposeFindingInput extends RuntimeOptions {
  readonly findingId: string;
  readonly disposition: FindingDispositionAction;
  readonly reason: string;
  readonly evidence?: readonly string[] | undefined;
  readonly actorId?: string | undefined;
}

export interface DisposeFindingResult {
  readonly sessionId: string;
  readonly findingId: string;
  readonly status: FindingStatus;
  readonly state: string;
  readonly nextCommand: string;
}

export async function disposeFinding(input: DisposeFindingInput): Promise<DisposeFindingResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) throw new StateTransitionError("No active session found for finding disposition");

    const finding = getFinding(runtime.db, input.findingId);
    if (finding === undefined || finding.sessionId !== session.sessionId) {
      throw new ValidationError("Finding does not exist in the active session", { findingId: input.findingId });
    }
    if (input.disposition === "resolve" && (input.evidence === undefined || input.evidence.length === 0)) {
      throw new ValidationError("Resolving a finding requires explicit resolution evidence");
    }

    const now = new Date().toISOString();
    const nextStatus = statusForDisposition(input.disposition);
    createFindingDisposition(runtime.db, {
      dispositionId: newId("disp"),
      findingId: finding.findingId,
      sessionId: session.sessionId,
      disposition: input.disposition,
      actorId: input.actorId ?? "local-user",
      reason: input.reason,
      resolutionEvidence: input.evidence ?? [],
      createdAt: now
    });
    updateFindingStatus(runtime.db, { findingId: finding.findingId, status: nextStatus, now });
    const next = transition({
      state: session.primaryState,
      command: "dispose_findings",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "finding.dispositioned",
      actorType: "user",
      actorId: input.actorId ?? "local-user",
      occurredAt: now,
      summary: "Finding disposition recorded",
      metadata: { findingId: finding.findingId, disposition: input.disposition, status: nextStatus }
    });

    return {
      sessionId: session.sessionId,
      findingId: finding.findingId,
      status: nextStatus,
      state: next,
      nextCommand: "atlas complete --check"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function statusForDisposition(disposition: FindingDispositionAction): FindingStatus {
  switch (disposition) {
    case "resolve":
      return "resolved";
    case "accept_deviation":
      return "accepted_deviation";
    case "reject":
      return "rejected";
    case "defer":
      return "deferred";
    case "duplicate":
      return "duplicate";
    case "cannot_reproduce":
      return "cannot_reproduce";
    case "reopen":
      return "reopened";
  }
}
