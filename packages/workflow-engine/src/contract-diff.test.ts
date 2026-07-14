import { describe, expect, it } from "vitest";

import type { ImplementationContract } from "@atlas/schemas";
import { diffImplementationContracts } from "./index.js";

describe("diffImplementationContracts", () => {
  it("reports no changes for equivalent contracts", () => {
    const previous = contract();
    const next = contract();

    const diff = diffImplementationContracts(previous, next);

    expect(diff.hasChanges).toBe(false);
    expect(diff.requiresReapproval).toBe(false);
    expect(diff.changes).toHaveLength(0);
  });

  it("requires reapproval for material scope and test changes", () => {
    const previous = contract();
    const next = contract({
      scope: { in_scope: ["Manual flow", "Linear intake"], out_of_scope: [] },
      tests_and_validation: ["pnpm test", "pnpm check"]
    });

    const diff = diffImplementationContracts(previous, next);

    expect(diff.hasChanges).toBe(true);
    expect(diff.requiresReapproval).toBe(true);
    expect(diff.changes.map((change) => [change.section, change.category, change.material])).toEqual([
      ["scope", "scope", true],
      ["tests_and_validation", "tests", true]
    ]);
  });

  it("tracks non-material informational changes without requiring reapproval", () => {
    const previous = contract();
    const next = contract({
      accessibility_observability: {
        heading: "Accessibility Observability",
        body_markdown: "CLI output plus trace command."
      },
      unresolved_questions: [{ question: "Should trace be JSON first?", blocking: false }]
    });

    const diff = diffImplementationContracts(previous, next);

    expect(diff.hasChanges).toBe(true);
    expect(diff.requiresReapproval).toBe(false);
    expect(diff.changes.map((change) => [change.section, change.material])).toEqual([
      ["accessibility_observability", false],
      ["unresolved_questions", false]
    ]);
  });
});

function contract(overrides: Partial<ImplementationContract> = {}): ImplementationContract {
  return {
    artifact_id: "art_contract",
    session_id: "ses_contract",
    type: "implementation_contract",
    schema_version: 1,
    content_version: 1,
    created_at: "2026-07-14T00:00:00.000Z",
    producer: { type: "user" },
    sensitivity: "confidential",
    parents: [],
    content_sha256: "0".repeat(64),
    metadata: {},
    status: "valid",
    objective: { heading: "Objective", body_markdown: "Ship Atlas." },
    scope: { in_scope: ["Manual flow"], out_of_scope: [] },
    approved_decisions: [{ id: "decision_1", decision: "Use CLI", rationale: "M1 scope" }],
    technical_approach: { heading: "Technical Approach", body_markdown: "Use services." },
    affected_subsystems: ["cli"],
    reuse: ["M0"],
    constraints: ["No destructive Git"],
    data_state_permissions: { heading: "Data State Permissions", body_markdown: "Local state only." },
    required_states: ["loading", "error"],
    accessibility_observability: { heading: "Accessibility Observability", body_markdown: "CLI output." },
    edge_cases: ["Invalid JSON"],
    acceptance_criteria: ["Imports contract"],
    tests_and_validation: ["pnpm test"],
    unresolved_questions: [],
    prohibitions: ["No browser automation"],
    ...overrides
  };
}
