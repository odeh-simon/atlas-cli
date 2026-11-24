import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, openSigilRuntime, prepareFixBatch } from "./index.js";
import { closeSigilRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@sigil/persistence";
import { prepareReviewImported } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-fix-batch-"));
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
    const runtime = await openSigilRuntime({ cwd, env });
    const fixBatches = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "fix_batch"
    );
    closeSigilRuntime(runtime, false);

    expect(result.state).toBe("fix_ready");
    expect(result.findingIds).toEqual(["REV-001"]);
    expect(status.nextCommands[0]).toBe("sigil implement export --manual");
    expect(fixBatches).toHaveLength(1);
  });
});
