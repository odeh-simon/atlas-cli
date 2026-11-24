import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CancellationError } from "@sigil/domain";
import {
  abandonForeignRunningBuilds,
  getEvidenceIndexSnapshotPayload,
  queryOne,
  readCurrentIndexSnapshot,
  saveDatabase
} from "@sigil/persistence";

import { updateEvidenceIndex } from "./engine.js";
import { createCommittedRepo, openEngineDb } from "./test-helpers.js";

const tempRoots: string[] = [];
const NOW = () => new Date("2026-08-03T08:00:00.000Z");

function tempRoot(prefix = "sigil-evidence-cancel-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeRepoFile(repo: string, path: string, content: string): void {
  const target = join(repo, ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

describe("cancellation and crash recovery", () => {
  it("aborts mid-scan via signal and leaves the previous current snapshot authoritative", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n"
    });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    const controller = new AbortController();
    writeRepoFile(repo, "src/c.ts", "export const c = 3;\n");

    let aborted = false;
    expect(() =>
      updateEvidenceIndex(opened.db, {
        rootPath: repo,
        dbPath: opened.dbPath,
        now: NOW,
        signal: controller.signal,
        onScanProgress: (filesProcessed) => {
          if (filesProcessed >= 2 && !aborted) {
            aborted = true;
            controller.abort();
          }
        }
      })
    ).toThrow(CancellationError);

    saveDatabase(opened.dbPath, opened.db);

    const reopened = await openEngineDb(repo);
    const current = readCurrentIndexSnapshot(reopened.db, first.repositoryId);
    expect(current?.snapshot.snapshot_id).toBe(first.snapshotId);
    expect(current?.payload.files.map((file) => file.uri)).not.toContain("src/c.ts");
    expect(queryOne(reopened.db, "SELECT COUNT(*) AS count FROM evidence_index_snapshots")).toMatchObject({
      count: 1
    });

    const markers = queryOne(
      reopened.db,
      "SELECT state FROM evidence_index_builds WHERE repository_id = ? AND state != 'completed'",
      [first.repositoryId]
    );
    expect(markers).toBeDefined();
    reopened.db.close();
  });

  it("keeps the previous snapshot when persistence fails between commit and save", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n"
    });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    writeRepoFile(repo, "src/b.ts", "export const b = 22;\n");

    const committedShaBefore =
      getEvidenceIndexSnapshotPayload(opened.db, first.snapshotId as string)?.payload.files.find(
        (file) => file.uri === "src/b.ts"
      )?.content_sha256;

    let saves = 0;
    expect(() =>
      updateEvidenceIndex(opened.db, {
        rootPath: repo,
        dbPath: opened.dbPath,
        now: NOW,
        saveImplementation: (dbPath, database) => {
          saves += 1;
          if (saves >= 2) {
            throw new Error("injected disk failure after commit");
          }
          saveDatabase(dbPath, database);
        }
      })
    ).toThrow("injected disk failure after commit");

    const reopened = await openEngineDb(repo);
    const current = readCurrentIndexSnapshot(reopened.db, first.repositoryId);
    expect(current?.snapshot.snapshot_id).toBe(first.snapshotId);
    expect(current?.payload.files.find((file) => file.uri === "src/b.ts")?.content_sha256).toBe(
      committedShaBefore
    );
  });

  it("marks foreign running builds abandoned on startup without touching the current snapshot", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "a\n" });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    opened.db.run(
      `INSERT INTO evidence_index_builds (build_id, repository_id, state, pid, hostname, started_at, heartbeat_at)
       VALUES ('evbuild_foreign000000001', ?, 'running', 999999, 'stale-host', ?, ?)`,
      [first.repositoryId, NOW().toISOString(), NOW().toISOString()]
    );

    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    expect(result.metrics.outcome).toBe("reused");

    const abandoned = queryOne(
      opened.db,
      "SELECT state FROM evidence_index_builds WHERE build_id = 'evbuild_foreign000000001'"
    );
    expect(abandoned).toMatchObject({ state: "abandoned" });
    void abandonForeignRunningBuilds;
  });

  it("recovers to a rebuildable fail-closed state from tampered current data", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "credentials.json": "TOKEN=x\n"
    });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    opened.db.run("UPDATE evidence_index_snapshots SET payload_sha256 = ? WHERE snapshot_id = ?", [
      "e".repeat(64),
      first.snapshotId as string
    ]);

    expect(() =>
      updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW })
    ).toThrow();

    const rebuilt = updateEvidenceIndex(opened.db, {
      rootPath: repo,
      dbPath: opened.dbPath,
      now: NOW,
      forceRebuild: true
    });

    expect(rebuilt.metrics.outcome).toBe("rebuilt");
    const recovered = getEvidenceIndexSnapshotPayload(opened.db, rebuilt.snapshotId as string);
    expect(recovered?.payload.files.map((file) => file.uri)).toContain("credentials.json");
  });
});
