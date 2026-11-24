import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CancellationError } from "@sigil/domain";
import {
  getEvidenceIndexSnapshotPayload,
  readCurrentIndexSnapshot,
  saveDatabase
} from "@sigil/persistence";

import { updateEvidenceIndex } from "./engine.js";

const tempRoots: string[] = [];
const NOW = () => new Date("2026-08-05T06:00:00.000Z");
const TARGET_FILES = 2000;

function tempRoot(prefix = "sigil-evidence-large-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

interface FixtureStats {
  readonly filesWritten: number;
  readonly secretFiles: number;
  readonly binaryFiles: number;
  readonly largeFiles: number;
}

function generateFixture(root: string, count = TARGET_FILES): FixtureStats {
  let filesWritten = 0;
  let secretFiles = 0;
  let binaryFiles = 0;
  let largeFiles = 0;

  for (let index = 0; index < count; index += 1) {
    const bucket = index % 20;
    let path: string;
    let content: string;

    if (index % 400 === 0) {
      path = `src/large-${index}.ts`;
      content = `// large fixture ${index}\n${"export const filler = 1;\n".repeat(2600)}`;
      largeFiles += 1;
    } else if (bucket === 3) {
      path = `secrets/credentials-${index}.json`;
      content = `{"token": "redacted-secret-${index}"}` + "\n";
      secretFiles += 1;
    } else if (bucket === 7) {
      path = `assets/payload-${index}.txt`;
      content = `binary-${index}\u0000${"x".repeat(64)}\n`;
      binaryFiles += 1;
    } else if (index % 5 === 0) {
      path = `tests/unit-${index}.test.ts`;
      content = `import { value } from "../src/mod-${index}";\nvalue(${index});\n`;
    } else {
      path = `src/mod-${index}.ts`;
      content = `export const value_${index} = ${index};\n`;
    }

    const target = join(root, ...path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
    filesWritten += 1;
  }

  return { filesWritten, secretFiles, binaryFiles, largeFiles };
}

describe.skipIf(!commandSucceedsGit())("large fixture performance and safety", () => {
  it("builds, reuses, and incrementally updates a ~2000-file repository within budget", async () => {
    const repo = tempRoot();
    const stats = generateFixture(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "Sigil Test"]);
    git(repo, ["config", "user.email", "sigil@example.test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "fixture"]);

    const opened = await openEngineDbSafe(repo);

    const fullStart = performance.now();
    const full = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const fullMs = Math.round(performance.now() - fullStart);
    saveDatabase(opened.dbPath, opened.db);

    expect(full.metrics.outcome).toBe("updated");
    expect(full.metrics.filesScanned).toBe(stats.filesWritten);

    const payloadAfterFull = getEvidenceIndexSnapshotPayload(opened.db, full.snapshotId as string)?.payload;
    const payloadBytes = JSON.stringify(payloadAfterFull ?? {}).length;

    const reuseStart = performance.now();
    const reused = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const reuseMs = Math.round(performance.now() - reuseStart);
    saveDatabase(opened.dbPath, opened.db);

    expect(reused.metrics.outcome).toBe("reused");

    writeFileSync(join(repo, "src/mod-11.ts"), "export const value_11 = 1100;\n");
    const incrementalStart = performance.now();
    const incremental = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const incrementalMs = Math.round(performance.now() - incrementalStart);
    saveDatabase(opened.dbPath, opened.db);

    expect(incremental.metrics.changed).toBe(1);
    expect(incremental.metrics.added).toBe(0);

    const dbBytes = statSync(opened.dbPath).size;

    console.info("[evidence-index benchmark]", {
      files: stats.filesWritten,
      secrets: stats.secretFiles,
      binaries: stats.binaryFiles,
      largeFiles: stats.largeFiles,
      fullBuildMs: fullMs,
      fullFilesPerSec: Math.round((stats.filesWritten / Math.max(1, fullMs)) * 1000),
      incrementalMs,
      tierZeroReuseMs: reuseMs,
      payloadJsonBytes: payloadBytes,
      exportedDbBytes: dbBytes
    });

    expect(fullMs).toBeLessThan(120_000);
    expect(incrementalMs).toBeLessThan(fullMs);
  }, 180_000);

  it("cancels a large build mid-scan without promoting anything", async () => {
    const repo = tempRoot();
    generateFixture(repo, 600);
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "Sigil Test"]);
    git(repo, ["config", "user.email", "sigil@example.test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "fixture"]);

    const opened = await openEngineDbSafe(repo);
    const controller = new AbortController();

    expect(() =>
      updateEvidenceIndex(opened.db, {
        rootPath: repo,
        dbPath: opened.dbPath,
        now: NOW,
        signal: controller.signal,
        onScanProgress: (filesProcessed) => {
          if (filesProcessed >= 50) controller.abort();
        }
      })
    ).toThrow(CancellationError);

    saveDatabase(opened.dbPath, opened.db);

    expect(readCurrentIndexSnapshot(opened.db, "")).toBeUndefined();

    const reopened = await openEngineDbSafe(repo);
    reopened.db.close();
  }, 60_000);

  it("keeps concurrent readers valid while another connection builds and saves", async () => {
    const repo = tempRoot();
    generateFixture(repo, 300);
    git(repo, ["init"]);
    git(repo, ["config", "user.name", "Sigil Test"]);
    git(repo, ["config", "user.email", "sigil@example.test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "fixture"]);

    await migrateEngineDb(repo);
    const writer = await openExistingEngineDb(repo);
    const readerA = await openExistingEngineDb(repo);
    const readerB = await openExistingEngineDb(repo);
    readerA.db.close();
    readerB.db.close();

    const build = updateEvidenceIndex(writer.db, {
      rootPath: repo,
      dbPath: writer.dbPath,
      now: NOW
    });
    saveDatabase(writer.dbPath, writer.db);
    writer.db.close();

    const reopenedA = await openExistingEngineDb(repo);
    const reopenedB = await openExistingEngineDb(repo);
    const fromA = readCurrentIndexSnapshot(reopenedA.db, build.repositoryId);
    const fromB = readCurrentIndexSnapshot(reopenedB.db, build.repositoryId);

    expect(fromA?.snapshot.snapshot_id).toBe(build.snapshotId);
    expect(fromB?.payload.files.length).toBe(fromA?.payload.files.length);
    expect(() => getEvidenceIndexSnapshotPayload(reopenedA.db, fromA?.snapshot.snapshot_id as string)).not.toThrow();

    reopenedA.db.close();
    reopenedB.db.close();
  }, 60_000);
});

function commandSucceedsGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function openEngineDbSafe(root: string): Promise<{ dbPath: string; db: Awaited<ReturnType<typeof import("@sigil/persistence").openDatabase>> }> {
  await migrateEngineDb(root);
  return openExistingEngineDb(root);
}

function evidenceDbPathFor(root: string): string {
  const dataDir = join(tmpdir(), `sigil-evdb-lg-${basename(root)}`);
  mkdirSync(dataDir, { recursive: true });
  tempRoots.push(dataDir);
  return join(dataDir, "sigil.db");
}

async function migrateEngineDb(root: string): Promise<void> {
  const { applyMigrations, coreMigrations } = await import("@sigil/persistence");
  await applyMigrations({
    dbPath: evidenceDbPathFor(root),
    backupDirectory: join(dirname(evidenceDbPathFor(root)), "backups"),
    now: NOW,
    migrations: coreMigrations
  });
}

async function openExistingEngineDb(root: string): Promise<{ dbPath: string; db: Awaited<ReturnType<typeof import("@sigil/persistence").openDatabase>> }> {
  const { openDatabase } = await import("@sigil/persistence");
  const dbPath = evidenceDbPathFor(root);
  return { dbPath, db: await openDatabase(dbPath) };
}
