import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exportPlanningPackage, getStatus, importContextManifest, openAtlasRuntime, startManualTask } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-plan-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("exportPlanningPackage", () => {
  it("exports a deterministic planning package and advances to planning_ready", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
    const manifestPath = join(root, "context.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        sources: [{ uri: "README.md", kind: "file", reason: "Context", byte_length: 1, included: true }]
      })
    );
    await importContextManifest({ cwd, env, filePath: manifestPath });

    const result = await exportPlanningPackage({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const planning = listArtifactsForSession(runtime.db, result.sessionId).find(
      (artifact) => artifact.artifactId === result.planningArtifactId
    );
    const content = readFileSync(join(runtime.paths.artifactRoot, planning?.storageUri ?? ""), "utf8");
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("planning_ready");
    expect(status.session?.primaryState).toBe("planning_ready");
    expect(status.nextCommands[0]).toBe("atlas contract import <file>");
    expect(content).toContain("# Atlas Planning Package");
    expect(content).toContain("Context manifest:");
  });
});
