import { describe, expect, it } from "vitest";

import {
  aiVisualReviewSchema,
  contextContentPackSchema,
  contextManifestSchema,
  figmaVisualEvidenceSchema,
  implementationContractSchema,
  walkingSkeletonArtifactSchema
} from "./index.js";

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

  it("accepts compact version-two context manifests", () => {
    const result = contextManifestSchema.parse({
      ...envelope,
      artifact_id: "art_context_1",
      type: "context_manifest",
      schema_version: 2,
      discovery_summary: {
        scanned_file_count: 100,
        candidate_file_count: 10,
        included_source_count: 5,
        excluded_candidate_count: 5,
        omitted_scan_count: 90
      },
      included_sources: [
        { uri: "src/index.ts", kind: "file", reason: "Task source", byte_length: 10, included: true, rank: 1 }
      ],
      excluded_candidates: [],
      budgets: { max_files: 5, max_bytes: 1000, used_files: 1, used_bytes: 10 },
      gaps: [],
      freshness: "partial"
    });

    expect(result.sources).toBeUndefined();
    expect(result.included_sources).toHaveLength(1);
  });

  it("accepts manifest/content-pack v3 semantic evidence without changing v2 parsing", () => {
    const fragment = {
      id: "frag_1",
      source_uri: "src/index.ts",
      source_sha256: "b".repeat(64),
      line_start: 1,
      line_end: 2,
      excerpt: "export const value = 1;",
      excerpt_truncated: true,
      reason: "Task symbol",
      classification: "fact" as const
    };
    const manifest = contextManifestSchema.parse({
      ...envelope,
      artifact_id: "art_context_v3",
      type: "context_manifest",
      schema_version: 3,
      included_sources: [{
        uri: "src/index.ts", kind: "file", category: "source", reason: "Task source", selection_reasons: ["Path match"],
        score_features: [{ feature: "task-path-term", score: 12, evidence: "Path matches index" }], relation_to_seeds: [],
        sha256: "b".repeat(64), byte_length: 30, included: true, rank: 1, deterministic_score: 12, required: false, pinned: false
      }],
      excluded_candidates: [],
      budgets: { max_files: 5, max_bytes: 1000, used_files: 1, used_bytes: 30 },
      gaps: [],
      freshness: "fresh",
      semantic_complete: true,
      repository_snapshot: { task_brief_sha256: "c".repeat(64), discovery_config_sha256: "d".repeat(64) },
      discovery_algorithm: { name: "atlas-semantic-context", version: "3.0.0" },
      effective_context_config_sha256: "e".repeat(64),
      task_terms: ["index"],
      seeds: [{ uri: "src/index.ts", score: 12, reasons: ["Path matches index"] }],
      evidence_fragments: [fragment],
      invalidation: { source_hashes: { "src/index.ts": "b".repeat(64) }, instruction_hashes: {}, relevant_inputs_sha256: "f".repeat(64) }
    });
    const pack = contextContentPackSchema.parse({
      ...envelope,
      artifact_id: "art_pack_v3",
      type: "context_content_pack",
      schema_version: 3,
      parents: ["art_task_1", "art_context_v3"],
      task_artifact_id: "art_task_1",
      task_artifact_sha256: "c".repeat(64),
      context_manifest_artifact_id: "art_context_v3",
      context_manifest_sha256: "a".repeat(64),
      max_bytes: 1000,
      used_bytes: 30,
      truncated: false,
      blocking_gaps: [],
      manifest_schema_version: 3,
      semantic_complete: true,
      repository_snapshot: manifest.repository_snapshot,
      discovery_config_sha256: "d".repeat(64),
      evidence_fragments: [fragment],
      sources: [{
        uri: "src/index.ts", kind: "file", category: "source", reason: "Task source", sha256: "b".repeat(64),
        byte_length: 30, included_bytes: 30, truncated: false, redacted: false, content: "export const value = 1;\n"
      }]
    });

    expect(manifest.semantic_complete).toBe(true);
    expect(pack.evidence_fragments?.[0]?.excerpt_truncated).toBe(true);
  });

  it("validates Figma evidence and structured AI visual reviews", () => {
    const figma = figmaVisualEvidenceSchema.parse({
      ...envelope,
      artifact_id: "art_figma_1",
      type: "figma_visual_evidence",
      producer: { type: "adapter", id: "figma" },
      figma_url: "https://www.figma.com/design/ABC123/Product?node-id=1-2",
      file_key: "ABC123",
      node_id: "1-2",
      scale: 1,
      source: "api",
      reference_artifact_id: "art_reference_1",
      reference_sha256: "b".repeat(64),
      retrieved_at: envelope.created_at
    });
    const review = aiVisualReviewSchema.parse({
      ...envelope,
      artifact_id: "art_visual_review_1",
      type: "ai_visual_review",
      provider_alias: "hetzner.default",
      model: "vision-model",
      prompt_version: "visual-review-v1",
      comparison_artifact_id: "art_comparison_1",
      evidence: {
        reference_artifact_id: "art_reference_1",
        actual_artifact_id: "art_actual_1",
        diff_artifact_id: "art_diff_1"
      },
      status: "findings",
      summary: "One spacing issue was found.",
      findings: [
        {
          finding_id: "visual_1",
          severity: "important",
          category: "spacing",
          title: "Padding differs",
          detail: "The actual header has less padding.",
          evidence: ["reference", "actual"],
          confidence: 0.9
        }
      ],
      data_egress: { destination: "cloud", consent: true },
      reviewed_at: envelope.created_at
    });

    expect(figma.reference_artifact_id).toBe("art_reference_1");
    expect(walkingSkeletonArtifactSchema.parse(review).type).toBe("ai_visual_review");
  });
});
