import { z } from "zod";

export const idSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const isoDateTimeSchema = z.string().datetime();
export const sha256Schema = z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/);

export const artifactTypeSchema = z.enum([
  "task_brief",
  "manual_task_input",
  "context_manifest",
  "planning_package_metadata",
  "implementation_contract",
  "contract_approval",
  "agent_implementation_package",
  "execution_report",
  "check_result",
  "review_package",
  "review_report",
  "finding",
  "finding_disposition",
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
  exclusion_reason: z.string().min(1).optional()
});

export const contextManifestSchema = artifactEnvelopeSchema.extend({
  type: z.literal("context_manifest"),
  sources: z.array(contextSourceRecordSchema),
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
  mode: z.enum(["implement", "fix"]),
  instructions_markdown: z.string().min(1),
  report_schema_version: z.number().int().positive()
});

export const executionReportSchema = artifactEnvelopeSchema.extend({
  type: z.literal("execution_report"),
  run_id: idSchema,
  process_status: z.enum(["succeeded", "failed", "cancelled", "timeout", "interrupted", "unknown"]),
  agent_claims_complete: z.boolean().optional(),
  changed_files: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([])
});

export const checkResultSchema = artifactEnvelopeSchema.extend({
  type: z.literal("check_result"),
  check_name: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped", "blocked", "cancelled", "timeout"]),
  required: z.boolean(),
  summary: z.string().min(1),
  git_fingerprint: z.string().min(1).optional()
});

export const reviewPackageSchema = artifactEnvelopeSchema.extend({
  type: z.literal("review_package"),
  contract_artifact_id: idSchema,
  execution_report_artifact_id: idSchema,
  check_result_artifact_ids: z.array(idSchema),
  review_ready_label: z.enum(["ready", "draft", "blocked"]),
  rubric_markdown: z.string().min(1)
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
  summary: z.string().min(1),
  findings: z.array(findingSchema)
});

export const findingDispositionSchema = artifactEnvelopeSchema.extend({
  type: z.literal("finding_disposition"),
  finding_id: idSchema,
  disposition: z.enum(["resolve", "accept_deviation", "reject", "defer", "duplicate", "cannot_reproduce", "reopen"]),
  actor_id: z.string().min(1),
  reason: z.string().min(1),
  resolution_evidence: z.array(z.string().min(1)).default([])
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
  unresolved_blocking_findings: z.array(idSchema),
  approved_by: z.string().min(1),
  approved_at: isoDateTimeSchema,
  completion_gate_status: z.enum(["passed", "blocked", "overridden"])
});

export const walkingSkeletonArtifactSchema = z.discriminatedUnion("type", [
  manualTaskInputSchema,
  taskBriefSchema,
  contextManifestSchema,
  planningPackageMetadataSchema,
  implementationContractSchema,
  contractApprovalSchema,
  agentImplementationPackageSchema,
  executionReportSchema,
  checkResultSchema,
  reviewPackageSchema,
  reviewReportSchema,
  findingSchema,
  findingDispositionSchema,
  decisionRecordSchema,
  completionReportSchema
]);

export type ArtifactEnvelope = z.infer<typeof artifactEnvelopeSchema>;
export type ImplementationContract = z.infer<typeof implementationContractSchema>;
export type WalkingSkeletonArtifact = z.infer<typeof walkingSkeletonArtifactSchema>;
