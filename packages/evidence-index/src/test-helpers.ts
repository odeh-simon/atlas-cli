import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyMigrations, coreMigrations, openDatabase } from "@atlas/persistence";

export const NOW = () => new Date("2026-08-01T12:00:00.000Z");

const tempRoots: string[] = [];

function tempRoot(prefix = "atlas-evidence-engine-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commandSucceeds(args: readonly string[]): boolean {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const gitAvailable = commandSucceeds(["--version"]);

export interface OpenedEngineDb {
  readonly dbPath: string;
  readonly db: Awaited<ReturnType<typeof openDatabase>>;
}

export function evidenceDbPathFor(repoPath: string): string {
  const dataDir = join(tmpdir(), `atlas-evdb-${basename(repoPath)}`);
  mkdirSync(dataDir, { recursive: true });
  registerTempRoot(dataDir);
  return join(dataDir, "atlas.db");
}

export async function openEngineDb(repoPath: string): Promise<OpenedEngineDb> {
  const dbPath = evidenceDbPathFor(repoPath);
  await applyMigrations({
    dbPath,
    backupDirectory: join(dirname(dbPath), "backups"),
    now: NOW,
    migrations: coreMigrations
  });
  return { dbPath, db: await openDatabase(dbPath) };
}

export function createCommittedRepo(files: Record<string, string>): string {
  const repo = tempRoot();
  git(repo, ["init"]);
  git(repo, ["checkout", "-b", "main"]);
  git(repo, ["config", "user.name", "Atlas Test"]);
  git(repo, ["config", "user.email", "atlas@example.test"]);
  for (const [path, content] of Object.entries(files)) {
    writeRepoFile(repo, path, content);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

export function writeRepoFile(repo: string, path: string, content: string): void {
  const target = join(repo, ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

export function registerTempRoot(root: string): void {
  tempRoots.push(root);
}

export function cleanupTempRoots(): void {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}
