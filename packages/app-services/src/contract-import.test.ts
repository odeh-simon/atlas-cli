import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveContract,
  buildContextManifest,
  exportManualAgentPackage,
  exportPlanningPackage,
  getStatus,
  importContract,
  openSigilRuntime,
  startManualTask
} from "./index.js";
import { closeSigilRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@sigil/persistence";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-contract-"));
  tempRoots.push(root);
  return root;
}

async function preparePlanning(root: string) {
  const cwd = join(root, "repo");
  const env = { SIGIL_HOME: join(root, "home") };
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "README.md"), "# Fixture\n");
  await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
  await buildContextManifest({ cwd, env });
  await exportPlanningPackage({ cwd, env });
  return { cwd, env };
}

function validContract() {
  return {
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
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("importContract", () => {
  it("imports a valid contract and advances to contract_draft", async () => {
    const root = tempRoot();
    const { cwd, env } = await preparePlanning(root);
    const contractPath = join(root, "contract.json");
    writeFileSync(contractPath, JSON.stringify(validContract()));

    const result = await importContract({ cwd, env, filePath: contractPath });
    const status = await getStatus({ cwd, env });

    expect(result.state).toBe("contract_draft");
    expect(status.session?.primaryState).toBe("contract_draft");
    expect(status.nextCommands[0]).toBe("sigil approve contract");
  });

  it("stores an invalid contract as rejected without advancing state", async () => {
    const root = tempRoot();
    const { cwd, env } = await preparePlanning(root);
    const contractPath = join(root, "contract.json");
    const invalid = { ...validContract(), tests_and_validation: [] };
    writeFileSync(contractPath, JSON.stringify(invalid));

    await expect(importContract({ cwd, env, filePath: contractPath })).rejects.toThrow(
      "Implementation contract failed validation"
    );
    const status = await getStatus({ cwd, env });
    const runtime = await openSigilRuntime({ cwd, env });
    const contracts = listArtifactsForSession(runtime.db, status.session?.sessionId ?? "").filter(
      (artifact) => artifact.type === "implementation_contract"
    );
    closeSigilRuntime(runtime, false);

    expect(status.session?.primaryState).toBe("planning_ready");
    expect(contracts[0]?.status).toBe("rejected");
  });

  it("returns material contract changes to draft so they require reapproval", async () => {
    const root = tempRoot();
    const { cwd, env } = await preparePlanning(root);
    const contractPath = join(root, "contract.json");
    writeFileSync(contractPath, JSON.stringify(validContract()));
    await importContract({ cwd, env, filePath: contractPath });
    await approveContract({ cwd, env, actorId: "tester" });

    const changed = {
      ...validContract(),
      acceptance_criteria: ["Contract imports", "Changed acceptance requires approval"]
    };
    writeFileSync(contractPath, JSON.stringify(changed));
    const imported = await importContract({ cwd, env, filePath: contractPath });
    const status = await getStatus({ cwd, env });
    const runtime = await openSigilRuntime({ cwd, env });
    const contracts = listArtifactsForSession(runtime.db, imported.sessionId).filter(
      (artifact) => artifact.type === "implementation_contract"
    );
    const latest = contracts.at(-1);
    closeSigilRuntime(runtime, false);

    expect(imported.state).toBe("contract_draft");
    expect(status.session?.primaryState).toBe("contract_draft");
    expect(latest?.status).toBe("valid");
    expect(readContractRequiresReapproval(root, imported.sessionId)).toBe(true);
    await expect(exportManualAgentPackage({ cwd, env })).rejects.toThrow("approved contract");
  });
});

function readContractRequiresReapproval(root: string, sessionId: string): boolean {
  const artifactDir = join(root, "home", "artifacts", sessionId, "implementation_contract");
  const latest = readdirSync(artifactDir).sort().at(-1);
  if (latest === undefined) throw new Error("No contract artifact found");
  const parsed = JSON.parse(readFileSync(join(artifactDir, latest), "utf8")) as {
    metadata?: { contract_diff?: { requires_reapproval?: unknown } };
  };
  return parsed.metadata?.contract_diff?.requires_reapproval === true;
}
