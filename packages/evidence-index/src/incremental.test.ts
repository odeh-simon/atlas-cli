import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "@sigil/domain";
import {
  getEvidenceFileByUri,
  getEvidenceIndexSnapshotPayload,
  listEvidenceFiles,
  listEvidenceIndexSnapshots,
  readCurrentIndexSnapshot,
  saveDatabase
} from "@sigil/persistence";

import { git, createCommittedRepo, openEngineDb } from "./test-helpers.js";
import { updateEvidenceIndex } from "./engine.js";

const tempRoots: string[] = [];
const NOW = () => new Date("2026-08-02T09:00:00.000Z");

function tempRoot(prefix = "sigil-evidence-incr-"): string {
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

const BASE_FILES: Record<string, string> = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "export const b = 2;\n",
  "src/c.ts": "export const c = 3;\n",
  "README.md": "# Sample\n"
};

describe("incremental invalidation scope", () => {
  it("invalidates only the edited file and keeps all other rows byte-identical", async () => {
    const repo = createCommittedRepo(BASE_FILES);
    const opened = await openEngineDb(repo);
    const before = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    const bytesBefore = statSync(opened.dbPath).size;

    writeRepoFile(repo, "src/b.ts", "export const b = 42;\n");
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    expect(after.metrics.outcome).toBe("updated");
    expect(after.metrics.changed).toBe(1);
    expect(after.metrics.added).toBe(0);
    expect(after.metrics.deleted).toBe(0);
    expect(after.metrics.invalidationsByReason["file-changed"]).toBeGreaterThanOrEqual(1);

    const previousPayload = getEvidenceIndexSnapshotPayload(opened.db, before.snapshotId as string)?.payload;
    const nextPayload = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload;
    expect(previousPayload).toBeDefined();
    expect(nextPayload).toBeDefined();

    const oldByUri = new Map(previousPayload?.files.map((file) => [file.uri, file]));
    const newByUri = new Map(nextPayload?.files.map((file) => [file.uri, file]));
    expect(oldByUri.size).toBe(newByUri.size);

    let untouchedRows = 0;
    for (const [uri, previousRow] of oldByUri) {
      const nextRow = newByUri.get(uri);
      expect(nextRow).toBeDefined();
      if (uri !== "src/b.ts") {
        expect(canonicalJson(nextRow)).toBe(canonicalJson(previousRow));
        untouchedRows += 1;
      } else {
        expect(nextRow?.content_sha256).not.toBe(previousRow.content_sha256);
      }
    }
    expect(untouchedRows).toBe(3);

    expect(nextPayload?.invalidations.length).toBeGreaterThanOrEqual(1);
    expect(nextPayload?.invalidations.some((inv) => inv.entity_type === "file" && inv.reason === "file-changed")).toBe(true);
    // With analyzer v2, editing one file also invalidates its symbol(s)
    const symbolInvalidations = nextPayload?.invalidations.filter((inv) => inv.entity_type === "symbol") ?? [];
    expect(symbolInvalidations.length).toBeGreaterThanOrEqual(1);

    const growthBytes = statSync(opened.dbPath).size - bytesBefore;
    expect(growthBytes).toBeGreaterThan(0);
    saveDatabase(opened.dbPath, opened.db);
  });

  it("tombstones deleted files and drops them from the payload with a file-deleted row", async () => {
    const repo = createCommittedRepo(BASE_FILES);
    const opened = await openEngineDb(repo);
    updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    rmSync(join(repo, "src/c.ts"));
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    expect(result.metrics.deleted).toBe(1);
    expect(result.metrics.invalidationsByReason["file-deleted"]).toBeGreaterThanOrEqual(1);

    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    expect(payload?.files.map((file) => file.uri)).not.toContain("src/c.ts");
    expect(payload?.invalidations.some((inv) => inv.entity_type === "file" && inv.reason === "file-deleted")).toBe(true);

    const tombstoned = getEvidenceFileByUri(opened.db, result.repositoryId, "src/c.ts");
    expect(tombstoned?.deletedAtSnapshotId).toBeDefined();
  });

  it("handles real git renames without authoritative ghosts", async () => {
    const repo = createCommittedRepo(BASE_FILES);
    const opened = await openEngineDb(repo);
    updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    git(repo, ["mv", "src/b.ts", "src/b-renamed.ts"]);

    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    expect(result.metrics.renamed).toBe(1);
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    const uris = payload?.files.map((file) => file.uri) ?? [];
    expect(uris).toContain("src/b-renamed.ts");
    expect(uris).not.toContain("src/b.ts");

    const ghost = getEvidenceFileByUri(opened.db, result.repositoryId, "src/b.ts");
    expect(ghost?.deletedAtSnapshotId).toBeDefined();

    git(repo, ["commit", "-m", "rename b"]);
    const committed = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    expect(committed.metrics.outcome).toBe("updated");
    expect(committed.metrics.changed).toBe(0);
    expect(committed.metrics.added).toBe(0);
    expect(committed.metrics.deleted).toBe(0);
    expect(committed.metrics.renamed).toBe(0);
  });

  it("returns fresh sets when switching branches changes the tracked tree", async () => {
    const repo = createCommittedRepo(BASE_FILES);
    const opened = await openEngineDb(repo);
    updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/feature-only.ts", "export const feature = true;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feature work"]);
    const featureBuild = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    expect(featureBuild.metrics.added).toBe(1);

    git(repo, ["checkout", "main"]);
    const mainBuild = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    const payload = getEvidenceIndexSnapshotPayload(opened.db, mainBuild.snapshotId as string)?.payload;
    expect(payload?.files.map((file) => file.uri)).not.toContain("src/feature-only.ts");
    expect(mainBuild.metrics.deleted).toBe(1);
  });

  it("scopes config-changed invalidations to classification rows only", async () => {
    const repo = createCommittedRepo(BASE_FILES);
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, {
      rootPath: repo,
      dbPath: opened.dbPath,
      now: NOW,
      configSha256: "a".repeat(64)
    });

    const second = updateEvidenceIndex(opened.db, {
      rootPath: repo,
      dbPath: opened.dbPath,
      now: NOW,
      configSha256: "b".repeat(64)
    });

    expect(second.metrics.outcome).toBe("updated");
    expect(second.metrics.changed).toBe(0);
    const classificationCount =
      getEvidenceIndexSnapshotPayload(opened.db, first.snapshotId as string)?.payload.classifications.length ?? 0;
    expect(second.metrics.invalidationsByReason["config-changed"]).toBe(classificationCount);
    expect(second.metrics.invalidationsByReason["file-changed"]).toBe(0);
  });

  it("re-verifies cached files when the base fingerprint moves under the same head", async () => {
    const repo = createCommittedRepo(BASE_FILES);
    const opened = await openEngineDb(repo);
    updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    writeRepoFile(repo, "src/a.ts", "export const a = 999;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "--amend", "--no-edit"]);

    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    expect(result.metrics.changed).toBe(1);
    expect(result.metrics.invalidationsByReason["git-reset"]).toBeGreaterThanOrEqual(1);

    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    const a = payload?.files.find((file) => file.uri === "src/a.ts");
    expect(a?.content_sha256).not.toBe(undefined);
  });

  it("lists historical snapshot headers with limits without loading payloads", async () => {
    let minute = 0;
    const tickingNow = () => new Date(Date.UTC(2026, 7, 2, 9, minute++));
    const repo = createCommittedRepo(BASE_FILES);
    const opened = await openEngineDb(repo);
    updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: tickingNow });
    writeRepoFile(repo, "src/b.ts", "export const b = 20;\n");
    updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: tickingNow });
    writeRepoFile(repo, "src/b.ts", "export const b = 21;\n");
    const third = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: tickingNow });
    saveDatabase(opened.dbPath, opened.db);

    const headers = listEvidenceIndexSnapshots(opened.db, third.repositoryId, { limit: 2 });
    expect(headers).toHaveLength(2);
    const newest = headers[0] as { snapshot_id: string; created_at: string };
    const older = headers[1] as { snapshot_id: string; created_at: string };
    expect(newest.snapshot_id).toBe(third.snapshotId);
    expect(newest.created_at >= older.created_at).toBe(true);
    saveDatabase(opened.dbPath, opened.db);
  });
});
