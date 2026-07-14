import { describe, expect, it } from "vitest";

import { implementationContractSchema, walkingSkeletonArtifactSchema } from "./index.js";

const envelope = {
  artifact_id: "art_contract_1",
  session_id: "ses_1",
  type: "implementation_contract",
  schema_version: 1,
  content_version: 1,
  created_at: "2026-07-12T12:00:00.000Z",
  producer: { type: "user" },
  sensitivity: "confidential",
  parents: ["art_plan_1"],
  content_sha256: "a".repeat(64),
  metadata: {}
} as const;

const validContract = {
  ...envelope,
  status: "valid",
  objective: { heading: "Objective", body_markdown: "Ship the walking skeleton." },
  scope: { in_scope: ["Manual task flow"], out_of_scope: ["Linear integration"] },
  approved_decisions: [{ id: "dec_1", decision: "Use manual export", rationale: "Walking skeleton scope" }],
  technical_approach: { heading: "Technical Approach", body_markdown: "Use package boundaries." },
  affected_subsystems: ["cli", "workflow"],
  reuse: ["Existing M0 design"],
  constraints: ["No production integrations"],
  data_state_permissions: { heading: "Data", body_markdown: "Local-only state." },
  required_states: ["loading", "error"],
  accessibility_observability: { heading: "Accessibility", body_markdown: "Not applicable: CLI only." },
  edge_cases: ["Invalid contract import"],
  acceptance_criteria: ["Contract can be validated"],
  tests_and_validation: ["pnpm test"],
  unresolved_questions: [],
  prohibitions: ["No destructive Git"]
} as const;

describe("walking skeleton artifact schemas", () => {
  it("accepts a valid implementation contract", () => {
    expect(implementationContractSchema.parse(validContract).status).toBe("valid");
    expect(walkingSkeletonArtifactSchema.parse(validContract).type).toBe("implementation_contract");
  });

  it("rejects an approved contract with a blocking unresolved question", () => {
    const result = implementationContractSchema.safeParse({
      ...validContract,
      status: "approved",
      unresolved_questions: [{ question: "Is this safe?", blocking: true }]
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Approved contracts cannot contain blocking unresolved questions");
  });

  it("rejects a contract missing test requirements", () => {
    const result = implementationContractSchema.safeParse({
      ...validContract,
      tests_and_validation: []
    });

    expect(result.success).toBe(false);
  });
});
