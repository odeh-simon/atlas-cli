import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { orchestrateRun } from "./index.js";
import { prepareCheckedImplementation } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-orchestrate-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("orchestrateRun", () => {
  it("iterates through review, fix, agent, checks, and completion-ready", async () => {
    const root = tempRoot();
    const prepared = await prepareCheckedImplementation(root);
    let reviewCalls = 0;

    const result = await orchestrateRun({
      ...prepared,
      until: "completion-ready",
      agentProvider: "codex",
      agentInvoker: async (input) => ({
        provider: "codex",
        process: {
          runId: "run_fix_agent",
          command: input.command ?? "codex",
          args: ["--prompt", "redacted"],
          cwd: input.package.cwd,
          status: "succeeded",
          exitCode: 0,
          signal: undefined,
          stdout:
            'ATLAS_EXECUTION_REPORT_JSON: {"agent_claims_complete":true,"changed_files":["src/view.tsx"],"limitations":[]}',
          stderr: "",
          timedOut: false,
          startedAt: "2026-07-12T12:00:00.000Z",
          endedAt: "2026-07-12T12:00:01.000Z",
          durationMs: 1_000,
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false
        }
      }),
      reviewer: () => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            summary: "One blocking issue remains.",
            findings: [
              {
                finding_id: "REV-001",
                severity: "blocking",
                title: "Missing permission guard",
                description: "The implementation does not prove permission handling.",
                evidence: ["contract: permissions"],
                affected_files: ["src/view.tsx"],
                requirement_ids: ["AT-CMP-001"],
                proposed_action: "Add guard and test."
              }
            ]
          };
        }

        return { summary: "No blocking findings remain.", findings: [] };
      }
    });

    expect(result.status).toBe("succeeded");
    expect(result.state).toBe("completion_ready");
    expect(result.steps.map((step) => step.command)).toContain("atlas fix prepare");
    expect(result.steps.map((step) => step.command)).toContain("atlas implement --agent");
    expect(result.steps.map((step) => step.command)).toContain("atlas findings disposition");
    expect(reviewCalls).toBe(2);

    const orchestration = readLatestJsonArtifact(root, result.sessionId, "orchestration_run");
    expect(orchestration.artifact_id).toBe(result.orchestrationRunArtifactId);
    expect(orchestration.status).toBe("succeeded");
    expect(orchestration.until).toBe("completion_ready");
  });
});

function readLatestJsonArtifact(root: string, sessionId: string, type: string): Record<string, any> {
  const artifactDir = join(root, "home", "artifacts", sessionId, type);
  const latest = readdirSync(artifactDir).sort().at(-1);
  if (latest === undefined) throw new Error(`No ${type} artifact found`);
  return JSON.parse(readFileSync(join(artifactDir, latest), "utf8")) as Record<string, any>;
}
