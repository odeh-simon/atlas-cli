import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, openAtlasRuntime, prepareReviewPackage } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareCheckedImplementation, prepareExecution } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-review-prepare-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("prepareReviewPackage", () => {
  it("creates a review package after checks pass", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareCheckedImplementation(root);

    const result = await prepareReviewPackage({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const reviewPackages = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "review_package"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("review_ready");
    expect(status.session?.primaryState).toBe("review_ready");
    expect(status.nextCommands[0]).toBe("atlas review import <file>");
    expect(reviewPackages).toHaveLength(1);
  });

  it("blocks review preparation before checks pass", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);

    await expect(prepareReviewPackage({ cwd, env })).rejects.toThrow(
      "Review package requires approved contract, execution report, and passing check result"
    );
  });
});
