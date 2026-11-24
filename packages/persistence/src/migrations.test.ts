import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, coreMigrations, openDatabase, readAppliedMigrations, saveDatabase } from "./index.js";

const tempRoots: string[] = [];
const now = () => new Date("2026-07-12T12:00:00.000Z");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-persistence-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("migration harness", () => {
  it("applies sorted migrations and records checksums", async () => {
    const root = tempRoot();
    const dbPath = join(root, "sigil.db");
    const result = await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now,
      migrations: [
        { version: 1, name: "create_marker", sql: "CREATE TABLE marker (id INTEGER PRIMARY KEY);" },
        { version: 2, name: "insert_marker", sql: "INSERT INTO marker (id) VALUES (1);" }
      ]
    });

    expect(result.backupPath).toBeUndefined();
    expect(result.applied.map((migration) => migration.version)).toEqual([1, 2]);

    const db = await openDatabase(dbPath);
    expect(readAppliedMigrations(db)).toHaveLength(2);
    expect(db.exec("SELECT COUNT(*) AS count FROM marker")[0]?.values[0]?.[0]).toBe(1);
    db.close();
  });

  it("skips migrations that were already applied with the same checksum", async () => {
    const root = tempRoot();
    const dbPath = join(root, "sigil.db");
    const migrations = [{ version: 1, name: "create_marker", sql: "CREATE TABLE marker (id INTEGER PRIMARY KEY);" }];

    await applyMigrations({ dbPath, backupDirectory: join(root, "backups"), now, migrations });
    const second = await applyMigrations({ dbPath, backupDirectory: join(root, "backups"), now, migrations });

    expect(second.applied).toEqual([]);
    expect(second.backupPath).toContain("pre-migration.db");
  });

  it("restores the previous database when a migration fails", async () => {
    const root = tempRoot();
    const dbPath = join(root, "sigil.db");
    await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now,
      migrations: [{ version: 1, name: "create_marker", sql: "CREATE TABLE marker (id INTEGER PRIMARY KEY);" }]
    });

    await expect(
      applyMigrations({
        dbPath,
        backupDirectory: join(root, "backups"),
        now,
        migrations: [
          { version: 1, name: "create_marker", sql: "CREATE TABLE marker (id INTEGER PRIMARY KEY);" },
          { version: 2, name: "bad_sql", sql: "CREATE TABLE broken (" }
        ]
      })
    ).rejects.toThrow();

    const db = await openDatabase(dbPath);
    expect(readAppliedMigrations(db).map((migration) => migration.version)).toEqual([1]);
    expect(db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marker'")[0]?.values[0]?.[0]).toBe(
      "marker"
    );
    db.close();
  });
});

describe("evidence index core migration (v7)", () => {
  it("applies v7 on a fresh database and creates the additive evidence tables", async () => {
    const root = tempRoot();
    const dbPath = join(root, "sigil.db");

    const result = await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now,
      migrations: coreMigrations
    });

    expect(result.applied.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.applied.find((migration) => migration.version === 7)?.name).toBe("evidence_index_core");
    expect(result.applied.find((migration) => migration.version === 8)?.name).toBe("evidence_index_build_state");

    const db = await openDatabase(dbPath);
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'evidence_%' ORDER BY name"
    )[0];
    expect(tables?.values.flat()).toEqual([
      "evidence_analyzer_capabilities",
      "evidence_analyzer_gaps",
      "evidence_api_evidence",
      "evidence_classifications",
      "evidence_config_evidence",
      "evidence_contents",
      "evidence_edges",
      "evidence_files",
      "evidence_git_snapshots",
      "evidence_index_builds",
      "evidence_index_snapshots",
      "evidence_invalidation",
      "evidence_repositories",
      "evidence_scan_cache",
      "evidence_symbols",
      "evidence_test_associations"
    ]);
    db.close();
  });

  it("applies v8 on a pre-existing v7 database and preserves evidence rows", async () => {
    const root = tempRoot();
    const dbPath = join(root, "sigil.db");

    await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now,
      migrations: coreMigrations.filter((migration) => migration.version <= 7)
    });

    const v7Db = await openDatabase(dbPath);
    v7Db.run(
      `INSERT INTO evidence_repositories (repository_id, root_path_hash, display_name, created_at)
       VALUES ('evrepo_v7legacy', ?, 'Legacy Evidence Repo', ?)`,
      ["a".repeat(64), now().toISOString()]
    );
    saveDatabase(dbPath, v7Db);
    v7Db.close();

    const upgrade = await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now,
      migrations: coreMigrations
    });
    expect(upgrade.applied.map((migration) => migration.version)).toEqual([8, 9]);

    const reopened = await openDatabase(dbPath);
    expect(readAppliedMigrations(reopened).map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      reopened.exec("SELECT display_name FROM evidence_repositories WHERE repository_id = 'evrepo_v7legacy'")[0]
        ?.values
    ).toEqual([["Legacy Evidence Repo"]]);
    reopened.close();
  });

  it("applies v7 on a pre-existing v6 database and preserves legacy rows", async () => {
    const root = tempRoot();
    const dbPath = join(root, "sigil.db");

    await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now,
      migrations: coreMigrations.filter((migration) => migration.version <= 6)
    });

    const legacyDb = await openDatabase(dbPath);
    legacyDb.run(
      `INSERT INTO repositories (repo_id, root_path, remote_url_hash, display_name, created_at, updated_at)
       VALUES ('repo_legacy', 'C:/work/legacy', NULL, 'Legacy Repo', ?, ?)`,
      [now().toISOString(), now().toISOString()]
    );
    legacyDb.run(
      `INSERT INTO sessions (session_id, repo_id, task_key, task_source, primary_state, paused, archived, disposition, created_at, updated_at)
       VALUES ('ses_legacy', 'repo_legacy', 'ENG-13', 'manual', 'intake_ready', 0, 0, 'active', ?, ?)`,
      [now().toISOString(), now().toISOString()]
    );
    saveDatabase(dbPath, legacyDb);
    legacyDb.close();

    const upgrade = await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now,
      migrations: coreMigrations
    });

    expect(upgrade.applied.map((migration) => migration.version)).toEqual([7, 8, 9]);

    const reopened = await openDatabase(dbPath);
    expect(readAppliedMigrations(reopened).map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(
      reopened.exec("SELECT repo_id, display_name FROM repositories WHERE repo_id = 'repo_legacy'")[0]?.values
    ).toEqual([["repo_legacy", "Legacy Repo"]]);
    expect(
      reopened.exec("SELECT task_key, primary_state FROM sessions WHERE session_id = 'ses_legacy'")[0]?.values
    ).toEqual([["ENG-13", "intake_ready"]]);
    reopened.close();
  });
});
