import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { applyMigrations, coreMigrations, openDatabase, saveDatabase, type SqlDatabase } from "@sigil/persistence";

export interface SigilPaths {
  readonly cwd: string;
  readonly dataRoot: string;
  readonly dbPath: string;
  readonly backupDirectory: string;
  readonly artifactRoot: string;
}

export interface SigilRuntime {
  readonly paths: SigilPaths;
  readonly db: SqlDatabase;
}

export interface RuntimeOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export function resolveSigilPaths(options: RuntimeOptions = {}): SigilPaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const dataRoot = resolve(env.SIGIL_HOME ?? defaultDataRoot());

  return {
    cwd,
    dataRoot,
    dbPath: join(dataRoot, "sigil.db"),
    backupDirectory: join(dataRoot, "backups"),
    artifactRoot: join(dataRoot, "artifacts")
  };
}

export async function openSigilRuntime(options: RuntimeOptions = {}): Promise<SigilRuntime> {
  const paths = resolveSigilPaths(options);
  mkdirSync(paths.dataRoot, { recursive: true });
  await applyMigrations({
    dbPath: paths.dbPath,
    backupDirectory: paths.backupDirectory,
    migrations: coreMigrations,
    now: () => new Date()
  });
  return {
    paths,
    db: await openDatabase(paths.dbPath)
  };
}

export function closeSigilRuntime(runtime: SigilRuntime, save = true): void {
  if (save) {
    saveDatabase(runtime.paths.dbPath, runtime.db);
  }
  runtime.db.close();
}

export function repoIdForPath(path: string): string {
  return `repo_${createHash("sha256").update(resolve(path), "utf8").digest("hex").slice(0, 16)}`;
}

export function repoDisplayName(path: string): string {
  return basename(resolve(path)) || "repository";
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function defaultDataRoot(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Sigil");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Sigil");
  }

  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "sigil");
}
