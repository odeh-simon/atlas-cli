import { z } from "zod";

import { idSchema, isoDateTimeSchema, sensitivitySchema, sha256Schema } from "./artifacts.js";

export const EVIDENCE_INDEX_SCHEMA_VERSION = 1;

export const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeUriSegments(uri: string): boolean {
  if (uri.includes("\\") || uri.startsWith("/") || /^[A-Za-z]:/.test(uri)) {
    return false;
  }
  const segments = uri.split("/");
  return segments.length > 0 && segments.every((segment) => SAFE_SEGMENT_PATTERN.test(segment));
}

const repoRelativeUriSchema = z
  .string()
  .min(1)
  .refine(isSafeUriSegments, {
    message: "uri must be a repository-relative forward-slash path with safe segments"
  });

const gitStatusTokenSchema = z.string().regex(/^[ A-Z?!]{1,2}$/, {
  message: "git status token must be a short porcelain status code"
});

const storageUriSchema = z.string().min(1).refine(
  (value) => {
    const segments = value.split("/");
    return (
      !value.startsWith("/") &&
      segments.length >= 2 &&
      segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(segment)) &&
      !segments.includes("..")
    );
  },
  { message: "storage_uri must be a root-relative artifact-store URI" }
);

export const evidenceCategorySchema = z.enum([
  "source",
  "test",
  "architecture",
  "contract",
  "schema",
  "migration",
  "operation",
  "config",
  "instruction"
]);

export const evidenceRepositoryIdentitySchema = z.object({
  repository_id: idSchema,
  display_name: z.string().trim().min(1),
  root_path_hash: sha256Schema,
  remote_url_hash: sha256Schema.optional(),
  created_at: isoDateTimeSchema
});

export const evidenceGitSnapshotSchema = z.object({
  snapshot_id: idSchema,
  fingerprint: sha256Schema,
  base_fingerprint: sha256Schema,
  root_path_hash: sha256Schema,
  branch: z.string().min(1).optional(),
  head_sha: z.string().min(1).optional(),
  dirty: z.boolean(),
  changed_file_count: z.number().int().nonnegative(),
  changed_files: z.array(
    z.object({
      path: repoRelativeUriSchema,
      index: gitStatusTokenSchema,
      working_tree: gitStatusTokenSchema,
      original_path: repoRelativeUriSchema.optional()
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
    .optional(),
  parents: z.array(idSchema).default([]),
  created_at: isoDateTimeSchema
});

export const evidenceFileRecordSchema = z.object({
  file_id: idSchema,
  uri: repoRelativeUriSchema,
  content_sha256: sha256Schema,
  byte_length: z.number().int().nonnegative(),
  last_seen_snapshot_id: idSchema,
  deleted_at_snapshot_id: idSchema.optional()
});

export const evidenceContentRecordSchema = z.object({
  content_sha256: sha256Schema,
  byte_length: z.number().int().nonnegative(),
  media_type: z.string().min(1),
  binary: z.boolean(),
  redacted: z.boolean(),
  storage_uri: storageUriSchema.optional(),
  sensitivity: sensitivitySchema.default("internal")
});

export const evidenceSourceClassificationSchema = z.object({
  classification_id: idSchema,
  file_id: idSchema,
  uri: repoRelativeUriSchema,
  source_sha256: sha256Schema,
  category: evidenceCategorySchema,
  sensitivity: sensitivitySchema.default("internal"),
  secret: z.boolean(),
  binary: z.boolean(),
  excluded: z.boolean(),
  excluded_reason: z.string().min(1).optional()
});

export const evidenceSymbolProofSchema = z.enum(["exact", "bounded", "partial", "unsupported"]);

export const evidenceSymbolSchema = z
  .object({
    symbol_id: idSchema,
    file_id: idSchema,
    uri: repoRelativeUriSchema,
    source_sha256: sha256Schema,
    name: z.string().min(1),
    kind: z.string().min(1),
    exported: z.boolean(),
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    col_start: z.number().int().nonnegative().optional(),
    col_end: z.number().int().nonnegative().optional(),
    proof: evidenceSymbolProofSchema.default("exact"),
    analyzer_name: z.string().trim().min(1).optional(),
    analyzer_version: z.string().trim().min(1).optional()
  })
  .refine((value) => value.line_end >= value.line_start, { message: "symbol line_end must be >= line_start" });

export const evidenceEdgeKindSchema = z.enum(["import", "re-export", "test-association", "caller", "callee"]);

export const evidenceProofSchema = z.enum(["exact", "bounded", "partial", "unsupported"]);

export const evidenceEdgeSchema = z
  .object({
    edge_id: idSchema,
    kind: evidenceEdgeKindSchema,
    from_file_id: idSchema,
    to_file_id: idSchema,
    from_uri: repoRelativeUriSchema,
    to_uri: repoRelativeUriSchema,
    rule: z.string().min(1),
    resolution: z.enum(["static", "heuristic"]).default("heuristic"),
    proof: evidenceProofSchema.default("exact"),
    analyzer_name: z.string().trim().min(1).optional(),
    analyzer_version: z.string().trim().min(1).optional(),
    from_source_sha256: sha256Schema.optional(),
    to_source_sha256: sha256Schema.optional(),
    from_line_start: z.number().int().positive().optional(),
    from_line_end: z.number().int().positive().optional(),
    from_col_start: z.number().int().nonnegative().optional(),
    from_col_end: z.number().int().nonnegative().optional(),
    to_line_start: z.number().int().positive().optional(),
    to_line_end: z.number().int().positive().optional(),
    to_col_start: z.number().int().nonnegative().optional(),
    to_col_end: z.number().int().nonnegative().optional()
  })
  .refine((value) => (value.kind === "caller" || value.kind === "callee") ? value.resolution === "static" : true, {
    message: "caller/callee edges require static resolution"
  });

export const evidenceTestAssociationSchema = z.object({
  association_id: idSchema,
  test_file_id: idSchema,
  source_file_id: idSchema,
  test_uri: repoRelativeUriSchema,
  source_uri: repoRelativeUriSchema,
  rule: z.string().min(1),
  proof: evidenceProofSchema.default("exact").optional(),
  analyzer_name: z.string().trim().min(1).optional(),
  analyzer_version: z.string().trim().min(1).optional(),
  source_sha256: sha256Schema.optional(),
  test_sha256: sha256Schema.optional(),
  line_start: z.number().int().positive().optional(),
  line_end: z.number().int().positive().optional(),
  col_start: z.number().int().nonnegative().optional(),
  col_end: z.number().int().nonnegative().optional()
});

export const evidenceConfigEvidenceSchema = z.object({
  config_evidence_id: idSchema,
  uri: repoRelativeUriSchema,
  source_sha256: sha256Schema,
  byte_length: z.number().int().nonnegative(),
  format: z.string().min(1),
  secret_redacted: z.boolean(),
  analyzer_name: z.string().trim().min(1).optional(),
  analyzer_version: z.string().trim().min(1).optional(),
  proof: evidenceProofSchema.default("exact").optional()
});

export const evidenceApiSurfaceSchema = z.enum(["cli-command", "exported-function", "http-endpoint"]);

export const evidenceApiEvidenceSchema = z
  .object({
    api_evidence_id: idSchema,
    file_id: idSchema,
    uri: repoRelativeUriSchema,
    source_sha256: sha256Schema,
    name: z.string().min(1),
    surface: evidenceApiSurfaceSchema,
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    col_start: z.number().int().nonnegative().optional(),
    col_end: z.number().int().nonnegative().optional(),
    proof: evidenceProofSchema.default("exact").optional(),
    analyzer_name: z.string().trim().min(1).optional(),
    analyzer_version: z.string().trim().min(1).optional()
  })
  .refine((value) => value.line_end >= value.line_start, { message: "api evidence line_end must be >= line_start" });

export const analyzerCapabilitySchema = z.object({
  capability_id: idSchema,
  analyzer_name: z.string().trim().min(1),
  analyzer_version: z.string().trim().min(1),
  languages: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string().min(1)).default([]),
  unsupported: z.array(z.string().min(1)).default([]),
  gaps: z.array(z.string().min(1)).default([])
});

export const analyzerGapSeveritySchema = z.enum(["blocking", "warning", "info"]);

export const analyzerGapSchema = z.object({
  gap_id: idSchema,
  analyzer_name: z.string().trim().min(1),
  analyzer_version: z.string().trim().min(1),
  code: z.string().min(1),
  severity: analyzerGapSeveritySchema,
  scope_uri: repoRelativeUriSchema.optional(),
  message: z.string().min(1),
  blocking: z.boolean().default(false),
  capability: z.string().min(1).optional(),
  created_at: isoDateTimeSchema.optional()
});

export const evidenceIndexStatusSchema = z.enum(["building", "current", "superseded", "invalid"]);

export const evidenceEntityTypeSchema = z.enum([
  "file",
  "content",
  "classification",
  "symbol",
  "edge",
  "test_association",
  "config_evidence",
  "api_evidence"
]);

export const evidenceInvalidationReasonSchema = z.enum([
  "file-changed",
  "file-deleted",
  "git-reset",
  "config-changed",
  "manual-rebuild"
]);

export const invalidationMetadataSchema = z.object({
  invalidation_id: idSchema,
  entity_type: evidenceEntityTypeSchema,
  entity_id: idSchema,
  valid_from_snapshot_id: idSchema,
  invalidated_in_snapshot_id: idSchema.optional(),
  reason: evidenceInvalidationReasonSchema,
  recorded_at: isoDateTimeSchema,
  observed_at: isoDateTimeSchema.optional()
});

export const evidenceEntryCountsSchema = z.object({
  files: z.number().int().nonnegative(),
  contents: z.number().int().nonnegative(),
  classifications: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  test_associations: z.number().int().nonnegative(),
  config_evidence: z.number().int().nonnegative(),
  api_evidence: z.number().int().nonnegative(),
  gaps: z.number().int().nonnegative().optional()
});

export const evidenceEngineStateSchema = z.object({
  engine_version: z.literal(1),
  k0: sha256Schema,
  config_sha256: sha256Schema.optional()
});

export const indexPayloadSchema = z.object({
  repository: evidenceRepositoryIdentitySchema,
  git_snapshot: evidenceGitSnapshotSchema.optional(),
  engine: evidenceEngineStateSchema.optional(),
  files: z.array(evidenceFileRecordSchema).default([]),
  contents: z.array(evidenceContentRecordSchema).default([]),
  classifications: z.array(evidenceSourceClassificationSchema).default([]),
  symbols: z.array(evidenceSymbolSchema).default([]),
  edges: z.array(evidenceEdgeSchema).default([]),
  test_associations: z.array(evidenceTestAssociationSchema).default([]),
  config_evidence: z.array(evidenceConfigEvidenceSchema).default([]),
  api_evidence: z.array(evidenceApiEvidenceSchema).default([]),
  gaps: z.array(analyzerGapSchema).default([]),
  invalidations: z.array(invalidationMetadataSchema).default([])
});

export const indexSnapshotSchema = z.object({
  snapshot_id: idSchema,
  schema_version: z.literal(EVIDENCE_INDEX_SCHEMA_VERSION),
  repository_id: idSchema,
  git_snapshot_id: idSchema.optional(),
  status: evidenceIndexStatusSchema,
  supersedes_snapshot_id: idSchema.optional(),
  analyzer_capabilities: z.array(analyzerCapabilitySchema).default([]),
  entry_counts: evidenceEntryCountsSchema,
  created_at: isoDateTimeSchema,
  relevant_inputs_sha256: sha256Schema,
  payload_sha256: sha256Schema
});

export const TYPESCRIPT_ANALYZER_NAME = "typescript-analyzer-v2" as const;
export const TYPESCRIPT_ANALYZER_VERSION = "2.0.0" as const;

export const analyzerStatusSchema = z.enum(["completed", "partial", "unsupported", "cancelled", "failed"]);

export type EvidenceRepositoryIdentity = z.infer<typeof evidenceRepositoryIdentitySchema>;
export type EvidenceGitSnapshot = z.infer<typeof evidenceGitSnapshotSchema>;
export type EvidenceFileRecord = z.infer<typeof evidenceFileRecordSchema>;
export type EvidenceContentRecord = z.infer<typeof evidenceContentRecordSchema>;
export type EvidenceSourceClassification = z.infer<typeof evidenceSourceClassificationSchema>;
export type EvidenceSymbol = z.infer<typeof evidenceSymbolSchema>;
export type EvidenceEdge = z.infer<typeof evidenceEdgeSchema>;
export type EvidenceTestAssociation = z.infer<typeof evidenceTestAssociationSchema>;
export type EvidenceConfigEvidence = z.infer<typeof evidenceConfigEvidenceSchema>;
export type EvidenceApiEvidence = z.infer<typeof evidenceApiEvidenceSchema>;
export type AnalyzerCapability = z.infer<typeof analyzerCapabilitySchema>;
export type AnalyzerGap = z.infer<typeof analyzerGapSchema>;
export type AnalyzerGapSeverity = z.infer<typeof analyzerGapSeveritySchema>;
export type AnalyzerStatus = z.infer<typeof analyzerStatusSchema>;
export type EvidenceSymbolProof = z.infer<typeof evidenceSymbolProofSchema>;
export type EvidenceProof = z.infer<typeof evidenceProofSchema>;
export type InvalidationMetadata = z.infer<typeof invalidationMetadataSchema>;
export type EvidenceEntryCounts = z.infer<typeof evidenceEntryCountsSchema>;
export type EvidenceIndexPayload = z.infer<typeof indexPayloadSchema>;
export type EvidenceInvalidationReason = z.infer<typeof evidenceInvalidationReasonSchema>;
export type EvidenceSensitivity = z.infer<typeof sensitivitySchema>;
export type EvidenceIndexSnapshot = z.infer<typeof indexSnapshotSchema>;
