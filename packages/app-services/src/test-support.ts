import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  approveContract,
  buildContextManifest,
  exportManualAgentPackage,
  exportPlanningPackage,
  importExecutionResult,
  importContract,
  prepareReviewPackage,
  importReviewReport,
  runBasicCheck,
  startManualTask
} from "./index.js";

export async function prepareApprovedContract(
  root: string,
  beforeStart?: (prepared: { cwd: string; env: { SIGIL_HOME: string } }) => void | Promise<void>
) {
  const cwd = join(root, "repo");
  const env = { SIGIL_HOME: join(root, "home") };
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "README.md"), "# Sigil test fixture\n");
  await beforeStart?.({ cwd, env });
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "sigil-tests@example.invalid"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Sigil Tests"], { cwd, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd, stdio: "ignore" });
  await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
  await buildContextManifest({ cwd, env });
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
  await approveContract({ cwd, env, actorId: "tester" });
  return { cwd, env };
}

export async function prepareExecution(
  root: string,
  beforeExecution?: (prepared: { cwd: string; env: { SIGIL_HOME: string } }) => void | Promise<void>
) {
  const prepared = await prepareApprovedContract(root, beforeExecution);
  await exportManualAgentPackage(prepared);
  const executionPath = join(root, "execution.json");
  writeFileSync(
    executionPath,
    JSON.stringify({
      process_status: "succeeded",
      agent_claims_complete: true,
      changed_files: ["packages/app-services/src/example.ts"],
      limitations: []
    })
  );
  await importExecutionResult({ ...prepared, filePath: executionPath });
  return prepared;
}

export async function prepareCheckedImplementation(root: string) {
  const prepared = await prepareExecution(root);
  await runBasicCheck(prepared);
  return prepared;
}

export async function prepareReviewReady(root: string) {
  const prepared = await prepareCheckedImplementation(root);
  await prepareReviewPackage(prepared);
  return prepared;
}

export async function prepareReviewImported(root: string) {
  const prepared = await prepareReviewReady(root);
  const reviewPath = join(root, "review.json");
  writeFileSync(
    reviewPath,
    JSON.stringify({
      summary: "One issue remains.",
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
    })
  );
  await importReviewReport({ ...prepared, filePath: reviewPath, reviewerActorId: "human:test-reviewer" });
  return prepared;
}
