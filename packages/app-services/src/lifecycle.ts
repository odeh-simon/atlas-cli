import { StateTransitionError } from "@sigil/domain";
import {
  appendEvent,
  listSessionsForRepository,
  updateSessionArchived,
  updateSessionDisposition,
  updateSessionPaused,
  type SessionRecord
} from "@sigil/persistence";
import { transition } from "@sigil/workflow-engine";

import {
  closeSigilRuntime,
  newId,
  openSigilRuntime,
  repoIdForPath,
  type SigilRuntime,
  type RuntimeOptions
} from "./runtime.js";

export interface LifecycleCommandInput extends RuntimeOptions {
  readonly actorId?: string | undefined;
  readonly reason?: string | undefined;
}

export interface LifecycleCommandResult {
  readonly session: SessionRecord;
  readonly nextCommand: string | undefined;
}

export async function pauseSession(input: LifecycleCommandInput = {}): Promise<LifecycleCommandResult> {
  return lifecycleCommand(input, {
    command: "pause",
    eventType: "session.paused",
    summary: "Session paused",
    update: (session, now, runtime) =>
      updateSessionPaused(runtime.db, { sessionId: session.sessionId, paused: true, now }),
    nextCommand: "sigil resume"
  });
}

export async function resumePausedSession(input: LifecycleCommandInput = {}): Promise<LifecycleCommandResult> {
  return lifecycleCommand(input, {
    command: "resume_pause",
    eventType: "session.resumed",
    summary: "Session resumed",
    update: (session, now, runtime) =>
      updateSessionPaused(runtime.db, { sessionId: session.sessionId, paused: false, now }),
    nextCommand: undefined
  });
}

export async function archiveSession(input: LifecycleCommandInput = {}): Promise<LifecycleCommandResult> {
  return lifecycleCommand(input, {
    command: "archive",
    eventType: "session.archived",
    summary: "Session archived",
    update: (session, now, runtime) =>
      updateSessionArchived(runtime.db, { sessionId: session.sessionId, archived: true, now }),
    nextCommand: "sigil unarchive"
  });
}

export async function unarchiveSession(input: LifecycleCommandInput = {}): Promise<LifecycleCommandResult> {
  return lifecycleCommand(input, {
    command: "unarchive",
    eventType: "session.unarchived",
    summary: "Session unarchived",
    update: (session, now, runtime) =>
      updateSessionArchived(runtime.db, { sessionId: session.sessionId, archived: false, now }),
    nextCommand: undefined
  });
}

export async function cancelSession(input: LifecycleCommandInput = {}): Promise<LifecycleCommandResult> {
  return lifecycleCommand(input, {
    command: "cancel",
    eventType: "session.cancelled",
    summary: "Session cancelled",
    update: (session, now, runtime) =>
      updateSessionDisposition(runtime.db, {
        sessionId: session.sessionId,
        disposition: "cancelled",
        now,
        closedAt: now
      }),
    nextCommand: undefined
  });
}

async function lifecycleCommand(
  input: LifecycleCommandInput,
  definition: {
    readonly command: "pause" | "resume_pause" | "archive" | "unarchive" | "cancel";
    readonly eventType: string;
    readonly summary: string;
    readonly update: (session: SessionRecord, now: string, runtime: SigilRuntime) => SessionRecord;
    readonly nextCommand: string | undefined;
  }
): Promise<LifecycleCommandResult> {
  const runtime = await openSigilRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for lifecycle command");
    }

    transition({
      state: session.primaryState,
      command: definition.command,
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    });
    const now = new Date().toISOString();
    const updated = definition.update(session, now, runtime);
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: definition.eventType,
      actorType: "user",
      actorId: input.actorId ?? "local-user",
      occurredAt: now,
      summary: definition.summary,
      metadata: { reason: input.reason }
    });

    return { session: updated, nextCommand: definition.nextCommand };
  } finally {
    closeSigilRuntime(runtime);
  }
}
