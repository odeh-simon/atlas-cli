import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
      agentClaimsComplete: false,
      state: "implementation_reconciled",
      nextCommand: "atlas checks run"
    });
    expect(result.agentRunLogArtifactId).toMatch(/^art_/);
    expect(result.executionReportArtifactId).toMatch(/^art_/);

    const status = await getStatus(prepared);
    expect(status.session?.primaryState).toBe("implementation_reconciled");
    expect(status.artifactCount).toBeGreaterThanOrEqual(7);
  });

  it("records an agent run log and parses explicit completion reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-agent-invoke-"));
    const prepared = await prepareApprovedContract(root);
    const exported = await exportManualAgentPackage(prepared);

    const result = await invokeImplementationAgent({
      ...prepared,
      provider: "codex",
      agentInvoker: async (input) => ({
        provider: "codex",
        process: {
          runId: "run_mock_agent",
          command: input.command ?? "codex",
          args: ["--prompt", "redacted-test-payload"],
          cwd: input.package.cwd,
          status: "succeeded",
          exitCode: 0,
          signal: undefined,
          stdout:
            'ATLAS_EXECUTION_REPORT_JSON: {"agent_claims_complete":true,"changed_files":["src/table-cell.tsx"],"limitations":[]}',
          stderr: "",
          timedOut: false,
          startedAt: "2026-07-12T12:00:00.000Z",
          endedAt: "2026-07-12T12:00:01.000Z",
          durationMs: 1_000,
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false
        }
      })
    });

    expect(result).toMatchObject({
      provider: "codex",
      packageArtifactId: exported.packageArtifactId,
      processStatus: "succeeded",
      agentClaimsComplete: true,
      changedFiles: ["src/table-cell.tsx"]
    });

    const runLog = readLatestJsonArtifact(root, result.sessionId, "agent_run_log");
    expect(runLog.artifact_id).toBe(result.agentRunLogArtifactId);
    expect(runLog.run_id).toBe("run_mock_agent");
    expect(runLog.package_artifact_id).toBe(exported.packageArtifactId);
    expect(runLog.process.status).toBe("succeeded");
    expect(runLog.parsed_completion_report.agent_claims_complete).toBe(true);
  });
});

function failingCommand(): string {
  return process.platform === "win32" ? "git" : process.execPath;
}

function readLatestJsonArtifact(root: string, sessionId: string, type: string): Record<string, any> {
  const artifactDir = join(root, "home", "artifacts", sessionId, type);
  const files = readdirSync(artifactDir).sort();
  const latest = files.at(-1);
  if (latest === undefined) throw new Error(`No ${type} artifact found`);
  return JSON.parse(readFileSync(join(artifactDir, latest), "utf8")) as Record<string, any>;
}
