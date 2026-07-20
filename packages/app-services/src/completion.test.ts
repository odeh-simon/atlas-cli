import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveCompletion,
  approveContract,
  buildContextManifest,
  disposeFinding,
  evaluateCompletion,
  exportManualAgentPackage,
  exportPlanningPackage,
  getStatus,
  importContract,
  importExecutionResult,
  openAtlasRuntime,
  runBasicCheck,
  startManualTask
} from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listApprovalsForSession, listArtifactsForSession } from "@atlas/persistence";
import { prepareReviewImported } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-completion-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("completion approval", () => {
  it("requires clear gates, then records final approval and completes the session", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewImported(root);
    await disposeFinding({
      cwd,
      env,
      findingId: "REV-001",
      disposition: "resolve",
      reason: "Regression evidence added"
    });

    const evaluated = await evaluateCompletion({ cwd, env });
    const approved = await approveCompletion({ cwd, env, actorId: "tester" });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const artifacts = listArtifactsForSession(runtime.db, approved.sessionId);
    const approvals = listApprovalsForSession(runtime.db, approved.sessionId);
    closeAtlasRuntime(runtime, false);

    expect(evaluated.state).toBe("completion_ready");
    expect(approved.state).toBe("completed");
    expect(status.session?.primaryState).toBe("completed");
    expect(status.nextCommands).toHaveLength(0);
    expect(artifacts.some((artifact) => artifact.type === "completion_report" && artifact.status === "approved")).toBe(
      true
    );
    expect(approvals.some((approval) => approval.approvalType === "completion" && approval.actorId === "tester")).toBe(
      true
    );
  });

  it("blocks completion while a blocking review finding is unresolved", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareReviewImported(root);

    await expect(evaluateCompletion({ cwd, env })).rejects.toThrow("Completion gates failed");
  });

  it("blocks completion when the passing check result is stale against Git", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    initGitRepository(cwd);
    writeFileSync(join(cwd, "README.md"), "Initial docs\n");
    git(cwd, "add", "README.md");
    git(cwd, "-c", "user.email=atlas@example.test", "-c", "user.name=Atlas", "commit", "-m", "Initial");

    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
    await buildContextManifest({ cwd, env, maxFiles: 10, maxBytes: 50_000 });
    await exportPlanningPackage({ cwd, env });
    const contractPath = join(root, "contract.json");
    writeFileSync(
      contractPath,
      JSON.stringify({
        status: "valid",
        objective: { heading: "Objective", body_markdown: "Ship walking skeleton." },
        scope: { in_scope: ["Manual flow"], out_of_scope: ["Remote integrations"] },
        approved_decisions: [{ id: "decision_1", decision: "Use manual flow", rationale: "M1 scope" }],
        technical_approach: { heading: "Technical Approach", body_markdown: "Use services." },
        affected_subsystems: ["cli", "app-services"],
        reuse: ["M0 design"],
        constraints: ["No destructive Git"],
        data_state_permissions: { heading: "Data State Permissions", body_markdown: "Local state only." },
        required_states: ["loading", "error"],
        accessibility_observability: { heading: "Accessibility Observability", body_markdown: "CLI output." },
        edge_cases: ["Invalid import"],
        acceptance_criteria: ["Contract imports"],
        tests_and_validation: ["pnpm test"],
        unresolved_questions: [],
        prohibitions: ["No browser automation"]
      })
    );
    await importContract({ cwd, env, filePath: contractPath });
    await approveContract({ cwd, env });
    await exportManualAgentPackage({ cwd, env });
    const executionPath = join(root, "execution.json");
    writeFileSync(
      executionPath,
      JSON.stringify({
        process_status: "succeeded",
        agent_claims_complete: true,
        changed_files: ["README.md"],
        limitations: []
      })
    );
    await importExecutionResult({ cwd, env, filePath: executionPath });
    await runBasicCheck({ cwd, env });

    writeFileSync(join(cwd, "README.md"), "Changed after checks\n");

    await expect(evaluateCompletion({ cwd, env })).rejects.toThrow("Completion gates failed");
  });
});

function initGitRepository(cwd: string): void {
  git(cwd, "init");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
