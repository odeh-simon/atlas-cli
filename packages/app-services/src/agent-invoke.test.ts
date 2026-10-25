import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { exportManualAgentPackage, getStatus, invokeImplementationAgent, openAtlasRuntime } from "./index.js";
import { prepareApprovedContract } from "./test-support.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";

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
  }, 30_000);

  it.each([
    ["secret", ".env", "API_TOKEN=sk_abcdefghijklmnop\n"],
    ["binary", "asset.bin", Buffer.from([0, 1, 2, 3])]
  ] as const)("rejects a non-reviewable %s implementation diff without storing its contents", async (_kind, path, content) => {
    const root = mkdtempSync(join(tmpdir(), "atlas-agent-invoke-"));
    const prepared = await prepareApprovedContract(root);
    await exportManualAgentPackage(prepared);

    await expect(
      invokeImplementationAgent({
        ...prepared,
        provider: "codex",
        agentInvoker: async (input) => {
          writeFileSync(join(input.package.cwd, path), content);
          return {
            provider: "codex",
            process: {
              runId: `run_${_kind}`,
              command: "codex",
              args: [],
              cwd: input.package.cwd,
              status: "succeeded",
              exitCode: 0,
              signal: undefined,
              stdout: "",
              stderr: "",
              timedOut: false,
              startedAt: "2026-07-12T12:00:00.000Z",
              endedAt: "2026-07-12T12:00:01.000Z",
              durationMs: 1_000,
              stdoutTruncated: false,
              stderrTruncated: false,
              redacted: false
            }
          };
        }
      })
    ).rejects.toThrow("Implementation diff is not safely reviewable");

    const runtime = await openAtlasRuntime(prepared);
    try {
      const status = await getStatus(prepared);
      const diffRecord = listArtifactsForSession(runtime.db, status.session?.sessionId ?? "")
        .find((artifact) => artifact.type === "implementation_diff");
      expect(diffRecord?.status).toBe("rejected");
      const diff = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, diffRecord?.storageUri ?? ""), "utf8")) as {
        patch: string;
        has_binary: boolean;
        has_secret_risk: boolean;
      };
      expect(diff.patch).not.toContain("sk_abcdefghijklmnop");
      expect(diff.has_binary || diff.has_secret_risk).toBe(true);
    } finally {
      closeAtlasRuntime(runtime, false);
    }
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
      changedFiles: []
    });

    const runLog = readLatestJsonArtifact(root, result.sessionId, "agent_run_log");
    expect(runLog.artifact_id).toBe(result.agentRunLogArtifactId);
    expect(runLog.run_id).toBe("run_mock_agent");
    expect(runLog.package_artifact_id).toBe(exported.packageArtifactId);
    expect(runLog.process.status).toBe("succeeded");
    expect(runLog.parsed_completion_report.agent_claims_complete).toBe(true);
  });

  it("fails on a dirty worktree before invoking the implementation agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-agent-invoke-"));
    const prepared = await prepareApprovedContract(root);
    await exportManualAgentPackage(prepared);
    writeFileSync(join(prepared.cwd, "unexpected.ts"), "export const unexpected = true;\n");
    let invoked = false;

    await expect(invokeImplementationAgent({
      ...prepared,
      provider: "codex",
      agentInvoker: async () => {
        invoked = true;
        throw new Error("must not run");
      }
    })).rejects.toThrow("exact clean Git base");
    expect(invoked).toBe(false);
  });

  it("fails before invocation when the branch changes after package export", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-agent-invoke-"));
    const prepared = await prepareApprovedContract(root);
    await exportManualAgentPackage(prepared);
    execFileSync("git", ["checkout", "-b", "unexpected-branch"], { cwd: prepared.cwd, stdio: "ignore" });
    let invoked = false;

    await expect(invokeImplementationAgent({
      ...prepared,
      provider: "codex",
      agentInvoker: async () => {
        invoked = true;
        throw new Error("must not run");
      }
    })).rejects.toThrow("branch, HEAD, or repository root changed");
    expect(invoked).toBe(false);
  });

  it("fails before invocation when HEAD changes after package export", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-agent-invoke-"));
    const prepared = await prepareApprovedContract(root);
    await exportManualAgentPackage(prepared);
    execFileSync("git", ["commit", "--allow-empty", "-m", "unexpected-head"], { cwd: prepared.cwd, stdio: "ignore" });
    let invoked = false;

    await expect(invokeImplementationAgent({
      ...prepared,
      provider: "codex",
      agentInvoker: async () => {
        invoked = true;
        throw new Error("must not run");
      }
    })).rejects.toThrow("branch, HEAD, or repository root changed");
    expect(invoked).toBe(false);
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
