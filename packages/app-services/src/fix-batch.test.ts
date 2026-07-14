import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, openAtlasRuntime, prepareFixBatch } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareReviewImported } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-fix-batch-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("prepareFixBatch", () => {
  it("creates a fix batch from open actionable findings", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewImported(root);

    const result = await prepareFixBatch({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const fixBatches = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "fix_batch"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("fix_ready");
    expect(result.findingIds).toEqual(["REV-001"]);
    expect(status.nextCommands[0]).toBe("atlas implement export --manual");
    expect(fixBatches).toHaveLength(1);
  });
});
