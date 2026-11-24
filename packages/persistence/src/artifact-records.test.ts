import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  addArtifactDependency,
  applyMigrations,
  coreMigrations,
  createArtifactRecord,
  createRepository,
  createSession,
  getArtifactRecord,
  listArtifactDependencies,
  listArtifactsForSession,
  openDatabase
} from "./index.js";

const tempRoots: string[] = [];
const now = "2026-07-12T12:00:00.000Z";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-artifact-records-"));
  tempRoots.push(root);
  return root;
}

async function openSessionDb(root: string) {
  const dbPath = join(root, "sigil.db");
  await applyMigrations({
    dbPath,
    backupDirectory: join(root, "backups"),
    now: () => new Date(now),
    migrations: coreMigrations
  });
  const db = await openDatabase(dbPath);
  createRepository(db, { repoId: "repo_1", rootPath: "C:/work/repo", displayName: "Pilot Repo", now });
  createSession(db, {
    sessionId: "ses_1",
    repoId: "repo_1",
    taskSource: "manual",
    primaryState: "intake_ready",
    now
  });
  return db;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("artifact metadata records", () => {
  it("creates artifact metadata and dependency records", async () => {
    const db = await openSessionDb(tempRoot());

    const parent = createArtifactRecord(db, {
      artifactId: "art_parent",
      sessionId: "ses_1",
      type: "task_brief",
      schemaVersion: 1,
      contentVersion: 1,
      storageUri: "ses_1/task_brief/1-parent.md",
      sha256: "a".repeat(64),
      byteLength: 12,
      mediaType: "text/markdown",
      sensitivity: "internal",
      status: "valid",
      producerType: "sigil",
      createdAt: now
    });
    const child = createArtifactRecord(db, {
      artifactId: "art_child",
      sessionId: "ses_1",
      type: "planning_package_metadata",
      schemaVersion: 1,
      contentVersion: 1,
      storageUri: "ses_1/planning_package_metadata/1-child.json",
      sha256: "b".repeat(64),
      byteLength: 24,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "draft",
      producerType: "sigil",
      createdAt: now
    });

    addArtifactDependency(db, {
      artifactId: child.artifactId,
      dependsOnArtifactId: parent.artifactId,
      dependencyKind: "input"
    });

    expect(getArtifactRecord(db, "art_parent")).toEqual(parent);
    expect(listArtifactsForSession(db, "ses_1").map((artifact) => artifact.artifactId)).toEqual([
      "art_child",
      "art_parent"
    ]);
    expect(listArtifactDependencies(db, "art_child")).toEqual([
      {
        artifactId: "art_child",
        dependsOnArtifactId: "art_parent",
        dependencyKind: "input"
      }
    ]);

    db.close();
  });
});
