import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, openAtlasRuntime, runBasicCheck } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareApprovedContract, prepareExecution } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-checks-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runBasicCheck", () => {
  it("passes with an approved contract and execution report", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);

    const result = await runBasicCheck({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const checkArtifacts = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "check_result"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.status).toBe("passed");
    expect(result.checkCount).toBe(1);
    expect(result.state).toBe("checks_completed");
    expect(status.session?.primaryState).toBe("checks_completed");
    expect(status.nextCommands[0]).toBe("atlas review prepare");
    expect(checkArtifacts).toHaveLength(1);
  });

  it("fails before an execution report is imported", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);

    await expect(runBasicCheck({ cwd, env })).rejects.toThrow("Required check failed");
  });

  it("runs configured process checks after built-in integrity passes", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    writeFileSync(
      join(cwd, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        checks: [
          {
            name: "node-smoke",
            required: true,
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
            dependsOn: ["basic-session-integrity"]
          }
        ]
      })
    );

    const result = await runBasicCheck({ cwd, env });

    expect(result.status).toBe("passed");
    expect(result.checkCount).toBe(2);
  });
});
