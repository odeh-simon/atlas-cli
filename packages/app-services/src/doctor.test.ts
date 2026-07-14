import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, openAtlasRuntime, runDoctor } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareApprovedContract } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-doctor-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runDoctor", () => {
  it("passes on intact session artifacts", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);

    const result = await runDoctor({ cwd, env });

    expect(result.status).toBe("passed");
    expect(result.issues).toHaveLength(0);
    expect(result.artifactCount).toBeGreaterThan(0);
  });

  it("detects artifact hash mismatches without mutating state", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    if (status.session === undefined) throw new Error("Expected session fixture");
    const artifact = listArtifactsForSession(runtime.db, status.session.sessionId)[0];
    if (artifact === undefined) throw new Error("Expected artifact fixture");
    const path = join(runtime.paths.artifactRoot, artifact.storageUri);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}\ncorrupt\n`);
    closeAtlasRuntime(runtime, false);

    const result = await runDoctor({ cwd, env });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain("artifact.hash_mismatch");
  });
});
