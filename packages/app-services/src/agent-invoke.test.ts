import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { exportManualAgentPackage, getStatus, invokeImplementationAgent } from "./index.js";
import { prepareApprovedContract } from "./test-support.js";

describe("invokeImplementationAgent", () => {
  it("invokes an exported implementation package and records an execution report", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-agent-invoke-"));
    const prepared = await prepareApprovedContract(root);
    const exported = await exportManualAgentPackage(prepared);

    const result = await invokeImplementationAgent({
      ...prepared,
      provider: "codex",
      command: failingCommand(),
      timeoutMs: 10_000
    });

    expect(result).toMatchObject({
      provider: "codex",
      packageArtifactId: exported.packageArtifactId,
      processStatus: "failed",
      state: "implementation_reconciled",
      nextCommand: "atlas checks run"
    });
    expect(result.executionReportArtifactId).toMatch(/^art_/);

    const status = await getStatus(prepared);
    expect(status.session?.primaryState).toBe("implementation_reconciled");
    expect(status.artifactCount).toBeGreaterThanOrEqual(6);
  });
});

function failingCommand(): string {
  return process.platform === "win32" ? "git" : process.execPath;
}
