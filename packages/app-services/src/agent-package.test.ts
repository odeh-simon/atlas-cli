import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exportManualAgentPackage, getStatus, openAtlasRuntime } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareApprovedContract } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-agent-package-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("exportManualAgentPackage", () => {
  it("exports a package from an approved contract and advances state", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);

    const result = await exportManualAgentPackage({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const artifact = listArtifactsForSession(runtime.db, result.sessionId).find(
      (candidate) => candidate.artifactId === result.packageArtifactId
    );
    const content = readFileSync(join(runtime.paths.artifactRoot, artifact?.storageUri ?? ""), "utf8");
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("implementation_ready");
    expect(status.session?.primaryState).toBe("implementation_ready");
    expect(status.nextCommands[0]).toBe("atlas execution import <file>");
    expect(content).toContain("# Atlas Manual Agent Package");
  });
});
