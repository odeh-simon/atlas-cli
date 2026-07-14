import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openAtlasRuntime, startManualTask, closeAtlasRuntime } from "./index.js";
import { listArtifactsForSession, listEvents } from "@atlas/persistence";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-start-manual-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("startManualTask", () => {
  it("creates a durable manual task session with task brief artifact and event", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "atlas-home") };

    const result = await startManualTask({
      cwd,
      env,
      title: "Usage details",
      objective: "Show usage rows for admins",
      taskKey: "manual-usage"
    });

    expect(result.session.primaryState).toBe("intake_ready");
    expect(result.taskBriefArtifactId).toMatch(/^art_/);

    const runtime = await openAtlasRuntime({ cwd, env });
    expect(listArtifactsForSession(runtime.db, result.session.sessionId).map((artifact) => artifact.type)).toEqual([
      "task_brief"
    ]);
    expect(listEvents(runtime.db, result.session.sessionId).map((event) => event.eventType)).toEqual([
      "session.created"
    ]);
    closeAtlasRuntime(runtime, false);
  });

  it("resumes an existing active manual task instead of duplicating it", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "atlas-home") };

    const first = await startManualTask({ cwd, env, title: "Usage", objective: "One", taskKey: "manual-1" });
    const second = await startManualTask({ cwd, env, title: "Usage", objective: "One", taskKey: "manual-1" });

    expect(second.resumedExisting).toBe(true);
    expect(second.session.sessionId).toBe(first.session.sessionId);
  });
});
