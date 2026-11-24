import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, startManualTask } from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-status-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("status", () => {
  it("recommends start when no session exists", async () => {
    const root = tempRoot();
    const status = await getStatus({ cwd: join(root, "repo"), env: { SIGIL_HOME: join(root, "home") } });

    expect(status.session).toBeUndefined();
    expect(status.nextCommands[0]).toContain("sigil start --manual");
  });

  it("reports the latest session and next action", async () => {
    const root = tempRoot();
    const options = { cwd: join(root, "repo"), env: { SIGIL_HOME: join(root, "home") } };
    const started = await startManualTask({
      ...options,
      title: "Usage",
      objective: "Show usage",
      taskKey: "manual-usage"
    });

    const status = await getStatus(options);

    expect(status.session?.sessionId).toBe(started.session.sessionId);
    expect(status.artifactCount).toBe(1);
    expect(status.eventCount).toBe(1);
    expect(status.nextCommands).toEqual(["sigil context import <file>"]);
  });
});
