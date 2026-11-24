import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireLock,
  appendEvent,
  applyMigrations,
  coreMigrations,
  createDecisionRecord,
  createRepository,
  createSession,
  findActiveSessionByTask,
  getActiveLock,
  getRepository,
  getSession,
  listDecisionRecordsForSession,
  listEvents,
  openDatabase,
  releaseLock,
  saveDatabase,
  updateSessionState
} from "./index.js";

const tempRoots: string[] = [];
const now = "2026-07-12T12:00:00.000Z";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-core-"));
  tempRoots.push(root);
  return root;
}

async function openMigratedDb(root: string) {
  const dbPath = join(root, "sigil.db");
  await applyMigrations({
    dbPath,
    backupDirectory: join(root, "backups"),
    now: () => new Date(now),
    migrations: coreMigrations
  });

  return { dbPath, db: await openDatabase(dbPath) };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("core session repositories", () => {
  it("creates and reads repositories and sessions", async () => {
    const root = tempRoot();
    const { dbPath, db } = await openMigratedDb(root);

    const repository = createRepository(db, {
      repoId: "repo_1",
      rootPath: "C:/work/repo",
      displayName: "Pilot Repo",
      remoteUrlHash: "remote_hash",
      now
    });
    const session = createSession(db, {
      sessionId: "ses_1",
      repoId: repository.repoId,
      taskKey: "ENG-1",
      taskSource: "manual",
      primaryState: "intake_ready",
      now
    });

    expect(getRepository(db, "repo_1")).toEqual(repository);
    expect(getSession(db, "ses_1")).toEqual(session);
    expect(findActiveSessionByTask(db, "repo_1", "manual", "ENG-1")?.sessionId).toBe("ses_1");

    saveDatabase(dbPath, db);
    db.close();

    const reopened = await openDatabase(dbPath);
    expect(getSession(reopened, "ses_1")?.primaryState).toBe("intake_ready");
    reopened.close();
  });

  it("prevents duplicate active sessions for the same task", async () => {
    const root = tempRoot();
    const { db } = await openMigratedDb(root);

    createRepository(db, { repoId: "repo_1", rootPath: "C:/work/repo", displayName: "Pilot Repo", now });
    createSession(db, {
      sessionId: "ses_1",
      repoId: "repo_1",
      taskKey: "ENG-1",
      taskSource: "manual",
      primaryState: "intake_ready",
      now
    });

    expect(() =>
      createSession(db, {
        sessionId: "ses_2",
        repoId: "repo_1",
        taskKey: "ENG-1",
        taskSource: "manual",
        primaryState: "intake_ready",
        now
      })
    ).toThrow();

    db.close();
  });

  it("updates state and appends audit events", async () => {
    const root = tempRoot();
    const { db } = await openMigratedDb(root);

    createRepository(db, { repoId: "repo_1", rootPath: "C:/work/repo", displayName: "Pilot Repo", now });
    createSession(db, {
      sessionId: "ses_1",
      repoId: "repo_1",
      taskSource: "manual",
      primaryState: "intake_ready",
      now
    });

    updateSessionState(db, { sessionId: "ses_1", primaryState: "context_ready", now });
    appendEvent(db, {
      eventId: "evt_1",
      sessionId: "ses_1",
      eventType: "session.state_changed",
      actorType: "sigil",
      commandId: "cmd_1",
      occurredAt: now,
      summary: "Context became ready",
      metadata: { from: "intake_ready", to: "context_ready" }
    });

    expect(getSession(db, "ses_1")?.primaryState).toBe("context_ready");
    expect(listEvents(db, "ses_1")).toEqual([
      expect.objectContaining({
        eventId: "evt_1",
        metadata: { from: "intake_ready", to: "context_ready" }
      })
    ]);

    db.close();
  });

  it("creates and lists decision records", async () => {
    const root = tempRoot();
    const { db } = await openMigratedDb(root);

    createRepository(db, { repoId: "repo_1", rootPath: "C:/work/repo", displayName: "Pilot Repo", now });
    createSession(db, {
      sessionId: "ses_1",
      repoId: "repo_1",
      taskSource: "manual",
      primaryState: "intake_ready",
      now
    });
    db.run(
      `INSERT INTO artifacts
        (artifact_id, session_id, type, schema_version, content_version, storage_uri, sha256, byte_length,
         media_type, sensitivity, status, producer_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "art_decision",
        "ses_1",
        "decision_record",
        1,
        1,
        "ses_1/decision_record/1.json",
        "0".repeat(64),
        2,
        "application/json",
        "internal",
        "approved",
        "user",
        now
      ]
    );

    createDecisionRecord(db, {
      decisionId: "dec_1",
      sessionId: "ses_1",
      artifactId: "art_decision",
      kind: "decision",
      title: "Use CLI",
      rationale: "M3 scope",
      category: "architecture",
      approvedBy: "tester",
      approvedAt: now
    });

    expect(listDecisionRecordsForSession(db, "ses_1")[0]).toMatchObject({
      decisionId: "dec_1",
      category: "architecture"
    });

    db.close();
  });

  it("enforces active lock uniqueness and allows reacquire after release", async () => {
    const root = tempRoot();
    const { db } = await openMigratedDb(root);

    const lock = acquireLock(db, {
      lockId: "lock_1",
      scope: "session",
      scopeId: "ses_1",
      ownerPid: 100,
      ownerHostname: "host",
      ownerCommandId: "cmd_1",
      now,
      expiresAt: "2026-07-12T12:05:00.000Z"
    });

    expect(getActiveLock(db, "session", "ses_1")?.lockId).toBe(lock.lockId);
    expect(() =>
      acquireLock(db, {
        lockId: "lock_2",
        scope: "session",
        scopeId: "ses_1",
        ownerPid: 101,
        ownerHostname: "host",
        ownerCommandId: "cmd_2",
        now,
        expiresAt: "2026-07-12T12:05:00.000Z"
      })
    ).toThrow("Lock is already held");

    expect(releaseLock(db, { lockId: "lock_1", releasedAt: "2026-07-12T12:01:00.000Z" })?.releasedAt).toBe(
      "2026-07-12T12:01:00.000Z"
    );

    const reacquired = acquireLock(db, {
      lockId: "lock_2",
      scope: "session",
      scopeId: "ses_1",
      ownerPid: 101,
      ownerHostname: "host",
      ownerCommandId: "cmd_2",
      now,
      expiresAt: "2026-07-12T12:05:00.000Z"
    });

    expect(reacquired.lockId).toBe("lock_2");
    db.close();
  });
});
