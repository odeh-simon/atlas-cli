import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  archiveSession,
  cancelSession,
  getStatus,
  importContextManifest,
  pauseSession,
  resumePausedSession,
  startManualTask,
  unarchiveSession
} from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-lifecycle-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("lifecycle overlays", () => {
  it("pauses progression until the session is resumed", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareStartedSession(root);
    const manifestPath = writeContextManifest(root);

    const paused = await pauseSession({ cwd, env, reason: "Operator break" });
    const pausedStatus = await getStatus({ cwd, env });

    await expect(importContextManifest({ cwd, env, filePath: manifestPath })).rejects.toThrow("Session is paused");

    const resumed = await resumePausedSession({ cwd, env });
    const imported = await importContextManifest({ cwd, env, filePath: manifestPath });

    expect(paused.session.paused).toBe(true);
    expect(pausedStatus.nextCommands).toEqual(["atlas resume"]);
    expect(resumed.session.paused).toBe(false);
    expect(imported.state).toBe("context_ready");
  });

  it("archives progression until the session is unarchived", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareStartedSession(root);
    const manifestPath = writeContextManifest(root);

    const archived = await archiveSession({ cwd, env, reason: "Keep for later" });
    const archivedStatus = await getStatus({ cwd, env });

    await expect(importContextManifest({ cwd, env, filePath: manifestPath })).rejects.toThrow("Session is archived");

    const unarchived = await unarchiveSession({ cwd, env });
    const imported = await importContextManifest({ cwd, env, filePath: manifestPath });

    expect(archived.session.archived).toBe(true);
    expect(archivedStatus.nextCommands).toEqual(["atlas unarchive"]);
    expect(unarchived.session.archived).toBe(false);
    expect(imported.state).toBe("context_ready");
  });

  it("cancels progression without removing repository files", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareStartedSession(root);
    const sentinelPath = join(cwd, "README.md");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(sentinelPath, "fixture\n");
    const manifestPath = writeContextManifest(root);

    const cancelled = await cancelSession({ cwd, env, reason: "No longer needed" });
    const status = await getStatus({ cwd, env });

    await expect(importContextManifest({ cwd, env, filePath: manifestPath })).rejects.toThrow(
      "Session disposition blocks progression: cancelled"
    );

    expect(cancelled.session.disposition).toBe("cancelled");
    expect(cancelled.session.closedAt).toBeDefined();
    expect(status.nextCommands).toHaveLength(0);
    expect(existsSync(sentinelPath)).toBe(true);
  });
});

async function prepareStartedSession(root: string) {
  const cwd = join(root, "repo");
  const env = { ATLAS_HOME: join(root, "home") };
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "README.md"), "fixture\n");
  await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
  return { cwd, env };
}

function writeContextManifest(root: string): string {
  const manifestPath = join(root, "context.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      sources: [{ uri: "README.md", kind: "file", reason: "Context", byte_length: 1, included: true }]
    })
  );
  return manifestPath;
}
