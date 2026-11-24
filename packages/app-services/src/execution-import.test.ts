import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exportManualAgentPackage, getStatus, importExecutionResult, openSigilRuntime } from "./index.js";
import { closeSigilRuntime } from "./runtime.js";
import { listArtifactsForSession, listEvents } from "@sigil/persistence";
import { prepareApprovedContract } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-execution-"));
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
    const runtime = await openSigilRuntime({ cwd, env });
    const artifacts = listArtifactsForSession(runtime.db, result.sessionId);
    const event = listEvents(runtime.db, result.sessionId).find((candidate) => candidate.eventType === "execution.imported");
    closeSigilRuntime(runtime, false);

    expect(result.state).toBe("implementation_reconciled");
    expect(result.processStatus).toBe("succeeded");
    expect(status.session?.primaryState).toBe("implementation_reconciled");
    expect(status.nextCommands[0]).toBe("sigil checks run");
    expect(artifacts.some((artifact) => artifact.type === "execution_report")).toBe(true);
    const execution = artifacts.find((artifact) => artifact.artifactId === result.executionReportArtifactId);
    const report = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, execution?.storageUri ?? ""), "utf8")) as Record<string, any>;
    expect(report).toMatchObject({
      schema_version: 2,
      implementation_package_artifact_id: expect.stringMatching(/^art_/),
      implementation_package_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      contract_artifact_id: expect.stringMatching(/^art_/),
      contract_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      context_content_pack_artifact_id: expect.stringMatching(/^art_/),
      context_content_pack_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(event?.metadata).toMatchObject({ processStatus: "succeeded", agentClaimsComplete: true });
  });

  it("rejects manual execution evidence when the recorded package Git base changed", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    await exportManualAgentPackage({ cwd, env });
    execFileSync("git", ["checkout", "-b", "manual-other-branch"], { cwd, stdio: "ignore" });
    const resultPath = join(root, "execution.json");
    writeFileSync(resultPath, JSON.stringify({ process_status: "succeeded", limitations: [] }));

    await expect(importExecutionResult({ cwd, env, filePath: resultPath })).rejects.toThrow(
      "branch, HEAD, or repository root changed"
    );
  });
});
