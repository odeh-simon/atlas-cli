import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { applyMigrations, coreMigrations, openDatabase, saveDatabase, type SqlDatabase } from "@atlas/persistence";

export interface AtlasPaths {
  readonly cwd: string;
  readonly dataRoot: string;
  readonly dbPath: string;
  readonly backupDirectory: string;
  readonly artifactRoot: string;
}

export interface AtlasRuntime {
  readonly paths: AtlasPaths;
  readonly db: SqlDatabase;
}

export interface RuntimeOptions {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export function resolveAtlasPaths(options: RuntimeOptions = {}): AtlasPaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const dataRoot = resolve(env.ATLAS_HOME ?? defaultDataRoot());

  return {
    cwd,
    dataRoot,
    dbPath: join(dataRoot, "atlas.db"),
    backupDirectory: join(dataRoot, "backups"),
    artifactRoot: join(dataRoot, "artifacts")
  };
}

export async function openAtlasRuntime(options: RuntimeOptions = {}): Promise<AtlasRuntime> {
  const paths = resolveAtlasPaths(options);
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

export function closeAtlasRuntime(runtime: AtlasRuntime, save = true): void {
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
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Atlas");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Atlas");
  }

  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "atlas");
}
