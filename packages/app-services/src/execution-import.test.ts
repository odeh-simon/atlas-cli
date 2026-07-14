import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exportManualAgentPackage, getStatus, importExecutionResult, openAtlasRuntime } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession, listEvents } from "@atlas/persistence";
import { prepareApprovedContract } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-execution-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("importExecutionResult", () => {
  it("imports a simulated execution result without treating agent claims as completion", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    await exportManualAgentPackage({ cwd, env });
    const resultPath = join(root, "execution.json");
    writeFileSync(
      resultPath,
      JSON.stringify({
        process_status: "succeeded",
        agent_claims_complete: true,
        changed_files: ["packages/app-services/src/example.ts"],
        limitations: []
      })
    );

    const result = await importExecutionResult({ cwd, env, filePath: resultPath });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const artifacts = listArtifactsForSession(runtime.db, result.sessionId);
    const event = listEvents(runtime.db, result.sessionId).find((candidate) => candidate.eventType === "execution.imported");
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("implementation_reconciled");
    expect(result.processStatus).toBe("succeeded");
    expect(status.session?.primaryState).toBe("implementation_reconciled");
    expect(status.nextCommands[0]).toBe("atlas checks run");
    expect(artifacts.some((artifact) => artifact.type === "execution_report")).toBe(true);
    expect(event?.metadata).toMatchObject({ processStatus: "succeeded", agentClaimsComplete: true });
  });
});
