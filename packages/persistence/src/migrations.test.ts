import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, openDatabase, readAppliedMigrations } from "./index.js";

const tempRoots: string[] = [];
const now = () => new Date("2026-07-12T12:00:00.000Z");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-persistence-"));
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
    const dbPath = join(root, "atlas.db");
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
    const dbPath = join(root, "atlas.db");
    const migrations = [{ version: 1, name: "create_marker", sql: "CREATE TABLE marker (id INTEGER PRIMARY KEY);" }];

    await applyMigrations({ dbPath, backupDirectory: join(root, "backups"), now, migrations });
    const second = await applyMigrations({ dbPath, backupDirectory: join(root, "backups"), now, migrations });

    expect(second.applied).toEqual([]);
    expect(second.backupPath).toContain("pre-migration.db");
  });

  it("restores the previous database when a migration fails", async () => {
    const root = tempRoot();
    const dbPath = join(root, "atlas.db");
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
