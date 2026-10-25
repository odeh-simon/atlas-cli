import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PersistenceError } from "@atlas/domain";
import { compareIndexSnapshots } from "./comparison.js";
import { updateEvidenceIndex } from "./engine.js";
import { getEvidenceIndexSnapshotPayload, listEvidenceIndexSnapshots } from "@atlas/persistence";
import { type OpenedEngineDb, createCommittedRepo, openEngineDb } from "./test-helpers.js";

const tempRoots: string[] = [];
const NOW = () => new Date("2026-08-04T07:00:00.000Z");

function tempRoot(prefix = "atlas-evidence-compare-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("historical snapshot comparison", () => {
  it("compares two snapshots deterministically with sorted per-kind deltas", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "a\n",
      "src/b.ts": "b\n",
      "src/c.ts": "c\n"
    });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    writeFileSync(join(repo, "src/d.ts"), "d\n");
    writeFileSync(join(repo, "src/a.ts"), "a-changed\n");

    const second = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    const payloadA = getEvidenceIndexSnapshotPayload(opened.db, first.snapshotId as string)?.payload;
    const payloadB = getEvidenceIndexSnapshotPayload(opened.db, second.snapshotId as string)?.payload;
    expect(payloadA).toBeDefined();
    expect(payloadB).toBeDefined();

    const comparison = compareIndexSnapshots(payloadA as never, payloadB as never);
    const comparisonRepeat = compareIndexSnapshots(payloadA as never, payloadB as never);

    expect(comparison).toEqual(comparisonRepeat);
    expect(comparison.files.added).toEqual(["src/d.ts"]);
    expect(comparison.files.changed).toEqual(["src/a.ts"]);
    expect(comparison.files.removed).toEqual([]);
    expect(comparison.truncated).toBe(false);

    const bounded = compareIndexSnapshots(payloadA as never, payloadB as never, { maxDeltasPerKind: 0 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.files.added).toHaveLength(0);
  });

  it("rejects cross-repository comparisons", async () => {
    const repoA = createCommittedRepo({ "src/a.ts": "a\n" });
    const repoB = createCommittedRepo({ "src/a.ts": "a\n" });
    const openedA = await openEngineDb(repoA);
    const openedB = await openEngineDb(repoB);

    const resultA = updateEvidenceIndex(openedA.db, { rootPath: repoA, dbPath: openedA.dbPath, now: NOW });
    const resultB = updateEvidenceIndex(openedB.db, { rootPath: repoB, dbPath: openedB.dbPath, now: NOW });

    const payloadA = getEvidenceIndexSnapshotPayload(openedA.db, resultA.snapshotId as string)?.payload;
    const payloadB = getEvidenceIndexSnapshotPayload(openedB.db, resultB.snapshotId as string)?.payload;

    expect(() => compareIndexSnapshots(payloadA as never, payloadB as never)).toThrow(PersistenceError);
    expect(() => compareIndexSnapshots(payloadA as never, payloadB as never)).toThrow(/Cross-repository/u);
  });

  it("lists snapshot headers newest-first and respects the limit", async () => {
    let minute = 0;
    const tickingNow = () => new Date(Date.UTC(2026, 7, 4, 7, minute++));
    const repo = createCommittedRepo({ "src/a.ts": "v1\n" });
    const opened: OpenedEngineDb = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: tickingNow });

    writeFileSync(join(repo, "src/a.ts"), "v2\n");
    const second = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: tickingNow });

    writeFileSync(join(repo, "src/a.ts"), "v3\n");
    const third = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: tickingNow });

    const headersDesc = listEvidenceIndexSnapshots(opened.db, third.repositoryId as string, { limit: 10 });
    expect(headersDesc.map((header) => header.snapshot_id)).toEqual([
      third.snapshotId,
      second.snapshotId,
      first.snapshotId
    ]);

    const headersAscLimited = listEvidenceIndexSnapshots(opened.db, third.repositoryId as string, {
      limit: 1,
      order: "asc"
    });
    expect(headersAscLimited.map((header) => header.snapshot_id)).toEqual([first.snapshotId]);
  });
});
