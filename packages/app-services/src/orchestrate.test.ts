import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openSigilRuntime, orchestrateRun } from "./index.js";
import { closeSigilRuntime } from "./runtime.js";
import { listFindingsForSession } from "@sigil/persistence";
import { prepareCheckedImplementation } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-orchestrate-"));
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
      reviewerActorId: "reviewer:orchestrator-test",
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
            'SIGIL_EXECUTION_REPORT_JSON: {"agent_claims_complete":true,"changed_files":["src/view.tsx"],"limitations":[]}',
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
      reviewer: (input) => {
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

        const reviewPackage = JSON.parse(input.reviewPackageContent) as {
          implementation_diff_artifact_id: string;
        };
        return {
          summary: "The prior blocking finding is resolved by the current diff.",
          findings: [],
          resolved_findings: [
            {
              finding_id: "REV-001",
              resolution_evidence: [{
                artifact_id: reviewPackage.implementation_diff_artifact_id,
                claim: "The current diff contains the permission guard repair."
              }]
            }
          ]
        };
      }
    });

    expect(result.status).toBe("succeeded");
    expect(result.state).toBe("completion_ready");
    expect(result.steps.map((step) => step.command)).toContain("sigil fix prepare");
    expect(result.steps.map((step) => step.command)).toContain("sigil implement --agent");
    expect(result.steps.map((step) => step.command)).not.toContain("sigil findings disposition");
    expect(reviewCalls).toBe(2);

    const orchestration = readLatestJsonArtifact(root, result.sessionId, "orchestration_run");
    expect(orchestration.artifact_id).toBe(result.orchestrationRunArtifactId);
    expect(orchestration.status).toBe("succeeded");
    expect(orchestration.until).toBe("completion_ready");
  });

  it("does not blanket-resolve an earlier blocker after a generic clean review", async () => {
    const root = tempRoot();
    const prepared = await prepareCheckedImplementation(root);
    let reviewCalls = 0;
    const result = await orchestrateRun({
      ...prepared,
      until: "completion-ready",
      maxIterations: 8,
      agentProvider: "codex",
      reviewerActorId: "reviewer:orchestrator-test",
      agentInvoker: async (input) => ({
        provider: "codex",
        process: {
          runId: `run_fix_${reviewCalls}`,
          command: input.command ?? "codex",
          args: ["--prompt", "redacted"],
          cwd: input.package.cwd,
          status: "succeeded",
          exitCode: 0,
          signal: undefined,
          stdout: 'SIGIL_EXECUTION_REPORT_JSON: {"agent_claims_complete":true,"changed_files":[],"limitations":[]}',
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
        return reviewCalls === 1
          ? {
              summary: "Blocker",
              findings: [{ finding_id: "REV-001", severity: "blocking", title: "Guard", description: "Missing guard", evidence: ["contract"], affected_files: [], requirement_ids: [] }]
            }
          : { summary: "No new findings", findings: [] };
      }
    });

    expect(result.status).toBe("blocked");
    const runtime = await openSigilRuntime(prepared);
    try {
      expect(listFindingsForSession(runtime.db, result.sessionId).find((finding) => finding.findingId === "REV-001")?.status).toBe("open");
    } finally {
      closeSigilRuntime(runtime, false);
    }
  });
});

function readLatestJsonArtifact(root: string, sessionId: string, type: string): Record<string, any> {
  const artifactDir = join(root, "home", "artifacts", sessionId, type);
  const latest = readdirSync(artifactDir).sort().at(-1);
  if (latest === undefined) throw new Error(`No ${type} artifact found`);
  return JSON.parse(readFileSync(join(artifactDir, latest), "utf8")) as Record<string, any>;
}
