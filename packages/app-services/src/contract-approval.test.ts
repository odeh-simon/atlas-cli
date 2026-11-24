import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveContract,
  buildContextManifest,
  exportPlanningPackage,
  getStatus,
  importContract,
  openSigilRuntime,
  startManualTask
} from "./index.js";
import { closeSigilRuntime } from "./runtime.js";
import { getArtifactRecord, listApprovalsForSession } from "@sigil/persistence";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-approve-"));
  tempRoots.push(root);
  return root;
}

async function prepareContract(root: string) {
  const cwd = join(root, "repo");
  const env = { SIGIL_HOME: join(root, "home") };
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "README.md"), "# Fixture\n");
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
  const imported = await importContract({ cwd, env, filePath: contractPath });
  return { cwd, env, imported };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("approveContract", () => {
  it("records explicit approval and advances to contract_approved", async () => {
    const root = tempRoot();
    const { cwd, env, imported } = await prepareContract(root);

    const result = await approveContract({ cwd, env, actorId: "tester" });
    const status = await getStatus({ cwd, env });
    const runtime = await openSigilRuntime({ cwd, env });
    const approvals = listApprovalsForSession(runtime.db, result.sessionId);
    const artifact = getArtifactRecord(runtime.db, imported.contractArtifactId);
    closeSigilRuntime(runtime, false);

    expect(result.state).toBe("contract_approved");
    expect(status.session?.primaryState).toBe("contract_approved");
    expect(status.nextCommands[0]).toBe("sigil implement export --manual");
    expect(approvals[0]).toMatchObject({ approvalType: "contract", actorId: "tester" });
    expect(artifact?.status).toBe("approved");
  });

  it("rejects approval before a contract is imported", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { SIGIL_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });

    await expect(approveContract({ cwd, env })).rejects.toThrow("No imported contract is available for approval");
  });
});
