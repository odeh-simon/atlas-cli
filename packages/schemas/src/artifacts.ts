import { z } from "zod";

export const idSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const isoDateTimeSchema = z.string().datetime();
export const sha256Schema = z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/);

export const artifactTypeSchema = z.enum([
  "task_brief",
  "manual_task_input",
  "ai_context_recommendation",
  "context_manifest",
  "context_content_pack",
  "context_quality_report",
  "ai_planning_draft",
  "ai_vision_result",
  "visual_snapshot",
  "visual_reference",
  "visual_diff",
  "visual_capture",
  "visual_comparison",
  "figma_visual_evidence",
  "ai_visual_review",
  "planning_package_metadata",
  "implementation_contract",
  "contract_approval",
  "agent_implementation_package",
  "agent_run_log",
  "execution_report",
  "implementation_diff",
  "check_run_log",
  "check_result",
  "review_package",
  "review_report",
  "finding",
  "finding_disposition",
  "fix_batch",
  "adapter_writeback",
  "orchestration_run",
  "decision_record",
  "completion_report"
]);

export const sensitivitySchema = z.enum(["public", "internal", "confidential", "secret-redacted"]);
export const producerTypeSchema = z.enum(["atlas", "user", "adapter", "agent", "import"]);

export const artifactEnvelopeSchema = z.object({
  artifact_id: idSchema,
  session_id: idSchema,
  type: artifactTypeSchema,
  schema_version: z.number().int().positive(),
  content_version: z.number().int().positive(),
  created_at: isoDateTimeSchema,
  producer: z.object({
    type: producerTypeSchema,
    id: z.string().min(1).optional()
  }),
  sensitivity: sensitivitySchema,
  parents: z.array(idSchema).default([]),
  replaces: idSchema.optional(),
  content_sha256: sha256Schema,
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const referenceSchema = z.object({
  original_text: z.string().min(1),
  canonical_url: z.string().url().optional(),
  kind: z.enum(["figma", "github", "linear", "file", "url", "unknown"]),
  source_location: z.string().optional(),
  status: z.enum(["parsed", "malformed", "inaccessible", "fetched"])
});

export const manualTaskInputSchema = artifactEnvelopeSchema.extend({
  type: z.literal("manual_task_input"),
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  repo_path: z.string().trim().min(1),
  references: z.array(referenceSchema).default([]),
  acceptance_criteria: z.array(z.string().trim().min(1)).default([])
});

export const taskBriefSchema = artifactEnvelopeSchema.extend({
  type: z.literal("task_brief"),
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  source: z.enum(["manual", "linear"]),
  repo_id: idSchema,
  references: z.array(referenceSchema).default([]),
  acceptance_criteria: z.array(z.string().trim().min(1)).default([])
});

export const contextSourceRecordSchema = z.object({
  uri: z.string().min(1),
  kind: z.enum(["file", "symbol", "git", "figma", "github", "linear", "instruction", "test", "operation", "evidence"]),
  reason: z.string().min(1),
  sha256: sha256Schema.optional(),
  git_sha: z.string().min(1).optional(),
  fetched_at: isoDateTimeSchema.optional(),
  byte_length: z.number().int().nonnegative(),
  included: z.boolean(),
  exclusion_reason: z.string().min(1).optional(),
  rank: z.number().int().positive().optional(),
  deterministic_score: z.number().nonnegative().optional(),
  ai_confidence: z.number().min(0).max(1).optional()
});

export const contextManifestSchema = artifactEnvelopeSchema.extend({
  type: z.literal("context_manifest"),
  sources: z.array(contextSourceRecordSchema).optional(),
  discovery_summary: z
    .object({
      scanned_file_count: z.number().int().nonnegative(),
      candidate_file_count: z.number().int().nonnegative(),
      included_source_count: z.number().int().nonnegative(),
      excluded_candidate_count: z.number().int().nonnegative(),
      omitted_scan_count: z.number().int().nonnegative()
    })
    .optional(),
  included_sources: z.array(contextSourceRecordSchema).optional(),
  excluded_candidates: z.array(contextSourceRecordSchema).optional(),
  budgets: z.object({
    max_files: z.number().int().positive(),
    max_bytes: z.number().int().positive(),
    used_files: z.number().int().nonnegative(),
    used_bytes: z.number().int().nonnegative()
  }),
  gaps: z.array(
    z.object({
      id: idSchema,
      severity: z.enum(["blocking", "warning", "info"]),
      description: z.string().min(1)
    })
  ).default([]),
  freshness: z.enum(["fresh", "stale", "partial"])
});

export const contextContentPackSchema = artifactEnvelopeSchema.extend({
  type: z.literal("context_content_pack"),
  task_artifact_id: idSchema,
  task_artifact_sha256: sha256Schema,
  context_manifest_artifact_id: idSchema,
  context_manifest_sha256: sha256Schema,
  git_base_fingerprint: sha256Schema.optional(),
  git_head_sha: z.string().min(1).optional(),
  max_bytes: z.number().int().positive(),
  used_bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  blocking_gaps: z.array(idSchema).default([]),
  sources: z.array(z.object({
    uri: z.string().min(1),
    kind: contextSourceRecordSchema.shape.kind,
    reason: z.string().min(1),
    sha256: sha256Schema,
    byte_length: z.number().int().nonnegative(),
    included_bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    redacted: z.boolean(),
    content: z.string()
  }))
});

export const aiContextRecommendationSchema = artifactEnvelopeSchema.extend({
  type: z.literal("ai_context_recommendation"),
  provider_alias: idSchema,
  model: z.string().min(1),
  task_artifact_id: idSchema,
  recommendations: z.array(
    z.object({
      uri: z.string().min(1),
      reason: z.string().min(1),
      confidence: z.number().min(0).max(1)
    })
  ),
  missing_context: z.array(z.string().min(1)).default([]),
  questions: z.array(z.string().min(1)).default([])
});

export const contextQualityReportSchema = artifactEnvelopeSchema.extend({
  type: z.literal("context_quality_report"),
  context_manifest_artifact_id: idSchema,
  readiness: z.enum(["ready", "weak", "blocked"]),
  issues: z.array(
    z.object({
      code: idSchema,
      severity: z.enum(["blocking", "warning", "info"]),
      summary: z.string().min(1)
    })
  ),
  recommended_next_actions: z.array(z.string().min(1)).default([])
});

export const aiPlanningDraftSchema = artifactEnvelopeSchema.extend({
  type: z.literal("ai_planning_draft"),
  provider_alias: idSchema,
  model: z.string().min(1),
  task_artifact_id: idSchema,
  task_artifact_sha256: sha256Schema,
  context_manifest_artifact_id: idSchema,
  context_manifest_sha256: sha256Schema,
  context_content_pack_artifact_id: idSchema.optional(),
  context_content_pack_sha256: sha256Schema.optional(),
  draft_markdown: z.string().min(1),
  ready_label: z.enum(["draft", "blocked"])
});

export const aiVisionResultSchema = artifactEnvelopeSchema.extend({
  type: z.literal("ai_vision_result"),
  provider_alias: idSchema,
  model: z.string().min(1),
  prompt: z.string().min(1),
  image: z.object({
    source_name: z.string().min(1),
    media_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    byte_length: z.number().int().positive(),
    sha256: sha256Schema
  }),
  analysis: z.string().min(1),
  data_egress: z.object({
    destination: z.enum(["local", "cloud"]),
    consent: z.boolean()
  })
});

export const visualCaptureSchema = artifactEnvelopeSchema.extend({
  type: z.literal("visual_capture"),
  url: z.string().url(),
  title: z.string(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  full_page: z.boolean(),
  browser_channel: z.enum(["msedge", "chrome", "chromium"]),
  snapshot_artifact_id: idSchema,
  snapshot_sha256: sha256Schema,
  captured_at: isoDateTimeSchema
});

export const visualComparisonSchema = artifactEnvelopeSchema.extend({
  type: z.literal("visual_comparison"),
  status: z.enum(["passed", "failed", "dimension-mismatch"]),
  reference: z.object({
    artifact_id: idSchema,
    sha256: sha256Schema,
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  actual: z.object({
    artifact_id: idSchema,
    sha256: sha256Schema,
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  diff_artifact_id: idSchema.optional(),
  mismatched_pixels: z.number().int().nonnegative(),
  total_pixels: z.number().int().positive(),
  diff_ratio: z.number().min(0).max(1),
  pixel_threshold: z.number().min(0).max(1),
  allowed_diff_ratio: z.number().min(0).max(1)
});

export const figmaVisualEvidenceSchema = artifactEnvelopeSchema.extend({
  type: z.literal("figma_visual_evidence"),
  figma_url: z.string().url(),
  file_key: z.string().min(1),
  node_id: z.string().min(1),
  scale: z.number().min(0.01).max(4),
  source: z.enum(["api", "file"]),
  reference_artifact_id: idSchema,
  reference_sha256: sha256Schema,
  retrieved_at: isoDateTimeSchema
});

export const aiVisualReviewSchema = artifactEnvelopeSchema.extend({
  type: z.literal("ai_visual_review"),
  provider_alias: idSchema,
  model: z.string().min(1),
  prompt_version: z.string().min(1),
  comparison_artifact_id: idSchema,
  evidence: z.object({
    reference_artifact_id: idSchema,
    actual_artifact_id: idSchema,
    diff_artifact_id: idSchema.optional()
  }),
  status: z.enum(["passed", "findings", "inconclusive"]),
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      finding_id: idSchema,
      severity: z.enum(["blocking", "important", "suggestion"]),
      category: z.enum(["layout", "spacing", "typography", "color", "content", "responsive", "accessibility", "other"]),
      title: z.string().min(1),
      detail: z.string().min(1),
      evidence: z.array(z.enum(["reference", "actual", "diff"])).min(1),
      confidence: z.number().min(0).max(1)
    })
  ),
  data_egress: z.object({
    destination: z.enum(["local", "cloud"]),
    consent: z.boolean()
  }),
  reviewed_at: isoDateTimeSchema
});

export const planningPackageMetadataSchema = artifactEnvelopeSchema.extend({
  type: z.literal("planning_package_metadata"),
  input_artifact_ids: z.array(idSchema).min(1),
  ready_label: z.enum(["ready", "draft", "blocked"]),
  package_path: z.string().min(1),
  clipboard_status: z.enum(["copied", "failed", "not_requested"]).default("not_requested")
});

const contractTextSectionSchema = z.object({
  heading: z.string().min(1),
  body_markdown: z.string().min(1),
  not_applicable_reason: z.string().min(1).optional()
});

export const implementationContractSchema = artifactEnvelopeSchema.extend({
  type: z.literal("implementation_contract"),
  status: z.enum(["draft", "valid", "approved", "rejected", "superseded"]),
  objective: contractTextSectionSchema,
  scope: z.object({
    in_scope: z.array(z.string().min(1)).min(1),
    out_of_scope: z.array(z.string().min(1))
  }),
  approved_decisions: z.array(
    z.object({
      id: idSchema,
      decision: z.string().min(1),
      rationale: z.string().min(1)
    })
  ),
  technical_approach: contractTextSectionSchema,
  affected_subsystems: z.array(z.string().min(1)),
  reuse: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  data_state_permissions: contractTextSectionSchema,
  required_states: z.array(z.string().min(1)),
  accessibility_observability: contractTextSectionSchema,
  edge_cases: z.array(z.string().min(1)),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  tests_and_validation: z.array(z.string().min(1)).min(1),
  unresolved_questions: z.array(
    z.object({
      question: z.string().min(1),
      blocking: z.boolean()
    })
  ).default([]),
  prohibitions: z.array(z.string().min(1))
}).superRefine((contract, context) => {
  if (contract.status === "approved" && contract.unresolved_questions.some((question) => question.blocking)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unresolved_questions"],
      message: "Approved contracts cannot contain blocking unresolved questions"
    });
  }
});

export const contractApprovalSchema = artifactEnvelopeSchema.extend({
  type: z.literal("contract_approval"),
  approved_artifact_id: idSchema,
  approved_sha256: sha256Schema,
  actor_id: z.string().min(1),
  approved_at: isoDateTimeSchema,
  rationale: z.string().min(1).optional()
});

export const agentImplementationPackageSchema = artifactEnvelopeSchema.extend({
  type: z.literal("agent_implementation_package"),
  contract_artifact_id: idSchema,
  contract_sha256: sha256Schema,
  context_content_pack_artifact_id: idSchema.optional(),
  context_content_pack_sha256: sha256Schema.optional(),
  git_snapshot_fingerprint: sha256Schema.optional(),
  git_base_fingerprint: sha256Schema.optional(),
  git_root_path_hash: sha256Schema.optional(),
  git_branch: z.string().min(1).optional(),
  git_head_sha: z.string().min(1).optional(),
  mode: z.enum(["implement", "fix"]),
  instructions_markdown: z.string().min(1),
  report_schema_version: z.number().int().positive()
});

const gitSnapshotSchema = z.object({
  fingerprint: sha256Schema,
  base_fingerprint: sha256Schema,
  root_path_hash: sha256Schema,
  branch: z.string().min(1).optional(),
  head_sha: z.string().min(1).optional(),
  dirty: z.boolean(),
  changed_file_count: z.number().int().nonnegative(),
  changed_files: z.array(
    z.object({
      path: z.string().min(1),
      index: z.string().min(1),
      working_tree: z.string().min(1),
      original_path: z.string().min(1).optional()
    })
  ),
  diff_summary: z
    .object({
      base_ref: z.string().min(1),
      total_files: z.number().int().nonnegative(),
      total_line_changes: z.number().int().nonnegative(),
      has_binary: z.boolean(),
      has_secret_risk: z.boolean(),
      truncated: z.boolean(),
      reviewable: z.boolean()
    })
    .optional()
});

export const agentRunLogSchema = artifactEnvelopeSchema.extend({
  type: z.literal("agent_run_log"),
  provider: z.enum(["codex", "claude-code"]),
  run_id: idSchema,
  package_artifact_id: idSchema,
  process: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    status: z.enum(["succeeded", "failed", "cancelled", "timeout", "interrupted", "unknown"]),
    exit_code: z.number().int().optional(),
    signal: z.string().min(1).optional(),
    started_at: isoDateTimeSchema,
    ended_at: isoDateTimeSchema,
    duration_ms: z.number().int().nonnegative(),
    stdout: z.string(),
    stderr: z.string(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    redacted: z.boolean()
  }),
  git_before: gitSnapshotSchema.optional(),
  git_after: gitSnapshotSchema.optional(),
  parsed_completion_report: z
    .object({
      agent_claims_complete: z.boolean().optional(),
      changed_files: z.array(z.string()).default([]),
      limitations: z.array(z.string()).default([])
    })
    .optional()
});

export const executionReportSchema = artifactEnvelopeSchema.extend({
  type: z.literal("execution_report"),
  run_id: idSchema,
  implementation_actor_id: z.string().min(1).optional(),
  implementation_diff_artifact_id: idSchema.optional(),
  implementation_diff_sha256: sha256Schema.optional(),
  implementation_package_artifact_id: idSchema.optional(),
  implementation_package_sha256: sha256Schema.optional(),
  contract_artifact_id: idSchema.optional(),
  contract_sha256: sha256Schema.optional(),
  context_content_pack_artifact_id: idSchema.optional(),
  context_content_pack_sha256: sha256Schema.optional(),
  process_status: z.enum(["succeeded", "failed", "cancelled", "timeout", "interrupted", "unknown"]),
  agent_claims_complete: z.boolean().optional(),
  changed_files: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([])
});

export const implementationDiffSchema = artifactEnvelopeSchema.extend({
  type: z.literal("implementation_diff"),
  run_id: idSchema,
  base_fingerprint: sha256Schema,
  result_fingerprint: sha256Schema,
  base_head_sha: z.string().min(1).optional(),
  result_head_sha: z.string().min(1).optional(),
  patch_sha256: sha256Schema,
  patch: z.string(),
  byte_length: z.number().int().nonnegative(),
  truncated: z.boolean(),
  has_binary: z.boolean(),
  has_secret_risk: z.boolean(),
  reviewable: z.boolean(),
  omitted_paths: z.array(z.string()).default([]),
  changed_files: z.array(z.string()).default([])
});

export const checkRunLogSchema = artifactEnvelopeSchema.extend({
  type: z.literal("check_run_log"),
  run_id: idSchema,
  status: z.enum(["passed", "failed"]),
  failed_required: z.array(z.string()).default([]),
  results: z.array(
    z.object({
      name: z.string().min(1),
      required: z.boolean(),
      status: z.enum(["passed", "failed", "skipped", "blocked", "cancelled", "timeout"]),
      summary: z.string().min(1),
      dependencies: z.array(z.string()).default([]),
      affected: z.array(z.string()).default([]),
      evidence_artifact_ids: z.array(idSchema).default([]),
      skipped_reason: z.string().min(1).optional(),
      process: z
        .object({
          run_id: idSchema,
          command: z.string().min(1),
          args: z.array(z.string()),
          status: z.enum(["succeeded", "failed", "timeout", "cancelled"]),
          exit_code: z.number().int().optional(),
          timed_out: z.boolean(),
          stdout_truncated: z.boolean(),
          stderr_truncated: z.boolean(),
          redacted: z.boolean()
        })
        .optional()
    })
  )
});

export const checkResultSchema = artifactEnvelopeSchema.extend({
  type: z.literal("check_result"),
  check_name: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped", "blocked", "cancelled", "timeout"]),
  required: z.boolean(),
  summary: z.string().min(1),
  git_fingerprint: z.string().min(1).optional(),
  visual_config_fingerprint: sha256Schema.optional()
});

export const reviewPackageSchema = artifactEnvelopeSchema.extend({
  type: z.literal("review_package"),
  contract_artifact_id: idSchema,
  contract_sha256: sha256Schema.optional(),
  execution_report_artifact_id: idSchema,
  implementation_run_id: idSchema.optional(),
  implementation_actor_id: z.string().min(1).optional(),
  implementation_diff_artifact_id: idSchema.optional(),
  implementation_diff_sha256: sha256Schema.optional(),
  git_fingerprint: sha256Schema.optional(),
  check_result_artifact_ids: z.array(idSchema),
  visual_evidence_artifact_ids: z.array(idSchema).default([]),
  review_ready_label: z.enum(["ready", "draft", "blocked"]),
  rubric_markdown: z.string().min(1),
  contract_content: z.string().min(1).optional(),
  diff_content: z.string().optional(),
  check_evidence: z.array(z.object({ artifact_id: idSchema, sha256: sha256Schema, content: z.string().min(1) })).optional(),
  context_evidence_artifact_ids: z.array(idSchema).default([]),
  prior_open_findings: z.array(z.object({
    finding_id: idSchema,
    severity: z.enum(["blocking", "important", "suggestion", "question", "accepted_deviation"]),
    title: z.string().min(1),
    evidence: z.array(z.string())
  })).default([])
});

export const findingSeveritySchema = z.enum(["blocking", "important", "suggestion", "question", "accepted_deviation"]);
export const findingStatusSchema = z.enum([
  "open",
  "resolved",
  "accepted_deviation",
  "rejected",
  "deferred",
  "duplicate",
  "cannot_reproduce",
  "reopened"
]);

export const findingSchema = artifactEnvelopeSchema.extend({
  type: z.literal("finding"),
  finding_id: idSchema,
  review_iteration: z.number().int().positive(),
  severity: findingSeveritySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  affected_files: z.array(z.string()).default([]),
  requirement_ids: z.array(z.string()).default([]),
  proposed_action: z.string().min(1).optional(),
  status: findingStatusSchema
});

export const reviewReportSchema = artifactEnvelopeSchema.extend({
  type: z.literal("review_report"),
  review_package_artifact_id: idSchema,
  review_package_sha256: sha256Schema,
  reviewer_actor_id: z.string().min(1).optional(),
  reviewer_run_id: idSchema.optional(),
  reviewed_contract_sha256: sha256Schema.optional(),
  reviewed_diff_sha256: sha256Schema.optional(),
  reviewed_git_fingerprint: sha256Schema.optional(),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
  resolved_findings: z.array(z.object({
    finding_id: idSchema,
    resolution_evidence: z.array(z.union([
      z.string().min(1),
      z.object({
        artifact_id: idSchema,
        claim: z.string().min(1).optional(),
        location: z.string().min(1).optional()
      })
    ])).min(1)
  })).default([])
});

export const findingDispositionSchema = artifactEnvelopeSchema.extend({
  type: z.literal("finding_disposition"),
  finding_id: idSchema,
  disposition: z.enum(["resolve", "accept_deviation", "reject", "defer", "duplicate", "cannot_reproduce", "reopen"]),
  actor_id: z.string().min(1),
  reason: z.string().min(1),
  resolution_evidence: z.array(z.string().min(1)).default([])
});

export const fixBatchSchema = artifactEnvelopeSchema.extend({
  type: z.literal("fix_batch"),
  contract_artifact_id: idSchema,
  contract_sha256: sha256Schema,
  finding_ids: z.array(idSchema).min(1),
  instructions_markdown: z.string().min(1)
});

export const orchestrationRunSchema = artifactEnvelopeSchema.extend({
  type: z.literal("orchestration_run"),
  run_id: idSchema,
  until: z.enum(["context_ready", "planning_ready", "checks_completed", "completion_ready"]),
  status: z.enum(["succeeded", "blocked", "failed"]),
  iterations: z.number().int().nonnegative(),
  steps: z.array(
    z.object({
      command: z.string().min(1),
      state_before: z.string().min(1),
      state_after: z.string().min(1),
      status: z.enum(["succeeded", "blocked", "failed"]),
      summary: z.string().min(1),
      artifact_ids: z.array(idSchema).default([])
    })
  ),
  blocked_reason: z.string().min(1).optional()
});

export const decisionRecordSchema = artifactEnvelopeSchema.extend({
  type: z.literal("decision_record"),
  decision_id: idSchema,
  kind: z.enum(["decision", "deviation"]),
  title: z.string().min(1),
  rationale: z.string().min(1),
  category: z.enum(["scope", "architecture", "data_security", "design_constraints", "acceptance", "tests", "prohibitions"]),
  approved_by: z.string().min(1),
  approved_at: isoDateTimeSchema,
  supersedes_decision_id: idSchema.optional()
});

export const completionReportSchema = artifactEnvelopeSchema.extend({
  type: z.literal("completion_report"),
  contract_artifact_id: idSchema,
  contract_sha256: sha256Schema,
  check_result_artifact_ids: z.array(idSchema),
  review_report_artifact_id: idSchema.optional(),
  implementation_diff_artifact_id: idSchema.optional(),
  unresolved_blocking_findings: z.array(idSchema),
  approved_by: z.string().min(1),
  approved_at: isoDateTimeSchema,
  completion_gate_status: z.enum(["passed", "blocked", "overridden"])
});

export const adapterWritebackSchema = artifactEnvelopeSchema.extend({
  type: z.literal("adapter_writeback"),
  provider: z.enum(["linear", "github", "figma"]),
  mode: z.enum(["dry-run", "write"]),
  status: z.enum(["prepared", "written", "blocked", "failed"]),
  target: z.string().min(1),
  summary: z.string().min(1),
  remote_id: z.string().min(1).optional(),
  remote_url: z.string().url().optional(),
  evidence: z.array(z.string().min(1)).default([])
});

export const walkingSkeletonArtifactSchema = z.discriminatedUnion("type", [
  manualTaskInputSchema,
  aiContextRecommendationSchema,
  taskBriefSchema,
  contextManifestSchema,
  contextContentPackSchema,
  contextQualityReportSchema,
  aiPlanningDraftSchema,
  aiVisionResultSchema,
  visualCaptureSchema,
  visualComparisonSchema,
  figmaVisualEvidenceSchema,
  aiVisualReviewSchema,
  planningPackageMetadataSchema,
  implementationContractSchema,
  contractApprovalSchema,
  agentImplementationPackageSchema,
  agentRunLogSchema,
  executionReportSchema,
  implementationDiffSchema,
  checkRunLogSchema,
  checkResultSchema,
  reviewPackageSchema,
  reviewReportSchema,
  findingSchema,
  findingDispositionSchema,
  fixBatchSchema,
  orchestrationRunSchema,
  decisionRecordSchema,
  completionReportSchema,
  adapterWritebackSchema
]);

export type ArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;
export type ContextSourceRecord = z.infer<typeof contextSourceRecordSchema>;
export type ContextManifest = z.infer<typeof contextManifestSchema>;
export type ContextContentPack = z.infer<typeof contextContentPackSchema>;
export type AiContextRecommendation = z.infer<typeof aiContextRecommendationSchema>;
export type ContextQualityReport = z.infer<typeof contextQualityReportSchema>;
export type AiPlanningDraft = z.infer<typeof aiPlanningDraftSchema>;
export type AiVisionResult = z.infer<typeof aiVisionResultSchema>;
export type VisualCapture = z.infer<typeof visualCaptureSchema>;
export type VisualComparison = z.infer<typeof visualComparisonSchema>;
export type FigmaVisualEvidence = z.infer<typeof figmaVisualEvidenceSchema>;
export type AiVisualReview = z.infer<typeof aiVisualReviewSchema>;
export type ImplementationContract = z.infer<typeof implementationContractSchema>;
export type AgentRunLog = z.infer<typeof agentRunLogSchema>;
export type ImplementationDiff = z.infer<typeof implementationDiffSchema>;
export type CheckRunLog = z.infer<typeof checkRunLogSchema>;
export type OrchestrationRun = z.infer<typeof orchestrationRunSchema>;
export type AdapterWriteback = z.infer<typeof adapterWritebackSchema>;
export type WalkingSkeletonArtifact = z.infer<typeof walkingSkeletonArtifactSchema>;
