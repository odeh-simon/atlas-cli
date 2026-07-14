import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from "sql.js";

const require = createRequire(import.meta.url);
let sqlJsPromise: Promise<SqlJsStatic> | undefined;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  readonly applied: readonly AppliedMigration[];
  readonly backupPath: string | undefined;
}

export interface ApplyMigrationsOptions {
  readonly dbPath: string;
  readonly backupDirectory: string;
  readonly migrations: readonly Migration[];
  readonly now: () => Date;
}

export const schemaMigrationsSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back', 'failed'))
);
`;

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`, "utf8")
    .digest("hex");
}

export async function openDatabase(dbPath: string): Promise<SqlDatabase> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const SQL = await loadSqlJs();
  const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
  db.run("PRAGMA foreign_keys = ON;");
  return db;
}

export function readAppliedMigrations(db: SqlDatabase): AppliedMigration[] {
  db.run(schemaMigrationsSql);
  const result = db.exec(
    "SELECT version, name, checksum, applied_at AS appliedAt FROM schema_migrations WHERE status = 'applied' ORDER BY version"
  )[0];

  if (result === undefined) {
    return [];
  }

  return result.values.map((values) => {
    const record = Object.fromEntries(result.columns.map((column, index) => [column, values[index]]));
    return {
      version: Number(record.version),
      name: String(record.name),
      checksum: String(record.checksum),
      appliedAt: String(record.appliedAt)
    };
  });
}

export async function applyMigrations(options: ApplyMigrationsOptions): Promise<MigrationResult> {
  validateMigrationOrder(options.migrations);
  mkdirSync(dirname(options.dbPath), { recursive: true });
  mkdirSync(options.backupDirectory, { recursive: true });

  const databaseExisted = existsSync(options.dbPath);
  const backupPath = databaseExisted
    ? join(options.backupDirectory, `${options.now().toISOString().replace(/[:.]/g, "-")}-pre-migration.db`)
    : undefined;

  if (backupPath !== undefined) {
    copyFileSync(options.dbPath, backupPath);
  }

  const db = await openDatabase(options.dbPath);
  const applied: AppliedMigration[] = [];

  try {
    db.run(schemaMigrationsSql);
    const appliedByVersion = new Map(readAppliedMigrations(db).map((migration) => [migration.version, migration]));

    for (const migration of options.migrations) {
      const checksum = migrationChecksum(migration);
      const prior = appliedByVersion.get(migration.version);

      if (prior !== undefined) {
        if (prior.checksum !== checksum || prior.name !== migration.name) {
          throw new Error(`Migration ${migration.version} was already applied with different content`);
        }
        continue;
      }

      const appliedAt = options.now().toISOString();
      db.run("BEGIN IMMEDIATE;");
      try {
        db.run(migration.sql);
        db.run(
          "INSERT INTO schema_migrations (version, name, applied_at, checksum, status) VALUES (?, ?, ?, ?, 'applied')",
          [migration.version, migration.name, appliedAt, checksum]
        );
        db.run("COMMIT;");
      } catch (error) {
        db.run("ROLLBACK;");
        throw error;
      }

      const record = { version: migration.version, name: migration.name, checksum, appliedAt };
      applied.push(record);
      appliedByVersion.set(migration.version, record);
    }
  } catch (error) {
    db.close();
    restoreBackup(options.dbPath, backupPath);
    throw error;
  }

  saveDatabase(options.dbPath, db);
  db.close();
  return { applied, backupPath };
}

export function saveDatabase(dbPath: string, db: SqlDatabase): void {
  writeDatabaseAtomic(dbPath, db);
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
  });

  return sqlJsPromise;
}

function writeDatabaseAtomic(dbPath: string, db: SqlDatabase): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const tempPath = `${dbPath}.tmp`;
  writeFileSync(tempPath, db.export());
  renameSync(tempPath, dbPath);
}

function validateMigrationOrder(migrations: readonly Migration[]): void {
  let lastVersion = 0;
  const seen = new Set<number>();

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new TypeError("Migration versions must be positive integers");
    }

    if (seen.has(migration.version)) {
      throw new TypeError(`Duplicate migration version: ${migration.version}`);
    }

    if (migration.version <= lastVersion) {
      throw new TypeError("Migrations must be sorted by ascending version");
    }

    if (migration.name.trim().length === 0) {
      throw new TypeError("Migration names must be non-empty");
    }

    seen.add(migration.version);
    lastVersion = migration.version;
  }
}

function restoreBackup(dbPath: string, backupPath: string | undefined): void {
  if (backupPath === undefined) {
    rmSync(dbPath, { force: true });
    return;
  }

  const failedPath = `${dbPath}.failed`;
  rmSync(failedPath, { force: true });
  if (existsSync(dbPath)) {
    renameSync(dbPath, failedPath);
  }
  copyFileSync(backupPath, dbPath);
}
