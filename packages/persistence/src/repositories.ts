import { PersistenceError, type SessionDisposition, type WorkflowState, isWorkflowState } from "@sigil/domain";
import type initSqlJs from "sql.js";

import { optionalString, queryAll, queryOne, requiredNumber, requiredString } from "./sql.js";

type SqlDatabase = initSqlJs.Database;

export interface RepositoryRecord {
  readonly repoId: string;
  readonly rootPath: string;
  readonly remoteUrlHash?: string | undefined;
  readonly displayName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRepositoryInput {
  readonly repoId: string;
  readonly rootPath: string;
  readonly remoteUrlHash?: string | undefined;
  readonly displayName: string;
  readonly now: string;
}

export type TaskSource = "linear" | "manual";

export interface SessionRecord {
  readonly sessionId: string;
  readonly repoId: string;
  readonly taskKey?: string | undefined;
  readonly taskSource: TaskSource;
  readonly primaryState: WorkflowState;
  readonly paused: boolean;
  readonly archived: boolean;
  readonly disposition: SessionDisposition;
  readonly currentContractArtifactId?: string | undefined;
  readonly currentContextArtifactId?: string | undefined;
  readonly currentGitHead?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string | undefined;
}

export interface CreateSessionInput {
  readonly sessionId: string;
  readonly repoId: string;
  readonly taskKey?: string | undefined;
  readonly taskSource: TaskSource;
  readonly primaryState: WorkflowState;
  readonly now: string;
}

export type ActorType = "user" | "sigil" | "adapter" | "agent";

export interface EventRecord {
  readonly eventId: string;
  readonly sessionId?: string | undefined;
  readonly eventType: string;
  readonly actorType: ActorType;
  readonly actorId?: string | undefined;
  readonly commandId?: string | undefined;
  readonly occurredAt: string;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AppendEventInput extends Omit<EventRecord, "metadata"> {
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export type LockScope = "session" | "project" | "global";

export interface LockRecord {
  readonly lockId: string;
  readonly scope: LockScope;
  readonly scopeId: string;
  readonly ownerPid: number;
  readonly ownerHostname: string;
  readonly ownerCommandId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string | undefined;
}

export interface AcquireLockInput {
  readonly lockId: string;
  readonly scope: LockScope;
  readonly scopeId: string;
  readonly ownerPid: number;
  readonly ownerHostname: string;
  readonly ownerCommandId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export function createRepository(db: SqlDatabase, input: CreateRepositoryInput): RepositoryRecord {
  db.run(
    `INSERT INTO repositories (repo_id, root_path, remote_url_hash, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.repoId, input.rootPath, input.remoteUrlHash ?? null, input.displayName, input.now, input.now]
  );

  const repository = getRepository(db, input.repoId);
  if (repository === undefined) {
    throw new PersistenceError("Repository was not created", { repoId: input.repoId });
  }

  return repository;
}

export function getRepository(db: SqlDatabase, repoId: string): RepositoryRecord | undefined {
  const row = queryOne(db, "SELECT * FROM repositories WHERE repo_id = ?", [repoId]);
  return row === undefined ? undefined : mapRepository(row);
}

export function createSession(db: SqlDatabase, input: CreateSessionInput): SessionRecord {
  db.run(
    `INSERT INTO sessions (session_id, repo_id, task_key, task_source, primary_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.sessionId, input.repoId, input.taskKey ?? null, input.taskSource, input.primaryState, input.now, input.now]
  );

  const session = getSession(db, input.sessionId);
  if (session === undefined) {
    throw new PersistenceError("Session was not created", { sessionId: input.sessionId });
  }

  return session;
}

export function getSession(db: SqlDatabase, sessionId: string): SessionRecord | undefined {
  const row = queryOne(db, "SELECT * FROM sessions WHERE session_id = ?", [sessionId]);
  return row === undefined ? undefined : mapSession(row);
}

export function listSessionsForRepository(db: SqlDatabase, repoId: string): SessionRecord[] {
  return queryAll(db, "SELECT * FROM sessions WHERE repo_id = ? ORDER BY updated_at DESC, created_at DESC", [repoId]).map(
    mapSession
  );
}

export function findActiveSessionByTask(
  db: SqlDatabase,
  repoId: string,
  taskSource: TaskSource,
  taskKey: string
): SessionRecord | undefined {
  const row = queryOne(
    db,
    `SELECT * FROM sessions
     WHERE repo_id = ? AND task_source = ? AND task_key = ? AND disposition != 'cancelled'
     ORDER BY created_at DESC
     LIMIT 1`,
    [repoId, taskSource, taskKey]
  );
  return row === undefined ? undefined : mapSession(row);
}

export function updateSessionState(
  db: SqlDatabase,
  input: { readonly sessionId: string; readonly primaryState: WorkflowState; readonly now: string }
): SessionRecord {
  db.run("UPDATE sessions SET primary_state = ?, updated_at = ? WHERE session_id = ?", [
    input.primaryState,
    input.now,
    input.sessionId
  ]);

  const session = getSession(db, input.sessionId);
  if (session === undefined) {
    throw new PersistenceError("Session not found for state update", { sessionId: input.sessionId });
  }

  return session;
}

export function updateSessionPaused(
  db: SqlDatabase,
  input: { readonly sessionId: string; readonly paused: boolean; readonly now: string }
): SessionRecord {
  db.run("UPDATE sessions SET paused = ?, updated_at = ? WHERE session_id = ?", [
    input.paused ? 1 : 0,
    input.now,
    input.sessionId
  ]);

  const session = getSession(db, input.sessionId);
  if (session === undefined) {
    throw new PersistenceError("Session not found for pause update", { sessionId: input.sessionId });
  }

  return session;
}

export function updateSessionArchived(
  db: SqlDatabase,
  input: { readonly sessionId: string; readonly archived: boolean; readonly now: string }
): SessionRecord {
  db.run("UPDATE sessions SET archived = ?, updated_at = ? WHERE session_id = ?", [
    input.archived ? 1 : 0,
    input.now,
    input.sessionId
  ]);

  const session = getSession(db, input.sessionId);
  if (session === undefined) {
    throw new PersistenceError("Session not found for archive update", { sessionId: input.sessionId });
  }

  return session;
}

export function updateSessionDisposition(
  db: SqlDatabase,
  input: {
    readonly sessionId: string;
    readonly disposition: SessionDisposition;
    readonly now: string;
    readonly closedAt?: string | undefined;
  }
): SessionRecord {
  db.run("UPDATE sessions SET disposition = ?, closed_at = ?, updated_at = ? WHERE session_id = ?", [
    input.disposition,
    input.closedAt ?? null,
    input.now,
    input.sessionId
  ]);

  const session = getSession(db, input.sessionId);
  if (session === undefined) {
    throw new PersistenceError("Session not found for disposition update", { sessionId: input.sessionId });
  }

  return session;
}

export function updateSessionContextArtifact(
  db: SqlDatabase,
  input: { readonly sessionId: string; readonly artifactId: string; readonly primaryState: WorkflowState; readonly now: string }
): SessionRecord {
  db.run(
    "UPDATE sessions SET current_context_artifact_id = ?, primary_state = ?, updated_at = ? WHERE session_id = ?",
    [input.artifactId, input.primaryState, input.now, input.sessionId]
  );

  const session = getSession(db, input.sessionId);
  if (session === undefined) {
    throw new PersistenceError("Session not found for context artifact update", { sessionId: input.sessionId });
  }

  return session;
}

export function updateSessionContractArtifact(
  db: SqlDatabase,
  input: { readonly sessionId: string; readonly artifactId: string; readonly primaryState: WorkflowState; readonly now: string }
): SessionRecord {
  db.run(
    "UPDATE sessions SET current_contract_artifact_id = ?, primary_state = ?, updated_at = ? WHERE session_id = ?",
    [input.artifactId, input.primaryState, input.now, input.sessionId]
  );

  const session = getSession(db, input.sessionId);
  if (session === undefined) {
    throw new PersistenceError("Session not found for contract artifact update", { sessionId: input.sessionId });
  }

  return session;
}

export function appendEvent(db: SqlDatabase, input: AppendEventInput): EventRecord {
  db.run(
    `INSERT INTO events
      (event_id, session_id, event_type, actor_type, actor_id, command_id, occurred_at, summary, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.eventId,
      input.sessionId ?? null,
      input.eventType,
      input.actorType,
      input.actorId ?? null,
      input.commandId ?? null,
      input.occurredAt,
      input.summary,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  const event = queryOne(db, "SELECT * FROM events WHERE event_id = ?", [input.eventId]);
  if (event === undefined) {
    throw new PersistenceError("Event was not created", { eventId: input.eventId });
  }

  return mapEvent(event);
}

export function listEvents(db: SqlDatabase, sessionId: string): EventRecord[] {
  return queryAll(db, "SELECT * FROM events WHERE session_id = ? ORDER BY occurred_at, event_id", [sessionId]).map(
    mapEvent
  );
}

export function acquireLock(db: SqlDatabase, input: AcquireLockInput): LockRecord {
  const active = getActiveLock(db, input.scope, input.scopeId);
  if (active !== undefined) {
    throw new PersistenceError("Lock is already held", {
      scope: input.scope,
      scopeId: input.scopeId,
      activeLockId: active.lockId
    });
  }

  db.run(
    `INSERT INTO locks
      (lock_id, scope, scope_id, owner_pid, owner_hostname, owner_command_id, acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.lockId,
      input.scope,
      input.scopeId,
      input.ownerPid,
      input.ownerHostname,
      input.ownerCommandId,
      input.now,
      input.now,
      input.expiresAt
    ]
  );

  const lock = getActiveLock(db, input.scope, input.scopeId);
  if (lock === undefined) {
    throw new PersistenceError("Lock was not acquired", { lockId: input.lockId });
  }

  return lock;
}

export function getActiveLock(db: SqlDatabase, scope: LockScope, scopeId: string): LockRecord | undefined {
  const row = queryOne(db, "SELECT * FROM locks WHERE scope = ? AND scope_id = ? AND released_at IS NULL", [
    scope,
    scopeId
  ]);
  return row === undefined ? undefined : mapLock(row);
}

export function releaseLock(
  db: SqlDatabase,
  input: { readonly lockId: string; readonly releasedAt: string }
): LockRecord | undefined {
  db.run("UPDATE locks SET released_at = ? WHERE lock_id = ? AND released_at IS NULL", [
    input.releasedAt,
    input.lockId
  ]);

  const row = queryOne(db, "SELECT * FROM locks WHERE lock_id = ?", [input.lockId]);
  return row === undefined ? undefined : mapLock(row);
}

function mapRepository(row: Record<string, initSqlJs.SqlValue>): RepositoryRecord {
  return {
    repoId: requiredString(row, "repo_id"),
    rootPath: requiredString(row, "root_path"),
    remoteUrlHash: optionalString(row, "remote_url_hash"),
    displayName: requiredString(row, "display_name"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at")
  };
}

function mapSession(row: Record<string, initSqlJs.SqlValue>): SessionRecord {
  const primaryState = requiredString(row, "primary_state");
  if (!isWorkflowState(primaryState)) {
    throw new PersistenceError("Stored session has invalid workflow state", { primaryState });
  }

  return {
    sessionId: requiredString(row, "session_id"),
    repoId: requiredString(row, "repo_id"),
    taskKey: optionalString(row, "task_key"),
    taskSource: requiredString(row, "task_source") as TaskSource,
    primaryState,
    paused: requiredNumber(row, "paused") === 1,
    archived: requiredNumber(row, "archived") === 1,
    disposition: requiredString(row, "disposition") as SessionDisposition,
    currentContractArtifactId: optionalString(row, "current_contract_artifact_id"),
    currentContextArtifactId: optionalString(row, "current_context_artifact_id"),
    currentGitHead: optionalString(row, "current_git_head"),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
    closedAt: optionalString(row, "closed_at")
  };
}

function mapEvent(row: Record<string, initSqlJs.SqlValue>): EventRecord {
  return {
    eventId: requiredString(row, "event_id"),
    sessionId: optionalString(row, "session_id"),
    eventType: requiredString(row, "event_type"),
    actorType: requiredString(row, "actor_type") as ActorType,
    actorId: optionalString(row, "actor_id"),
    commandId: optionalString(row, "command_id"),
    occurredAt: requiredString(row, "occurred_at"),
    summary: requiredString(row, "summary"),
    metadata: JSON.parse(requiredString(row, "metadata_json")) as Readonly<Record<string, unknown>>
  };
}

function mapLock(row: Record<string, initSqlJs.SqlValue>): LockRecord {
  return {
    lockId: requiredString(row, "lock_id"),
    scope: requiredString(row, "scope") as LockScope,
    scopeId: requiredString(row, "scope_id"),
    ownerPid: requiredNumber(row, "owner_pid"),
    ownerHostname: requiredString(row, "owner_hostname"),
    ownerCommandId: requiredString(row, "owner_command_id"),
    acquiredAt: requiredString(row, "acquired_at"),
    heartbeatAt: requiredString(row, "heartbeat_at"),
    expiresAt: requiredString(row, "expires_at"),
    releasedAt: optionalString(row, "released_at")
  };
}
