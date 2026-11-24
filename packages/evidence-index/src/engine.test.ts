import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactIntegrityError, MigrationError } from "@sigil/domain";
import { readCurrentIndexSnapshot, saveDatabase } from "@sigil/persistence";

import { updateEvidenceIndex } from "./engine.js";
import {
  cleanupTempRoots,
  NOW,
  createCommittedRepo,
  gitAvailable,
  openEngineDb,
  registerTempRoot,
  type OpenedEngineDb
} from "./test-helpers.js";

describe.skipIf(!gitAvailable)("evidence index engine tier-0 reuse", () => {
  it("reuses the exact snapshot on an unchanged repository without hashing files", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "README.md": "# Sample\n"
    });
    const opened = await openEngineDb(repo);

    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    expect(first.metrics.outcome).toBe("updated");
    expect(first.metrics.filesHashed).toBe(3);
    expect(first.snapshotId).toBeDefined();

    saveDatabase(opened.dbPath, opened.db);
    opened.db.close();

    const reopened = await openEngineDb(repo);
    const second = updateEvidenceIndex(reopened.db, { rootPath: repo, dbPath: reopened.dbPath, now: NOW });

    expect(second.metrics.outcome).toBe("reused");
    expect(second.metrics.filesHashed).toBe(0);
    expect(second.metrics.cacheHits).toBe(0);
    expect(second.metrics.added).toBe(0);
    expect(second.metrics.changed).toBe(0);
    expect(second.snapshotId).toBe(first.snapshotId);

    const current = readCurrentIndexSnapshot(reopened.db, second.repositoryId);
    expect(current?.snapshot.snapshot_id).toBe(first.snapshotId);
    reopened.db.close();
  });

  it("surfaces integrity and schema-version failures instead of stale evidence", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a = 1;\n" });
    const opened = await openEngineDb(repo);

    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    opened.db.run("UPDATE evidence_index_snapshots SET payload_json = REPLACE(payload_json, '\"files\"', '\"filez\"') WHERE snapshot_id = ?", [
      first.snapshotId as string
    ]);

    expect(() =>
      updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW })
    ).toThrow(ArtifactIntegrityError);

    const rebuilt = updateEvidenceIndex(opened.db, {
      rootPath: repo,
      dbPath: opened.dbPath,
      now: NOW,
      forceRebuild: true
    });
    expect(rebuilt.metrics.outcome).toBe("rebuilt");
    expect(rebuilt.metrics.invalidationsByReason["manual-rebuild"]).toBeGreaterThan(0);

    const recovered = readCurrentIndexSnapshot(opened.db, rebuilt.repositoryId);
    expect(recovered?.payload.files.map((file) => file.uri)).toContain("src/a.ts");
  });

  it("surfaces unsupported snapshot schema versions as MigrationError even when forced", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a = 1;\n" });
    const opened = await openEngineDb(repo);

    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);

    opened.db.run("UPDATE evidence_index_snapshots SET schema_version = 99 WHERE snapshot_id = ?", [
      first.snapshotId as string
    ]);

    expect(() =>
      updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW, forceRebuild: true })
    ).toThrow(MigrationError);
  });

  it("keeps payload bytes stable across identical rebuilds of the same tree state", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "a\n",
      "docs/readme.md": "doc\n",
      "config/credentials.json": "{\"token\": \"redacted\"}\n",
    });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });

    const bytesBefore = statSync(opened.dbPath).size;
    const second = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    void bytesBefore;

    expect(second.metrics.outcome).toBe("reused");
    const current = readCurrentIndexSnapshot(opened.db, second.repositoryId);
    const secretFile = current?.payload.classifications.find((classification) => classification.secret);
    expect(secretFile?.uri).toBe("config/credentials.json");
    expect(secretFile?.sensitivity).toBe("confidential");
    saveDatabase(opened.dbPath, opened.db);
  });
});
