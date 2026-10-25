import { createHash } from "node:crypto";

import {
  ArtifactIntegrityError,
  MigrationError,
  PersistenceError,
  canonicalJson,
  deriveEvidenceRepositoryIdentity,
  deriveId,
  type DerivedEvidenceRepositoryIdentity,
  type EvidenceRepositoryIdentityInput
} from "@atlas/domain";
import type initSqlJs from "sql.js";
import {
  EVIDENCE_INDEX_SCHEMA_VERSION,
  analyzerCapabilitySchema,
  analyzerGapSchema,
  evidenceCategorySchema,
  evidenceEntityTypeSchema,
  evidenceInvalidationReasonSchema,
  indexPayloadSchema,
  indexSnapshotSchema,
  type AnalyzerCapability,
  type AnalyzerGap,
  type EvidenceEntryCounts,
  type EvidenceIndexPayload,
  type EvidenceIndexSnapshot
} from "@atlas/schemas";

import { coreMigrations } from "./core-schema.js";
import { type SqlDatabase, optionalString, queryAll, queryOne, requiredNumber, requiredString } from "./sql.js";

export const MAX_KNOWN_CORE_MIGRATION_VERSION = coreMigrations[coreMigrations.length - 1]?.version ?? 0;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export { deriveEvidenceRepositoryIdentity };
export type { DerivedEvidenceRepositoryIdentity, EvidenceRepositoryIdentityInput };

export interface EvidenceRepositoryRecord {
  readonly repositoryId: string;
  readonly rootPathHash: string;
  readonly remoteUrlHash?: string | undefined;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface EvidenceGitSnapshotRecord {
  readonly snapshotId: string;
  readonly repositoryId: string;
  readonly fingerprint: string;
  readonly baseFingerprint: string;
  readonly branch?: string | undefined;
  readonly headSha?: string | undefined;
  readonly dirty: boolean;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface CreateEvidenceGitSnapshotInput {
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly baseFingerprint: string;
  readonly branch?: string | undefined;
  readonly headSha?: string | undefined;
  readonly dirty: boolean;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface EvidenceFileRow {
  readonly fileId: string;
  readonly repositoryId: string;
  readonly uri: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly lastSeenSnapshotId: string;
  readonly deletedAtSnapshotId?: string | undefined;
}

export interface CreateEvidenceFileInput extends Omit<EvidenceFileRow, "repositoryId"> {
  readonly repositoryId: string;
}

export interface EvidenceContentRow {
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly binary: boolean;
  readonly redacted: boolean;
  readonly sensitivity?: string | undefined;
  readonly storageUri?: string | undefined;
}

export interface EvidenceClassificationRow {
  readonly classificationId: string;
  readonly repositoryId: string;
  readonly fileId?: string | undefined;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly category: string;
  readonly sensitivity: string;
  readonly secret: boolean;
  readonly binaryCheck: boolean;
  readonly excluded: boolean;
  readonly excludedReason?: string | undefined;
}

export interface EvidenceSymbolRow {
  readonly symbolId: string;
  readonly repositoryId: string;
  readonly fileId: string;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly name: string;
  readonly kind: string;
  readonly exported: boolean;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly colStart?: number | undefined;
  readonly colEnd?: number | undefined;
  readonly proof?: string | undefined;
  readonly analyzerName?: string | undefined;
  readonly analyzerVersion?: string | undefined;
}

export interface EvidenceEdgeRow {
  readonly edgeId: string;
  readonly repositoryId: string;
  readonly kind: string;
  readonly fromFileId: string;
  readonly toFileId: string;
  readonly fromUri: string;
  readonly toUri: string;
  readonly rule: string;
  readonly resolution: "static" | "heuristic";
  readonly proof?: string | undefined;
  readonly analyzerName?: string | undefined;
  readonly analyzerVersion?: string | undefined;
  readonly fromSourceSha256?: string | undefined;
  readonly toSourceSha256?: string | undefined;
  readonly fromLineStart?: number | undefined;
  readonly fromLineEnd?: number | undefined;
  readonly fromColStart?: number | undefined;
  readonly fromColEnd?: number | undefined;
  readonly toLineStart?: number | undefined;
  readonly toLineEnd?: number | undefined;
  readonly toColStart?: number | undefined;
  readonly toColEnd?: number | undefined;
}

export interface EvidenceTestAssociationRow {
  readonly associationId: string;
  readonly repositoryId: string;
  readonly testFileId: string;
  readonly sourceFileId: string;
  readonly testUri: string;
  readonly sourceUri: string;
  readonly rule: string;
  readonly proof?: string | undefined;
  readonly analyzerName?: string | undefined;
  readonly analyzerVersion?: string | undefined;
  readonly sourceSha256?: string | undefined;
  readonly testSha256?: string | undefined;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
  readonly colStart?: number | undefined;
  readonly colEnd?: number | undefined;
}

export interface EvidenceConfigEvidenceRow {
  readonly configEvidenceId: string;
  readonly repositoryId: string;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly byteLength: number;
  readonly format: string;
  readonly secretRedacted: boolean;
  readonly analyzerName?: string | undefined;
  readonly analyzerVersion?: string | undefined;
  readonly proof?: string | undefined;
}

export interface EvidenceApiEvidenceRow {
  readonly apiEvidenceId: string;
  readonly repositoryId: string;
  readonly fileId: string;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly name: string;
  readonly surface: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly colStart?: number | undefined;
  readonly colEnd?: number | undefined;
  readonly proof?: string | undefined;
  readonly analyzerName?: string | undefined;
  readonly analyzerVersion?: string | undefined;
}

export interface EvidenceAnalyzerGapRow {
  readonly gapId: string;
  readonly repositoryId: string;
  readonly snapshotId?: string | undefined;
  readonly analyzerName: string;
  readonly analyzerVersion: string;
  readonly code: string;
  readonly severity: string;
  readonly scopeUri?: string | undefined;
  readonly message: string;
  readonly blocking: boolean;
  readonly capability?: string | undefined;
  readonly createdAt: string;
}

export interface EvidenceAnalyzerCapabilityRow {
  readonly capabilityId: string;
  readonly repositoryId: string;
  readonly analyzerName: string;
  readonly analyzerVersion: string;
  readonly capability: AnalyzerCapability;
}

export interface EvidenceInvalidationRow {
  readonly invalidationId: string;
  readonly repositoryId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly validFromSnapshotId: string;
  readonly invalidatedInSnapshotId?: string | undefined;
  readonly reason: string;
  readonly recordedAt: string;
}

export interface CommitIndexSnapshotInput {
  readonly repository: EvidenceRepositoryIdentityInput;
  readonly gitSnapshot?: CreateEvidenceGitSnapshotInput | undefined;
  readonly engine?: EvidenceEngineState | undefined;
  readonly relevantInputsSha256: string;
  readonly analyzers?: readonly AnalyzerCapability[] | undefined;
  readonly files?: readonly EvidenceFileRow[] | undefined;
  readonly contents?: readonly EvidenceContentRow[] | undefined;
  readonly classifications?: readonly EvidenceClassificationRow[] | undefined;
  readonly symbols?: readonly EvidenceSymbolRow[] | undefined;
  readonly edges?: readonly EvidenceEdgeRow[] | undefined;
  readonly testAssociations?: readonly EvidenceTestAssociationRow[] | undefined;
  readonly configEvidence?: readonly EvidenceConfigEvidenceRow[] | undefined;
  readonly apiEvidence?: readonly EvidenceApiEvidenceRow[] | undefined;
  readonly gaps?: readonly EvidenceAnalyzerGapRow[] | undefined;
  readonly invalidations?: readonly EvidenceInvalidationRow[] | undefined;
  readonly supersedesSnapshotId?: string | undefined;
  readonly createdAt: string;
}

export interface EvidenceEngineState {
  readonly engineVersion: number;
  readonly k0: string;
  readonly configSha256?: string | undefined;
}

export interface CommitIndexSnapshotResult {
  readonly snapshot: EvidenceIndexSnapshot;
  readonly payloadBytes: number;
}

export interface CurrentEvidenceIndexSnapshot {
  readonly snapshot: EvidenceIndexSnapshot;
  readonly payload: EvidenceIndexPayload;
}

export function withImmediateTransaction<T>(db: SqlDatabase, fn: () => T): T {
  db.run("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.run("COMMIT;");
    return result;
  } catch (error) {
    db.run("ROLLBACK;");
    throw error;
  }
}

export function commitIndexSnapshot(db: SqlDatabase, input: CommitIndexSnapshotInput): CommitIndexSnapshotResult {
  return withImmediateTransaction(db, () => commitIndexSnapshotInsideTransaction(db, input));
}

function commitIndexSnapshotInsideTransaction(
  db: SqlDatabase,
  input: CommitIndexSnapshotInput
): CommitIndexSnapshotResult {
  if (!SHA256_PATTERN.test(input.relevantInputsSha256)) {
    throw new PersistenceError("relevant_inputs_sha256 must be a lowercase SHA-256 hex digest");
  }

  const identity = deriveEvidenceRepositoryIdentity(input.repository);
  rejectForeignRepositoryRows(identity, input);
  upsertEvidenceRepository(db, identity, input.createdAt);

  let gitSnapshotId: string | undefined;
  if (input.gitSnapshot !== undefined) {
    insertEvidenceGitSnapshot(db, input.gitSnapshot);
    gitSnapshotId = input.gitSnapshot.snapshotId;
  }

  const files = input.files ?? [];
  const contents = input.contents ?? [];
  const classifications = input.classifications ?? [];
  const symbols = input.symbols ?? [];
  const edges = input.edges ?? [];
  const testAssociations = input.testAssociations ?? [];
  const configEvidence = input.configEvidence ?? [];
  const apiEvidence = input.apiEvidence ?? [];
  const gaps = input.gaps ?? [];
  const invalidations = input.invalidations ?? [];

  for (const content of contents) {
    upsertEvidenceContent(db, content);
  }
  for (const file of files) {
    upsertEvidenceFile(db, file);
  }
  for (const classification of classifications) {
    upsertEvidenceClassification(db, classification);
  }
  for (const symbol of symbols) {
    upsertEvidenceSymbol(db, symbol);
  }
  for (const edge of edges) {
    upsertEvidenceEdge(db, edge);
  }
  for (const association of testAssociations) {
    upsertEvidenceTestAssociation(db, association);
  }
  for (const config of configEvidence) {
    upsertEvidenceConfigEvidence(db, config);
  }
  for (const api of apiEvidence) {
    upsertEvidenceApiEvidence(db, api);
  }
  for (const gap of gaps) {
    upsertEvidenceAnalyzerGap(db, gap);
  }
  for (const analyzer of input.analyzers ?? []) {
    upsertEvidenceAnalyzerCapability(db, identity.repositoryId, analyzer);
  }
  for (const invalidation of invalidations) {
    insertEvidenceInvalidation(db, invalidation);
  }

  const entryCounts: EvidenceEntryCounts = {
    files: files.length,
    contents: contents.length,
    classifications: classifications.length,
    symbols: symbols.length,
    edges: edges.length,
    test_associations: testAssociations.length,
    config_evidence: configEvidence.length,
    api_evidence: apiEvidence.length,
    gaps: gaps.length
  };

  const payloadCandidate = {
    repository: {
      repository_id: identity.repositoryId,
      display_name: identity.displayName,
      root_path_hash: identity.rootPathHash,
      ...(identity.remoteUrlHash === undefined ? {} : { remote_url_hash: identity.remoteUrlHash }),
      created_at: input.createdAt
    },
    ...(input.gitSnapshot === undefined
      ? {}
      : { git_snapshot: gitSnapshotPayload(input.gitSnapshot, identity.rootPathHash) }),
    files: files.map((file) => ({
      file_id: file.fileId,
      uri: file.uri,
      content_sha256: file.contentSha256,
      byte_length: file.byteLength,
      last_seen_snapshot_id: file.lastSeenSnapshotId,
      ...(file.deletedAtSnapshotId === undefined ? {} : { deleted_at_snapshot_id: file.deletedAtSnapshotId })
    })),
    contents: contents.map((content) => ({
      content_sha256: content.contentSha256,
      byte_length: content.byteLength,
      media_type: content.mediaType,
      binary: content.binary,
      redacted: content.redacted,
      ...(content.storageUri === undefined ? {} : { storage_uri: content.storageUri }),
      sensitivity: content.sensitivity ?? "internal"
    })),
    classifications: classifications.map((classification) => ({
      classification_id: classification.classificationId,
      ...(classification.fileId === undefined ? {} : { file_id: classification.fileId }),
      uri: classification.uri,
      source_sha256: classification.sourceSha256,
      category: classification.category,
      sensitivity: classification.sensitivity,
      secret: classification.secret,
      binary: classification.binaryCheck,
      excluded: classification.excluded,
      ...(classification.excludedReason === undefined ? {} : { excluded_reason: classification.excludedReason })
    })),
    symbols: symbols.map((symbol) => ({
      symbol_id: symbol.symbolId,
      file_id: symbol.fileId,
      uri: symbol.uri,
      source_sha256: symbol.sourceSha256,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
      line_start: symbol.lineStart,
      line_end: symbol.lineEnd,
      ...(symbol.colStart === undefined ? {} : { col_start: symbol.colStart }),
      ...(symbol.colEnd === undefined ? {} : { col_end: symbol.colEnd }),
      ...(symbol.proof === undefined ? {} : { proof: symbol.proof }),
      ...(symbol.analyzerName === undefined ? {} : { analyzer_name: symbol.analyzerName }),
      ...(symbol.analyzerVersion === undefined ? {} : { analyzer_version: symbol.analyzerVersion })
    })),
    edges: edges.map((edge) => ({
      edge_id: edge.edgeId,
      kind: edge.kind,
      from_file_id: edge.fromFileId,
      to_file_id: edge.toFileId,
      from_uri: edge.fromUri,
      to_uri: edge.toUri,
      rule: edge.rule,
      resolution: edge.resolution,
      ...(edge.proof === undefined ? {} : { proof: edge.proof }),
      ...(edge.analyzerName === undefined ? {} : { analyzer_name: edge.analyzerName }),
      ...(edge.analyzerVersion === undefined ? {} : { analyzer_version: edge.analyzerVersion }),
      ...(edge.fromSourceSha256 === undefined ? {} : { from_source_sha256: edge.fromSourceSha256 }),
      ...(edge.toSourceSha256 === undefined ? {} : { to_source_sha256: edge.toSourceSha256 }),
      ...(edge.fromLineStart === undefined ? {} : { from_line_start: edge.fromLineStart }),
      ...(edge.fromLineEnd === undefined ? {} : { from_line_end: edge.fromLineEnd }),
      ...(edge.fromColStart === undefined ? {} : { from_col_start: edge.fromColStart }),
      ...(edge.fromColEnd === undefined ? {} : { from_col_end: edge.fromColEnd }),
      ...(edge.toLineStart === undefined ? {} : { to_line_start: edge.toLineStart }),
      ...(edge.toLineEnd === undefined ? {} : { to_line_end: edge.toLineEnd }),
      ...(edge.toColStart === undefined ? {} : { to_col_start: edge.toColStart }),
      ...(edge.toColEnd === undefined ? {} : { to_col_end: edge.toColEnd })
    })),
    test_associations: testAssociations.map((association) => ({
      association_id: association.associationId,
      test_file_id: association.testFileId,
      source_file_id: association.sourceFileId,
      test_uri: association.testUri,
      source_uri: association.sourceUri,
      rule: association.rule,
      ...(association.proof === undefined ? {} : { proof: association.proof }),
      ...(association.analyzerName === undefined ? {} : { analyzer_name: association.analyzerName }),
      ...(association.analyzerVersion === undefined ? {} : { analyzer_version: association.analyzerVersion }),
      ...(association.sourceSha256 === undefined ? {} : { source_sha256: association.sourceSha256 }),
      ...(association.testSha256 === undefined ? {} : { test_sha256: association.testSha256 }),
      ...(association.lineStart === undefined ? {} : { line_start: association.lineStart }),
      ...(association.lineEnd === undefined ? {} : { line_end: association.lineEnd }),
      ...(association.colStart === undefined ? {} : { col_start: association.colStart }),
      ...(association.colEnd === undefined ? {} : { col_end: association.colEnd })
    })),
    config_evidence: configEvidence.map((config) => ({
      config_evidence_id: config.configEvidenceId,
      uri: config.uri,
      source_sha256: config.sourceSha256,
      byte_length: config.byteLength,
      format: config.format,
      secret_redacted: config.secretRedacted,
      ...(config.analyzerName === undefined ? {} : { analyzer_name: config.analyzerName }),
      ...(config.analyzerVersion === undefined ? {} : { analyzer_version: config.analyzerVersion }),
      ...(config.proof === undefined ? {} : { proof: config.proof })
    })),
    api_evidence: apiEvidence.map((api) => ({
      api_evidence_id: api.apiEvidenceId,
      file_id: api.fileId,
      uri: api.uri,
      source_sha256: api.sourceSha256,
      name: api.name,
      surface: api.surface,
      line_start: api.lineStart,
      line_end: api.lineEnd,
      ...(api.colStart === undefined ? {} : { col_start: api.colStart }),
      ...(api.colEnd === undefined ? {} : { col_end: api.colEnd }),
      ...(api.proof === undefined ? {} : { proof: api.proof }),
      ...(api.analyzerName === undefined ? {} : { analyzer_name: api.analyzerName }),
      ...(api.analyzerVersion === undefined ? {} : { analyzer_version: api.analyzerVersion })
    })),
    gaps: gaps.map((gap) => ({
      gap_id: gap.gapId,
      analyzer_name: gap.analyzerName,
      analyzer_version: gap.analyzerVersion,
      code: gap.code,
      severity: gap.severity,
      ...(gap.scopeUri === undefined ? {} : { scope_uri: gap.scopeUri }),
      message: gap.message,
      blocking: gap.blocking,
      ...(gap.capability === undefined ? {} : { capability: gap.capability }),
      ...(gap.createdAt === undefined ? {} : { created_at: gap.createdAt })
    })),
    invalidations: invalidations.map((invalidation) => ({
      invalidation_id: invalidation.invalidationId,
      entity_type: invalidation.entityType,
      entity_id: invalidation.entityId,
      valid_from_snapshot_id: invalidation.validFromSnapshotId,
      ...(invalidation.invalidatedInSnapshotId === undefined
        ? {}
        : { invalidated_in_snapshot_id: invalidation.invalidatedInSnapshotId }),
      reason: invalidation.reason,
      recorded_at: invalidation.recordedAt
    })),
    ...(input.engine === undefined
      ? {}
      : {
          engine: {
            engine_version: input.engine.engineVersion,
            k0: input.engine.k0,
            ...(input.engine.configSha256 === undefined ? {} : { config_sha256: input.engine.configSha256 })
          }
        })
  };

  const payload = indexPayloadSchema.parse(payloadCandidate);
  const payloadJson = canonicalJson(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  const payloadSha256 = createHash("sha256").update(payloadJson, "utf8").digest("hex");

  const snapshotId = deriveId("idxsnap", [
    identity.repositoryId,
    gitSnapshotId ?? "",
    input.relevantInputsSha256,
    payloadSha256
  ]);

  const existing = queryOne(db, "SELECT * FROM evidence_index_snapshots WHERE snapshot_id = ?", [snapshotId]);
  if (existing !== undefined) {
    verifyStoredSnapshotIntegrity(existing);
    const storedPayloadSha256 = requiredString(existing, "payload_sha256");
    if (storedPayloadSha256 !== payloadSha256) {
      throw new ArtifactIntegrityError("Evidence index snapshot id collision with different payload bytes", {
        snapshotId,
        storedPayloadSha256,
        recomputedPayloadSha256: payloadSha256
      });
    }
    return { snapshot: parseStoredSnapshotHeader(existing), payloadBytes: Buffer.byteLength(requiredString(existing, "payload_json"), "utf8") };
  }

  const priorCurrent = queryOne(
    db,
    "SELECT snapshot_id FROM evidence_index_snapshots WHERE repository_id = ? AND status = 'current'",
    [identity.repositoryId]
  );
  if (
    input.supersedesSnapshotId !== undefined &&
    priorCurrent !== undefined &&
    requiredString(priorCurrent, "snapshot_id") !== input.supersedesSnapshotId
  ) {
    throw new PersistenceError("Superseded chain mismatch for evidence index snapshot", {
      snapshotId,
      currentSnapshotId: requiredString(priorCurrent, "snapshot_id"),
      declaredSupersedesSnapshotId: input.supersedesSnapshotId
    });
  }
  const supersedesSnapshotId =
    input.supersedesSnapshotId ??
    (priorCurrent === undefined ? undefined : requiredString(priorCurrent, "snapshot_id"));

  const headerCandidate = {
    snapshot_id: snapshotId,
    schema_version: EVIDENCE_INDEX_SCHEMA_VERSION,
    repository_id: identity.repositoryId,
    ...(gitSnapshotId === undefined ? {} : { git_snapshot_id: gitSnapshotId }),
    status: "current",
    ...(supersedesSnapshotId === undefined ? {} : { supersedes_snapshot_id: supersedesSnapshotId }),
    analyzer_capabilities: [...(input.analyzers ?? [])],
    entry_counts: entryCounts,
    created_at: input.createdAt,
    relevant_inputs_sha256: input.relevantInputsSha256,
    payload_sha256: payloadSha256
  };
  const header = indexSnapshotSchema.parse(headerCandidate);

  db.run("UPDATE evidence_index_snapshots SET status = 'superseded' WHERE repository_id = ? AND status = 'current'", [
    identity.repositoryId
  ]);

  db.run(
    `INSERT INTO evidence_index_snapshots
      (snapshot_id, repository_id, git_snapshot_id, status, supersedes_snapshot_id, schema_version,
       relevant_inputs_sha256, entry_counts_json, analyzer_capabilities_json, payload_json, payload_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      header.snapshot_id,
      header.repository_id,
      header.git_snapshot_id ?? null,
      header.status,
      header.supersedes_snapshot_id ?? null,
      header.schema_version,
      header.relevant_inputs_sha256,
      canonicalJson(header.entry_counts),
      canonicalJson(header.analyzer_capabilities),
      payloadJson,
      payloadSha256,
      header.created_at
    ]
  );

  return { snapshot: header, payloadBytes };
}

function rejectForeignRepositoryRows(
  identity: DerivedEvidenceRepositoryIdentity,
  input: CommitIndexSnapshotInput
): void {
  const expected = identity.repositoryId;
  const check = (actual: string | undefined, entity: string, key: string): void => {
    if (actual !== expected) {
      throw new PersistenceError("Cross-repository evidence rejected", {
        expectedRepositoryId: expected,
        receivedRepositoryId: actual,
        entity,
        key
      });
    }
  };

  if (input.gitSnapshot !== undefined) {
    check(input.gitSnapshot.repositoryId, "git_snapshot", input.gitSnapshot.snapshotId);
  }
  for (const file of input.files ?? []) {
    check(file.repositoryId, "file", file.uri);
  }
  for (const classification of input.classifications ?? []) {
    check(classification.repositoryId, "classification", classification.uri);
  }
  for (const symbol of input.symbols ?? []) {
    check(symbol.repositoryId, "symbol", symbol.uri);
  }
  for (const edge of input.edges ?? []) {
    check(edge.repositoryId, "edge", edge.edgeId);
  }
  for (const association of input.testAssociations ?? []) {
    check(association.repositoryId, "test_association", association.associationId);
  }
  for (const config of input.configEvidence ?? []) {
    check(config.repositoryId, "config_evidence", config.uri);
  }
  for (const api of input.apiEvidence ?? []) {
    check(api.repositoryId, "api_evidence", api.uri);
  }
  for (const gap of input.gaps ?? []) {
    check(gap.repositoryId, "gap", gap.gapId);
  }
  for (const invalidation of input.invalidations ?? []) {
    check(invalidation.repositoryId, "invalidation", invalidation.invalidationId);
  }
}

function gitSnapshotPayload(
  snapshot: CreateEvidenceGitSnapshotInput,
  rootPathHash: string
): Record<string, unknown> {
  return {
    snapshot_id: snapshot.snapshotId,
    fingerprint: snapshot.fingerprint,
    base_fingerprint: snapshot.baseFingerprint,
    root_path_hash: rootPathHash,
    ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
    ...(snapshot.headSha === undefined ? {} : { head_sha: snapshot.headSha }),
    dirty: snapshot.dirty,
    changed_file_count: countChangedFiles(snapshot.snapshot),
    changed_files: changedFilesOf(snapshot.snapshot),
    parents: parentsOf(snapshot.snapshot),
    created_at: snapshot.createdAt
  };
}

function countChangedFiles(snapshot: Readonly<Record<string, unknown>>): number {
  const value = snapshot.changed_files;
  return Array.isArray(value) ? value.length : 0;
}

function changedFilesOf(snapshot: Readonly<Record<string, unknown>>): unknown[] {
  const value = snapshot.changed_files;
  return Array.isArray(value) ? value : [];
}

function parentsOf(snapshot: Readonly<Record<string, unknown>>): string[] {
  const value = snapshot.parents;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readCurrentIndexSnapshot(
  db: SqlDatabase,
  repositoryId: string
): CurrentEvidenceIndexSnapshot | undefined {
  const row = queryOne(
    db,
    "SELECT * FROM evidence_index_snapshots WHERE repository_id = ? AND status = 'current'",
    [repositoryId]
  );
  if (row === undefined) {
    return undefined;
  }

  const schemaVersion = requiredNumber(row, "schema_version");
  if (schemaVersion > EVIDENCE_INDEX_SCHEMA_VERSION || schemaVersion < 1) {
    throw new MigrationError("Evidence index snapshot schema version is not supported", {
      storedSchemaVersion: schemaVersion,
      supportedSchemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION
    });
  }

  verifyStoredSnapshotIntegrity(row);

  const parsedPayload = indexPayloadSchema.safeParse(JSON.parse(requiredString(row, "payload_json")));
  if (!parsedPayload.success) {
    throw new ArtifactIntegrityError("Stored evidence index payload failed validation", {
      snapshotId: requiredString(row, "snapshot_id"),
      issues: parsedPayload.error.issues.slice(0, 5)
    });
  }

  const header = parseStoredSnapshotHeader(row);
  return { snapshot: header, payload: parsedPayload.data };
}

function verifyStoredSnapshotIntegrity(row: Record<string, initSqlJs.SqlValue>): void {
  const payloadJson = requiredString(row, "payload_json");
  const expectedSha256 = requiredString(row, "payload_sha256");
  const actualSha256 = createHash("sha256").update(payloadJson, "utf8").digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new ArtifactIntegrityError("Evidence index snapshot failed integrity verification", {
      snapshotId: requiredString(row, "snapshot_id"),
      expectedSha256,
      actualSha256
    });
  }
}

function parseStoredSnapshotHeader(row: Record<string, initSqlJs.SqlValue>): EvidenceIndexSnapshot {
  const payloadSha256 = requiredString(row, "payload_sha256");
  const parsedHeader = indexSnapshotSchema.safeParse({
    snapshot_id: requiredString(row, "snapshot_id"),
    schema_version: requiredNumber(row, "schema_version"),
    repository_id: requiredString(row, "repository_id"),
    git_snapshot_id: optionalString(row, "git_snapshot_id"),
    status: requiredString(row, "status"),
    supersedes_snapshot_id: optionalString(row, "supersedes_snapshot_id"),
    analyzer_capabilities: JSON.parse(requiredString(row, "analyzer_capabilities_json")),
    entry_counts: JSON.parse(requiredString(row, "entry_counts_json")),
    created_at: requiredString(row, "created_at"),
    relevant_inputs_sha256: requiredString(row, "relevant_inputs_sha256"),
    payload_sha256: payloadSha256
  });
  if (!parsedHeader.success) {
    throw new ArtifactIntegrityError("Stored evidence index snapshot failed validation", {
      snapshotId: requiredString(row, "snapshot_id"),
      issues: parsedHeader.error.issues.slice(0, 5)
    });
  }

  if (parsedHeader.data.payload_sha256 !== payloadSha256) {
    throw new ArtifactIntegrityError("Evidence index snapshot hash mismatch between header and payload", {
      snapshotId: parsedHeader.data.snapshot_id
    });
  }

  return parsedHeader.data;
}

export function assertSupportedIndexSchema(db: SqlDatabase): void {
  let appliedMaxVersion: number;
  try {
    const row = queryOne(db, "SELECT MAX(version) AS max_version FROM schema_migrations WHERE status = 'applied'");
    appliedMaxVersion = row === undefined ? 0 : Number(row.max_version);
  } catch (error) {
    throw new MigrationError("Evidence index requires applied core migrations", {}, error);
  }

  if (appliedMaxVersion > MAX_KNOWN_CORE_MIGRATION_VERSION) {
    throw new MigrationError("Database was migrated by a newer Atlas version; evidence index access is refused", {
      appliedMaxVersion,
      maxKnownVersion: MAX_KNOWN_CORE_MIGRATION_VERSION
    });
  }

  let snapshotMaxVersion: number;
  try {
    const row = queryOne(db, "SELECT MAX(schema_version) AS max_version FROM evidence_index_snapshots");
    snapshotMaxVersion = row === undefined || row.max_version === null ? 0 : Number(row.max_version);
  } catch (error) {
    throw new MigrationError("Evidence index tables are missing; run migrations first", {}, error);
  }

  if (snapshotMaxVersion > EVIDENCE_INDEX_SCHEMA_VERSION) {
    throw new MigrationError("Evidence index snapshot schema version is newer than this Atlas version supports", {
      snapshotMaxVersion,
      supportedSchemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION
    });
  }
}

export function ensureEvidenceRepository(
  db: SqlDatabase,
  input: EvidenceRepositoryIdentityInput,
  now: string
): DerivedEvidenceRepositoryIdentity {
  return upsertEvidenceRepository(db, deriveEvidenceRepositoryIdentity(input), now);
}

export type EvidenceIndexSnapshotOrder = "asc" | "desc";

export interface ListEvidenceIndexSnapshotsOptions {
  readonly limit?: number | undefined;
  readonly order?: EvidenceIndexSnapshotOrder | undefined;
}

export function listEvidenceIndexSnapshots(
  db: SqlDatabase,
  repositoryId: string,
  options: ListEvidenceIndexSnapshotsOptions = {}
): EvidenceIndexSnapshot[] {
  const limit = options.limit === undefined ? 50 : Math.max(1, Math.floor(options.limit));
  const order = options.order === "asc" ? "ASC" : "DESC";
  return queryAll(
    db,
    `SELECT * FROM evidence_index_snapshots WHERE repository_id = ? ORDER BY created_at ${order}, snapshot_id ${order} LIMIT ?`,
    [repositoryId, limit]
  ).map(parseStoredSnapshotHeader);
}

export function getEvidenceIndexSnapshotPayload(
  db: SqlDatabase,
  snapshotId: string
): CurrentEvidenceIndexSnapshot | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_index_snapshots WHERE snapshot_id = ?", [snapshotId]);
  if (row === undefined) {
    return undefined;
  }

  verifyStoredSnapshotIntegrity(row);
  const parsedPayload = indexPayloadSchema.safeParse(JSON.parse(requiredString(row, "payload_json")));
  if (!parsedPayload.success) {
    throw new ArtifactIntegrityError("Stored evidence index payload failed validation", {
      snapshotId: requiredString(row, "snapshot_id"),
      issues: parsedPayload.error.issues.slice(0, 5)
    });
  }

  return { snapshot: parseStoredSnapshotHeader(row), payload: parsedPayload.data };
}

export interface EvidenceScanCacheEntry {
  readonly repositoryId: string;
  readonly uri: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly contentSha256: string;
  readonly scannedSnapshotId: string;
}

export function getEvidenceScanCacheEntries(db: SqlDatabase, repositoryId: string): EvidenceScanCacheEntry[] {
  return queryAll(db, "SELECT * FROM evidence_scan_cache WHERE repository_id = ? ORDER BY uri", [
    repositoryId
  ]).map(mapEvidenceScanCacheEntry);
}

export function upsertEvidenceScanCacheEntries(
  db: SqlDatabase,
  entries: readonly EvidenceScanCacheEntry[]
): void {
  for (const entry of entries) {
    db.run(
      `INSERT INTO evidence_scan_cache (repository_id, uri, size, mtime_ms, content_sha256, scanned_snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repository_id, uri) DO UPDATE SET
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         content_sha256 = excluded.content_sha256,
         scanned_snapshot_id = excluded.scanned_snapshot_id`,
      [entry.repositoryId, entry.uri, entry.size, entry.mtimeMs, entry.contentSha256, entry.scannedSnapshotId]
    );
  }
}

export function deleteEvidenceScanCacheEntries(db: SqlDatabase, repositoryId: string, uris: readonly string[]): void {
  for (const uri of uris) {
    db.run("DELETE FROM evidence_scan_cache WHERE repository_id = ? AND uri = ?", [repositoryId, uri]);
  }
}

export type EvidenceIndexBuildState = "running" | "completed" | "failed" | "abandoned";

export interface EvidenceIndexBuildRecord {
  readonly buildId: string;
  readonly repositoryId: string;
  readonly state: EvidenceIndexBuildState;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly finishedAt?: string | undefined;
  readonly metricsJson?: string | undefined;
  readonly errorJson?: string | undefined;
}

export interface StartEvidenceIndexBuildInput {
  readonly buildId: string;
  readonly repositoryId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly now: string;
}

export function startEvidenceIndexBuild(db: SqlDatabase, input: StartEvidenceIndexBuildInput): EvidenceIndexBuildRecord {
  db.run(
    `INSERT INTO evidence_index_builds (build_id, repository_id, state, pid, hostname, started_at, heartbeat_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?)
     ON CONFLICT(build_id) DO NOTHING`,
    [input.buildId, input.repositoryId, input.pid, input.hostname, input.now, input.now]
  );

  const row = queryOne(db, "SELECT * FROM evidence_index_builds WHERE build_id = ?", [input.buildId]);
  if (row === undefined) {
    throw new PersistenceError("Evidence index build marker was not created", { buildId: input.buildId });
  }
  return mapEvidenceIndexBuild(row);
}

export function finishEvidenceIndexBuild(
  db: SqlDatabase,
  input: {
    readonly buildId: string;
    readonly state: Exclude<EvidenceIndexBuildState, "running" | "abandoned">;
    readonly finishedAt: string;
    readonly metricsJson?: string | undefined;
    readonly errorJson?: string | undefined;
  }
): EvidenceIndexBuildRecord | undefined {
  db.run(
    `UPDATE evidence_index_builds
     SET state = ?, finished_at = ?, metrics_json = COALESCE(?, metrics_json), error_json = COALESCE(?, error_json)
     WHERE build_id = ? AND state = 'running'`,
    [input.state, input.finishedAt, input.metricsJson ?? null, input.errorJson ?? null, input.buildId]
  );
  const row = queryOne(db, "SELECT * FROM evidence_index_builds WHERE build_id = ?", [input.buildId]);
  return row === undefined ? undefined : mapEvidenceIndexBuild(row);
}

export function abandonForeignRunningBuilds(
  db: SqlDatabase,
  input: { readonly repositoryId: string; readonly pid: number; readonly hostname: string; readonly abandonedAt: string }
): number {
  db.run(
    `UPDATE evidence_index_builds
     SET state = 'abandoned', finished_at = ?
     WHERE repository_id = ? AND state = 'running' AND (pid != ? OR hostname != ?)`,
    [input.abandonedAt, input.repositoryId, input.pid, input.hostname]
  );
  const row = queryOne(
    db,
    "SELECT COUNT(*) AS count FROM evidence_index_builds WHERE repository_id = ? AND state = 'abandoned'",
    [input.repositoryId]
  );
  return row === undefined ? 0 : Number(row.count ?? 0);
}

function mapEvidenceScanCacheEntry(row: Record<string, initSqlJs.SqlValue>): EvidenceScanCacheEntry {
  return {
    repositoryId: requiredString(row, "repository_id"),
    uri: requiredString(row, "uri"),
    size: requiredNumber(row, "size"),
    mtimeMs: Number(row.mtime_ms),
    contentSha256: requiredString(row, "content_sha256"),
    scannedSnapshotId: requiredString(row, "scanned_snapshot_id")
  };
}

function mapEvidenceIndexBuild(row: Record<string, initSqlJs.SqlValue>): EvidenceIndexBuildRecord {
  const state = requiredString(row, "state");
  if (!isEvidenceIndexBuildState(state)) {
    throw new PersistenceError("Stored evidence index build has invalid state", { state });
  }

  return {
    buildId: requiredString(row, "build_id"),
    repositoryId: requiredString(row, "repository_id"),
    state,
    pid: requiredNumber(row, "pid"),
    hostname: requiredString(row, "hostname"),
    startedAt: requiredString(row, "started_at"),
    heartbeatAt: requiredString(row, "heartbeat_at"),
    finishedAt: optionalString(row, "finished_at"),
    metricsJson: optionalString(row, "metrics_json"),
    errorJson: optionalString(row, "error_json")
  };
}

function isEvidenceIndexBuildState(value: string): value is EvidenceIndexBuildState {
  return ["running", "completed", "failed", "abandoned"].includes(value);
}

export function getEvidenceRepository(db: SqlDatabase, repositoryId: string): EvidenceRepositoryRecord | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_repositories WHERE repository_id = ?", [repositoryId]);
  return row === undefined ? undefined : mapEvidenceRepository(row);
}

export function getEvidenceRepositoryByRootPathHash(
  db: SqlDatabase,
  rootPathHash: string
): EvidenceRepositoryRecord | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_repositories WHERE root_path_hash = ?", [rootPathHash]);
  return row === undefined ? undefined : mapEvidenceRepository(row);
}

export function listEvidenceRepositories(db: SqlDatabase): EvidenceRepositoryRecord[] {
  return queryAll(db, "SELECT * FROM evidence_repositories ORDER BY created_at, repository_id").map(
    mapEvidenceRepository
  );
}

function upsertEvidenceRepository(
  db: SqlDatabase,
  identity: DerivedEvidenceRepositoryIdentity,
  createdAt: string
): EvidenceRepositoryRecord {
  const existingById = getEvidenceRepository(db, identity.repositoryId);
  const existingByRoot = getEvidenceRepositoryByRootPathHash(db, identity.rootPathHash);

  if (existingById !== undefined || existingByRoot !== undefined) {
    const existing = existingById ?? existingByRoot;
    if (
      existing === undefined ||
      existing.repositoryId !== identity.repositoryId ||
      existing.rootPathHash !== identity.rootPathHash ||
      existing.displayName !== identity.displayName ||
      existing.remoteUrlHash !== identity.remoteUrlHash
    ) {
      throw new PersistenceError("Evidence repository identity collision", {
        repositoryId: identity.repositoryId,
        rootPathHash: identity.rootPathHash,
        storedRepositoryId: existing?.repositoryId,
        storedRootPathHash: existing?.rootPathHash
      });
    }
    return existing;
  }

  db.run(
    `INSERT INTO evidence_repositories (repository_id, root_path_hash, remote_url_hash, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [identity.repositoryId, identity.rootPathHash, identity.remoteUrlHash ?? null, identity.displayName, createdAt]
  );

  const created = getEvidenceRepository(db, identity.repositoryId);
  if (created === undefined) {
    throw new PersistenceError("Evidence repository was not created", { repositoryId: identity.repositoryId });
  }
  return created;
}

export function getEvidenceGitSnapshot(
  db: SqlDatabase,
  snapshotId: string
): EvidenceGitSnapshotRecord | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_git_snapshots WHERE snapshot_id = ?", [snapshotId]);
  return row === undefined ? undefined : mapEvidenceGitSnapshot(row);
}

export function listEvidenceGitSnapshots(db: SqlDatabase, repositoryId: string): EvidenceGitSnapshotRecord[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_git_snapshots WHERE repository_id = ? ORDER BY created_at, snapshot_id",
    [repositoryId]
  ).map(mapEvidenceGitSnapshot);
}

function insertEvidenceGitSnapshot(db: SqlDatabase, input: CreateEvidenceGitSnapshotInput): void {
  db.run(
    `INSERT INTO evidence_git_snapshots
      (snapshot_id, repository_id, fingerprint, base_fingerprint, branch, head_sha, dirty, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_id) DO NOTHING`,
    [
      input.snapshotId,
      input.repositoryId,
      input.fingerprint,
      input.baseFingerprint,
      input.branch ?? null,
      input.headSha ?? null,
      input.dirty ? 1 : 0,
      canonicalJson(input.snapshot),
      input.createdAt
    ]
  );
}

export function getEvidenceFile(db: SqlDatabase, fileId: string): EvidenceFileRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_files WHERE file_id = ?", [fileId]);
  return row === undefined ? undefined : mapEvidenceFile(row);
}

export function getEvidenceFileByUri(db: SqlDatabase, repositoryId: string, uri: string): EvidenceFileRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_files WHERE repository_id = ? AND uri = ?", [repositoryId, uri]);
  return row === undefined ? undefined : mapEvidenceFile(row);
}

export function listEvidenceFiles(db: SqlDatabase, repositoryId: string): EvidenceFileRow[] {
  return queryAll(db, "SELECT * FROM evidence_files WHERE repository_id = ? ORDER BY uri", [repositoryId]).map(
    mapEvidenceFile
  );
}

export function upsertEvidenceFile(db: SqlDatabase, input: EvidenceFileRow): EvidenceFileRow {
  const stored = getEvidenceFileByUri(db, input.repositoryId, input.uri);
  if (stored !== undefined) {
    if (stored.fileId !== input.fileId) {
      throw new PersistenceError("file identity conflict", {
        repositoryId: input.repositoryId,
        uri: input.uri,
        storedFileId: stored.fileId,
        receivedFileId: input.fileId
      });
    }

    db.run(
      `UPDATE evidence_files
       SET content_sha256 = ?, byte_length = ?, last_seen_snapshot_id = ?, deleted_at_snapshot_id = ?
       WHERE file_id = ?`,
      [
        input.contentSha256,
        input.byteLength,
        input.lastSeenSnapshotId,
        input.deletedAtSnapshotId ?? null,
        stored.fileId
      ]
    );

    const updated = getEvidenceFileByUri(db, input.repositoryId, input.uri);
    if (updated === undefined) {
      throw new PersistenceError("Evidence file was not created", { fileId: input.fileId });
    }
    return updated;
  }

  db.run(
    `INSERT INTO evidence_files
      (file_id, repository_id, uri, content_sha256, byte_length, last_seen_snapshot_id, deleted_at_snapshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.fileId,
      input.repositoryId,
      input.uri,
      input.contentSha256,
      input.byteLength,
      input.lastSeenSnapshotId,
      input.deletedAtSnapshotId ?? null
    ]
  );

  const created = getEvidenceFileByUri(db, input.repositoryId, input.uri);
  if (created === undefined) {
    throw new PersistenceError("Evidence file was not created", { fileId: input.fileId });
  }
  return created;
}

export function markEvidenceFileDeleted(
  db: SqlDatabase,
  input: { readonly repositoryId: string; readonly uri: string; readonly deletedAtSnapshotId: string }
): EvidenceFileRow {
  db.run("UPDATE evidence_files SET deleted_at_snapshot_id = ? WHERE repository_id = ? AND uri = ?", [
    input.deletedAtSnapshotId,
    input.repositoryId,
    input.uri
  ]);

  const stored = getEvidenceFileByUri(db, input.repositoryId, input.uri);
  if (stored === undefined) {
    throw new PersistenceError("Evidence file not found for tombstone update", {
      repositoryId: input.repositoryId,
      uri: input.uri
    });
  }
  return stored;
}

export function getEvidenceContent(db: SqlDatabase, contentSha256: string): EvidenceContentRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_contents WHERE content_sha256 = ?", [contentSha256]);
  return row === undefined ? undefined : mapEvidenceContent(row);
}

export function listEvidenceContents(db: SqlDatabase): EvidenceContentRow[] {
  return queryAll(db, "SELECT * FROM evidence_contents ORDER BY content_sha256").map(mapEvidenceContent);
}

function upsertEvidenceContent(db: SqlDatabase, input: EvidenceContentRow): EvidenceContentRow {
  db.run(
    `INSERT INTO evidence_contents (content_sha256, byte_length, media_type, binary, redacted, sensitivity, storage_uri)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(content_sha256) DO UPDATE SET
       byte_length = excluded.byte_length,
       media_type = excluded.media_type,
       binary = excluded.binary,
       redacted = excluded.redacted,
       sensitivity = excluded.sensitivity,
       storage_uri = excluded.storage_uri`,
    [
      input.contentSha256,
      input.byteLength,
      input.mediaType,
      input.binary ? 1 : 0,
      input.redacted ? 1 : 0,
      input.sensitivity ?? "internal",
      input.storageUri ?? null
    ]
  );

  const stored = getEvidenceContent(db, input.contentSha256);
  if (stored === undefined) {
    throw new PersistenceError("Evidence content was not created", { contentSha256: input.contentSha256 });
  }
  return stored;
}

export function getEvidenceClassification(
  db: SqlDatabase,
  classificationId: string
): EvidenceClassificationRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_classifications WHERE classification_id = ?", [classificationId]);
  return row === undefined ? undefined : mapEvidenceClassification(row);
}

export function listEvidenceClassifications(db: SqlDatabase, repositoryId: string): EvidenceClassificationRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_classifications WHERE repository_id = ? ORDER BY uri, classification_id",
    [repositoryId]
  ).map(mapEvidenceClassification);
}

function upsertEvidenceClassification(db: SqlDatabase, input: EvidenceClassificationRow): EvidenceClassificationRow {
  db.run(
    `INSERT INTO evidence_classifications
      (classification_id, repository_id, file_id, uri, source_sha256, category, sensitivity, is_secret, binary_check, excluded, excluded_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(classification_id) DO UPDATE SET
       file_id = excluded.file_id,
       uri = excluded.uri,
       source_sha256 = excluded.source_sha256,
       category = excluded.category,
       sensitivity = excluded.sensitivity,
       is_secret = excluded.is_secret,
       binary_check = excluded.binary_check,
       excluded = excluded.excluded,
       excluded_reason = excluded.excluded_reason`,
    [
      input.classificationId,
      input.repositoryId,
      input.fileId ?? null,
      input.uri,
      input.sourceSha256,
      input.category,
      input.sensitivity,
      input.secret ? 1 : 0,
      input.binaryCheck ? 1 : 0,
      input.excluded ? 1 : 0,
      input.excludedReason ?? null
    ]
  );

  const stored = getEvidenceClassification(db, input.classificationId);
  if (stored === undefined) {
    throw new PersistenceError("Evidence classification was not created", {
      classificationId: input.classificationId
    });
  }
  return stored;
}

export function getEvidenceSymbol(db: SqlDatabase, symbolId: string): EvidenceSymbolRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_symbols WHERE symbol_id = ?", [symbolId]);
  return row === undefined ? undefined : mapEvidenceSymbol(row);
}

export function listEvidenceSymbols(db: SqlDatabase, repositoryId: string): EvidenceSymbolRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_symbols WHERE repository_id = ? ORDER BY uri, name, symbol_id",
    [repositoryId]
  ).map(mapEvidenceSymbol);
}

function upsertEvidenceSymbol(db: SqlDatabase, input: EvidenceSymbolRow): EvidenceSymbolRow {
  db.run(
    `INSERT INTO evidence_symbols
      (symbol_id, repository_id, file_id, uri, source_sha256, name, kind, exported, line_start, line_end, col_start, col_end, proof, analyzer_name, analyzer_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol_id) DO UPDATE SET
        file_id = excluded.file_id,
        uri = excluded.uri,
        source_sha256 = excluded.source_sha256,
        name = excluded.name,
        kind = excluded.kind,
        exported = excluded.exported,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        col_start = excluded.col_start,
        col_end = excluded.col_end,
        proof = excluded.proof,
        analyzer_name = excluded.analyzer_name,
        analyzer_version = excluded.analyzer_version`,
    [
      input.symbolId,
      input.repositoryId,
      input.fileId,
      input.uri,
      input.sourceSha256,
      input.name,
      input.kind,
      input.exported ? 1 : 0,
      input.lineStart,
      input.lineEnd,
      input.colStart ?? null,
      input.colEnd ?? null,
      input.proof ?? "exact",
      input.analyzerName ?? null,
      input.analyzerVersion ?? null
    ]
  );

  const stored = getEvidenceSymbol(db, input.symbolId);
  if (stored === undefined) {
    throw new PersistenceError("Evidence symbol was not created", { symbolId: input.symbolId });
  }
  return stored;
}

export function getEvidenceEdge(db: SqlDatabase, edgeId: string): EvidenceEdgeRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_edges WHERE edge_id = ?", [edgeId]);
  return row === undefined ? undefined : mapEvidenceEdge(row);
}

export function listEvidenceEdges(db: SqlDatabase, repositoryId: string): EvidenceEdgeRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_edges WHERE repository_id = ? ORDER BY from_uri, to_uri, kind, edge_id",
    [repositoryId]
  ).map(mapEvidenceEdge);
}

function upsertEvidenceEdge(db: SqlDatabase, input: EvidenceEdgeRow): EvidenceEdgeRow {
  db.run(
    `INSERT INTO evidence_edges
      (edge_id, repository_id, kind, from_file_id, to_file_id, from_uri, to_uri, rule, resolution, proof, analyzer_name, analyzer_version, from_source_sha256, to_source_sha256, from_line_start, from_line_end, from_col_start, from_col_end, to_line_start, to_line_end, to_col_start, to_col_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(edge_id) DO UPDATE SET
        kind = excluded.kind,
        from_file_id = excluded.from_file_id,
        to_file_id = excluded.to_file_id,
        from_uri = excluded.from_uri,
        to_uri = excluded.to_uri,
        rule = excluded.rule,
        resolution = excluded.resolution,
        proof = excluded.proof,
        analyzer_name = excluded.analyzer_name,
        analyzer_version = excluded.analyzer_version,
        from_source_sha256 = excluded.from_source_sha256,
        to_source_sha256 = excluded.to_source_sha256,
        from_line_start = excluded.from_line_start,
        from_line_end = excluded.from_line_end,
        from_col_start = excluded.from_col_start,
        from_col_end = excluded.from_col_end,
        to_line_start = excluded.to_line_start,
        to_line_end = excluded.to_line_end,
        to_col_start = excluded.to_col_start,
        to_col_end = excluded.to_col_end`,
    [
      input.edgeId,
      input.repositoryId,
      input.kind,
      input.fromFileId,
      input.toFileId,
      input.fromUri,
      input.toUri,
      input.rule,
      input.resolution,
      input.proof ?? "exact",
      input.analyzerName ?? null,
      input.analyzerVersion ?? null,
      input.fromSourceSha256 ?? null,
      input.toSourceSha256 ?? null,
      input.fromLineStart ?? null,
      input.fromLineEnd ?? null,
      input.fromColStart ?? null,
      input.fromColEnd ?? null,
      input.toLineStart ?? null,
      input.toLineEnd ?? null,
      input.toColStart ?? null,
      input.toColEnd ?? null
    ]
  );

  const stored = getEvidenceEdge(db, input.edgeId);
  if (stored === undefined) {
    throw new PersistenceError("Evidence edge was not created", { edgeId: input.edgeId });
  }
  return stored;
}

export function getEvidenceTestAssociation(
  db: SqlDatabase,
  associationId: string
): EvidenceTestAssociationRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_test_associations WHERE association_id = ?", [associationId]);
  return row === undefined ? undefined : mapEvidenceTestAssociation(row);
}

export function listEvidenceTestAssociations(
  db: SqlDatabase,
  repositoryId: string
): EvidenceTestAssociationRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_test_associations WHERE repository_id = ? ORDER BY test_uri, source_uri, association_id",
    [repositoryId]
  ).map(mapEvidenceTestAssociation);
}

function upsertEvidenceTestAssociation(db: SqlDatabase, input: EvidenceTestAssociationRow): EvidenceTestAssociationRow {
  db.run(
    `INSERT INTO evidence_test_associations
      (association_id, repository_id, test_file_id, source_file_id, test_uri, source_uri, rule, proof, analyzer_name, analyzer_version, source_sha256, test_sha256, line_start, line_end, col_start, col_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(association_id) DO UPDATE SET
        test_file_id = excluded.test_file_id,
        source_file_id = excluded.source_file_id,
        test_uri = excluded.test_uri,
        source_uri = excluded.source_uri,
        rule = excluded.rule,
        proof = excluded.proof,
        analyzer_name = excluded.analyzer_name,
        analyzer_version = excluded.analyzer_version,
        source_sha256 = excluded.source_sha256,
        test_sha256 = excluded.test_sha256,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        col_start = excluded.col_start,
        col_end = excluded.col_end`,
    [
      input.associationId,
      input.repositoryId,
      input.testFileId,
      input.sourceFileId,
      input.testUri,
      input.sourceUri,
      input.rule,
      input.proof ?? "exact",
      input.analyzerName ?? null,
      input.analyzerVersion ?? null,
      input.sourceSha256 ?? null,
      input.testSha256 ?? null,
      input.lineStart ?? null,
      input.lineEnd ?? null,
      input.colStart ?? null,
      input.colEnd ?? null
    ]
  );

  const stored = getEvidenceTestAssociation(db, input.associationId);
  if (stored === undefined) {
    throw new PersistenceError("Evidence test association was not created", { associationId: input.associationId });
  }
  return stored;
}

export function getEvidenceConfigEvidence(
  db: SqlDatabase,
  configEvidenceId: string
): EvidenceConfigEvidenceRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_config_evidence WHERE config_evidence_id = ?", [
    configEvidenceId
  ]);
  return row === undefined ? undefined : mapEvidenceConfigEvidence(row);
}

export function listEvidenceConfigEvidence(db: SqlDatabase, repositoryId: string): EvidenceConfigEvidenceRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_config_evidence WHERE repository_id = ? ORDER BY uri, config_evidence_id",
    [repositoryId]
  ).map(mapEvidenceConfigEvidence);
}

function upsertEvidenceConfigEvidence(db: SqlDatabase, input: EvidenceConfigEvidenceRow): EvidenceConfigEvidenceRow {
  db.run(
    `INSERT INTO evidence_config_evidence
      (config_evidence_id, repository_id, uri, source_sha256, byte_length, format, secret_redacted, analyzer_name, analyzer_version, proof)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(config_evidence_id) DO UPDATE SET
        uri = excluded.uri,
        source_sha256 = excluded.source_sha256,
        byte_length = excluded.byte_length,
        format = excluded.format,
        secret_redacted = excluded.secret_redacted,
        analyzer_name = excluded.analyzer_name,
        analyzer_version = excluded.analyzer_version,
        proof = excluded.proof`,
    [
      input.configEvidenceId,
      input.repositoryId,
      input.uri,
      input.sourceSha256,
      input.byteLength,
      input.format,
      input.secretRedacted ? 1 : 0,
      input.analyzerName ?? null,
      input.analyzerVersion ?? null,
      input.proof ?? "exact"
    ]
  );

  const stored = getEvidenceConfigEvidence(db, input.configEvidenceId);
  if (stored === undefined) {
    throw new PersistenceError("Evidence config record was not created", {
      configEvidenceId: input.configEvidenceId
    });
  }
  return stored;
}

export function getEvidenceApiEvidence(
  db: SqlDatabase,
  apiEvidenceId: string
): EvidenceApiEvidenceRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_api_evidence WHERE api_evidence_id = ?", [apiEvidenceId]);
  return row === undefined ? undefined : mapEvidenceApiEvidence(row);
}

export function listEvidenceApiEvidence(db: SqlDatabase, repositoryId: string): EvidenceApiEvidenceRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_api_evidence WHERE repository_id = ? ORDER BY uri, name, api_evidence_id",
    [repositoryId]
  ).map(mapEvidenceApiEvidence);
}

function upsertEvidenceApiEvidence(db: SqlDatabase, input: EvidenceApiEvidenceRow): EvidenceApiEvidenceRow {
  db.run(
    `INSERT INTO evidence_api_evidence
      (api_evidence_id, repository_id, file_id, uri, source_sha256, name, surface, line_start, line_end, col_start, col_end, proof, analyzer_name, analyzer_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(api_evidence_id) DO UPDATE SET
        file_id = excluded.file_id,
        uri = excluded.uri,
        source_sha256 = excluded.source_sha256,
        name = excluded.name,
        surface = excluded.surface,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        col_start = excluded.col_start,
        col_end = excluded.col_end,
        proof = excluded.proof,
        analyzer_name = excluded.analyzer_name,
        analyzer_version = excluded.analyzer_version`,
    [
      input.apiEvidenceId,
      input.repositoryId,
      input.fileId,
      input.uri,
      input.sourceSha256,
      input.name,
      input.surface,
      input.lineStart,
      input.lineEnd,
      input.colStart ?? null,
      input.colEnd ?? null,
      input.proof ?? "exact",
      input.analyzerName ?? null,
      input.analyzerVersion ?? null
    ]
  );

  const stored = getEvidenceApiEvidence(db, input.apiEvidenceId);
  if (stored === undefined) {
    throw new PersistenceError("Evidence API record was not created", { apiEvidenceId: input.apiEvidenceId });
  }
  return stored;
}

export function getEvidenceAnalyzerGap(db: SqlDatabase, gapId: string): EvidenceAnalyzerGapRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_analyzer_gaps WHERE gap_id = ?", [gapId]);
  return row === undefined ? undefined : mapEvidenceAnalyzerGap(row);
}

export function listEvidenceAnalyzerGaps(db: SqlDatabase, repositoryId: string): EvidenceAnalyzerGapRow[] {
  return queryAll(db, "SELECT * FROM evidence_analyzer_gaps WHERE repository_id = ? ORDER BY code, scope_uri, gap_id", [repositoryId]).map(mapEvidenceAnalyzerGap);
}

export function listEvidenceAnalyzerGapsForSnapshot(db: SqlDatabase, repositoryId: string, snapshotId: string): EvidenceAnalyzerGapRow[] {
  return queryAll(db, "SELECT * FROM evidence_analyzer_gaps WHERE repository_id = ? AND snapshot_id = ? ORDER BY code, gap_id", [repositoryId, snapshotId]).map(mapEvidenceAnalyzerGap);
}

function upsertEvidenceAnalyzerGap(db: SqlDatabase, input: EvidenceAnalyzerGapRow): EvidenceAnalyzerGapRow {
  db.run(
    `INSERT INTO evidence_analyzer_gaps (gap_id, repository_id, snapshot_id, analyzer_name, analyzer_version, code, severity, scope_uri, message, blocking, capability, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(gap_id) DO UPDATE SET
        snapshot_id = excluded.snapshot_id,
        analyzer_name = excluded.analyzer_name,
        analyzer_version = excluded.analyzer_version,
        code = excluded.code,
        severity = excluded.severity,
        scope_uri = excluded.scope_uri,
        message = excluded.message,
        blocking = excluded.blocking,
        capability = excluded.capability,
        created_at = excluded.created_at`,
    [
      input.gapId,
      input.repositoryId,
      input.snapshotId ?? null,
      input.analyzerName,
      input.analyzerVersion,
      input.code,
      input.severity,
      input.scopeUri ?? null,
      input.message,
      input.blocking ? 1 : 0,
      input.capability ?? null,
      input.createdAt
    ]
  );
  const stored = getEvidenceAnalyzerGap(db, input.gapId);
  if (stored === undefined) throw new PersistenceError("Evidence gap was not created", { gapId: input.gapId });
  return stored;
}

export function getEvidenceAnalyzerCapability(
  db: SqlDatabase,
  capabilityId: string
): EvidenceAnalyzerCapabilityRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_analyzer_capabilities WHERE capability_id = ?", [capabilityId]);
  return row === undefined ? undefined : mapEvidenceAnalyzerCapability(row);
}

export function listEvidenceAnalyzerCapabilities(
  db: SqlDatabase,
  repositoryId: string
): EvidenceAnalyzerCapabilityRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_analyzer_capabilities WHERE repository_id = ? ORDER BY analyzer_name, analyzer_version",
    [repositoryId]
  ).map(mapEvidenceAnalyzerCapability);
}

function upsertEvidenceAnalyzerCapability(
  db: SqlDatabase,
  repositoryId: string,
  capability: AnalyzerCapability
): EvidenceAnalyzerCapabilityRow {
  db.run(
    `INSERT INTO evidence_analyzer_capabilities (capability_id, repository_id, analyzer_name, analyzer_version, capability_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repository_id, analyzer_name, analyzer_version) DO UPDATE SET
       capability_id = excluded.capability_id,
       capability_json = excluded.capability_json`,
    [
      capability.capability_id,
      repositoryId,
      capability.analyzer_name,
      capability.analyzer_version,
      canonicalJson(capability)
    ]
  );

  const stored = getEvidenceAnalyzerCapability(db, capability.capability_id);
  if (stored === undefined) {
    throw new PersistenceError("Evidence analyzer capability was not created", {
      capabilityId: capability.capability_id
    });
  }
  return stored;
}

export function getEvidenceInvalidation(
  db: SqlDatabase,
  invalidationId: string
): EvidenceInvalidationRow | undefined {
  const row = queryOne(db, "SELECT * FROM evidence_invalidation WHERE invalidation_id = ?", [invalidationId]);
  return row === undefined ? undefined : mapEvidenceInvalidation(row);
}

export function listEvidenceInvalidations(db: SqlDatabase, repositoryId: string): EvidenceInvalidationRow[] {
  return queryAll(
    db,
    "SELECT * FROM evidence_invalidation WHERE repository_id = ? ORDER BY recorded_at, invalidation_id",
    [repositoryId]
  ).map(mapEvidenceInvalidation);
}

function insertEvidenceInvalidation(db: SqlDatabase, input: EvidenceInvalidationRow): EvidenceInvalidationRow {
  db.run(
    `INSERT INTO evidence_invalidation
      (invalidation_id, repository_id, entity_type, entity_id, valid_from_snapshot_id, invalidated_in_snapshot_id, reason, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(invalidation_id) DO NOTHING`,
    [
      input.invalidationId,
      input.repositoryId,
      input.entityType,
      input.entityId,
      input.validFromSnapshotId,
      input.invalidatedInSnapshotId ?? null,
      input.reason,
      input.recordedAt
    ]
  );

  const stored = getEvidenceInvalidation(db, input.invalidationId);
  if (stored === undefined) {
    throw new PersistenceError("Evidence invalidation was not created", { invalidationId: input.invalidationId });
  }
  return stored;
}

function mapEvidenceRepository(row: Record<string, initSqlJs.SqlValue>): EvidenceRepositoryRecord {
  return {
    repositoryId: requiredString(row, "repository_id"),
    rootPathHash: requiredString(row, "root_path_hash"),
    remoteUrlHash: optionalString(row, "remote_url_hash"),
    displayName: requiredString(row, "display_name"),
    createdAt: requiredString(row, "created_at")
  };
}

function mapEvidenceGitSnapshot(row: Record<string, initSqlJs.SqlValue>): EvidenceGitSnapshotRecord {
  return {
    snapshotId: requiredString(row, "snapshot_id"),
    repositoryId: requiredString(row, "repository_id"),
    fingerprint: requiredString(row, "fingerprint"),
    baseFingerprint: requiredString(row, "base_fingerprint"),
    branch: optionalString(row, "branch"),
    headSha: optionalString(row, "head_sha"),
    dirty: requiredNumber(row, "dirty") === 1,
    snapshot: JSON.parse(requiredString(row, "snapshot_json")) as Readonly<Record<string, unknown>>,
    createdAt: requiredString(row, "created_at")
  };
}

function mapEvidenceFile(row: Record<string, initSqlJs.SqlValue>): EvidenceFileRow {
  return {
    fileId: requiredString(row, "file_id"),
    repositoryId: requiredString(row, "repository_id"),
    uri: requiredString(row, "uri"),
    contentSha256: requiredString(row, "content_sha256"),
    byteLength: requiredNumber(row, "byte_length"),
    lastSeenSnapshotId: requiredString(row, "last_seen_snapshot_id"),
    deletedAtSnapshotId: optionalString(row, "deleted_at_snapshot_id")
  };
}

function mapEvidenceContent(row: Record<string, initSqlJs.SqlValue>): EvidenceContentRow {
  const sensitivity = requiredString(row, "sensitivity");
  if (!isSensitivity(sensitivity)) {
    throw new PersistenceError("Stored evidence content has invalid sensitivity", { sensitivity });
  }

  return {
    contentSha256: requiredString(row, "content_sha256"),
    byteLength: requiredNumber(row, "byte_length"),
    mediaType: requiredString(row, "media_type"),
    binary: requiredNumber(row, "binary") === 1,
    redacted: requiredNumber(row, "redacted") === 1,
    sensitivity,
    storageUri: optionalString(row, "storage_uri")
  };
}

function mapEvidenceClassification(row: Record<string, initSqlJs.SqlValue>): EvidenceClassificationRow {
  const category = requiredString(row, "category");
  if (!isEvidenceCategory(category)) {
    throw new PersistenceError("Stored evidence classification has invalid category", { category });
  }
  const sensitivity = requiredString(row, "sensitivity");
  if (!isSensitivity(sensitivity)) {
    throw new PersistenceError("Stored evidence classification has invalid sensitivity", { sensitivity });
  }

  return {
    classificationId: requiredString(row, "classification_id"),
    repositoryId: requiredString(row, "repository_id"),
    fileId: optionalString(row, "file_id"),
    uri: requiredString(row, "uri"),
    sourceSha256: requiredString(row, "source_sha256"),
    category,
    sensitivity,
    secret: requiredNumber(row, "is_secret") === 1,
    binaryCheck: requiredNumber(row, "binary_check") === 1,
    excluded: requiredNumber(row, "excluded") === 1,
    excludedReason: optionalString(row, "excluded_reason")
  };
}

function mapEvidenceSymbol(row: Record<string, initSqlJs.SqlValue>): EvidenceSymbolRow {
  return {
    symbolId: requiredString(row, "symbol_id"),
    repositoryId: requiredString(row, "repository_id"),
    fileId: requiredString(row, "file_id"),
    uri: requiredString(row, "uri"),
    sourceSha256: requiredString(row, "source_sha256"),
    name: requiredString(row, "name"),
    kind: requiredString(row, "kind"),
    exported: requiredNumber(row, "exported") === 1,
    lineStart: requiredNumber(row, "line_start"),
    lineEnd: requiredNumber(row, "line_end"),
    colStart: row.col_start === null || row.col_start === undefined ? undefined : Number(row.col_start),
    colEnd: row.col_end === null || row.col_end === undefined ? undefined : Number(row.col_end),
    proof: optionalString(row, "proof"),
    analyzerName: optionalString(row, "analyzer_name"),
    analyzerVersion: optionalString(row, "analyzer_version")
  };
}

function mapEvidenceEdge(row: Record<string, initSqlJs.SqlValue>): EvidenceEdgeRow {
  const kind = requiredString(row, "kind");
  if (!isEvidenceEdgeKind(kind)) {
    throw new PersistenceError("Stored evidence edge has invalid kind", { kind });
  }
  const resolution = requiredString(row, "resolution");
  if (resolution !== "static" && resolution !== "heuristic") {
    throw new PersistenceError("Stored evidence edge has invalid resolution", { resolution });
  }

  return {
    edgeId: requiredString(row, "edge_id"),
    repositoryId: requiredString(row, "repository_id"),
    kind,
    fromFileId: requiredString(row, "from_file_id"),
    toFileId: requiredString(row, "to_file_id"),
    fromUri: requiredString(row, "from_uri"),
    toUri: requiredString(row, "to_uri"),
    rule: requiredString(row, "rule"),
    resolution,
    proof: optionalString(row, "proof"),
    analyzerName: optionalString(row, "analyzer_name"),
    analyzerVersion: optionalString(row, "analyzer_version"),
    fromSourceSha256: optionalString(row, "from_source_sha256"),
    toSourceSha256: optionalString(row, "to_source_sha256"),
    fromLineStart: row.from_line_start === null || row.from_line_start === undefined ? undefined : Number(row.from_line_start),
    fromLineEnd: row.from_line_end === null || row.from_line_end === undefined ? undefined : Number(row.from_line_end),
    fromColStart: row.from_col_start === null || row.from_col_start === undefined ? undefined : Number(row.from_col_start),
    fromColEnd: row.from_col_end === null || row.from_col_end === undefined ? undefined : Number(row.from_col_end),
    toLineStart: row.to_line_start === null || row.to_line_start === undefined ? undefined : Number(row.to_line_start),
    toLineEnd: row.to_line_end === null || row.to_line_end === undefined ? undefined : Number(row.to_line_end),
    toColStart: row.to_col_start === null || row.to_col_start === undefined ? undefined : Number(row.to_col_start),
    toColEnd: row.to_col_end === null || row.to_col_end === undefined ? undefined : Number(row.to_col_end)
  };
}

function mapEvidenceTestAssociation(row: Record<string, initSqlJs.SqlValue>): EvidenceTestAssociationRow {
  return {
    associationId: requiredString(row, "association_id"),
    repositoryId: requiredString(row, "repository_id"),
    testFileId: requiredString(row, "test_file_id"),
    sourceFileId: requiredString(row, "source_file_id"),
    testUri: requiredString(row, "test_uri"),
    sourceUri: requiredString(row, "source_uri"),
    rule: requiredString(row, "rule"),
    proof: optionalString(row, "proof"),
    analyzerName: optionalString(row, "analyzer_name"),
    analyzerVersion: optionalString(row, "analyzer_version"),
    sourceSha256: optionalString(row, "source_sha256"),
    testSha256: optionalString(row, "test_sha256"),
    lineStart: row.line_start === null || row.line_start === undefined ? undefined : Number(row.line_start),
    lineEnd: row.line_end === null || row.line_end === undefined ? undefined : Number(row.line_end),
    colStart: row.col_start === null || row.col_start === undefined ? undefined : Number(row.col_start),
    colEnd: row.col_end === null || row.col_end === undefined ? undefined : Number(row.col_end)
  };
}

function mapEvidenceConfigEvidence(row: Record<string, initSqlJs.SqlValue>): EvidenceConfigEvidenceRow {
  return {
    configEvidenceId: requiredString(row, "config_evidence_id"),
    repositoryId: requiredString(row, "repository_id"),
    uri: requiredString(row, "uri"),
    sourceSha256: requiredString(row, "source_sha256"),
    byteLength: requiredNumber(row, "byte_length"),
    format: requiredString(row, "format"),
    secretRedacted: requiredNumber(row, "secret_redacted") === 1,
    analyzerName: optionalString(row, "analyzer_name"),
    analyzerVersion: optionalString(row, "analyzer_version"),
    proof: optionalString(row, "proof")
  };
}

function mapEvidenceApiEvidence(row: Record<string, initSqlJs.SqlValue>): EvidenceApiEvidenceRow {
  const surface = requiredString(row, "surface");
  if (!isEvidenceApiSurface(surface)) {
    throw new PersistenceError("Stored evidence API record has invalid surface", { surface });
  }

  return {
    apiEvidenceId: requiredString(row, "api_evidence_id"),
    repositoryId: requiredString(row, "repository_id"),
    fileId: requiredString(row, "file_id"),
    uri: requiredString(row, "uri"),
    sourceSha256: requiredString(row, "source_sha256"),
    name: requiredString(row, "name"),
    surface,
    lineStart: requiredNumber(row, "line_start"),
    lineEnd: requiredNumber(row, "line_end"),
    colStart: row.col_start === null || row.col_start === undefined ? undefined : Number(row.col_start),
    colEnd: row.col_end === null || row.col_end === undefined ? undefined : Number(row.col_end),
    proof: optionalString(row, "proof"),
    analyzerName: optionalString(row, "analyzer_name"),
    analyzerVersion: optionalString(row, "analyzer_version")
  };
}

function mapEvidenceAnalyzerGap(row: Record<string, initSqlJs.SqlValue>): EvidenceAnalyzerGapRow {
  return {
    gapId: requiredString(row, "gap_id"),
    repositoryId: requiredString(row, "repository_id"),
    snapshotId: optionalString(row, "snapshot_id"),
    analyzerName: requiredString(row, "analyzer_name"),
    analyzerVersion: requiredString(row, "analyzer_version"),
    code: requiredString(row, "code"),
    severity: requiredString(row, "severity"),
    scopeUri: optionalString(row, "scope_uri"),
    message: requiredString(row, "message"),
    blocking: requiredNumber(row, "blocking") === 1,
    capability: optionalString(row, "capability"),
    createdAt: requiredString(row, "created_at")
  };
}

function mapEvidenceAnalyzerCapability(row: Record<string, initSqlJs.SqlValue>): EvidenceAnalyzerCapabilityRow {
  const parsed = analyzerCapabilitySchema.safeParse(JSON.parse(requiredString(row, "capability_json")));
  if (!parsed.success) {
    throw new PersistenceError("Stored evidence analyzer capability failed validation", {
      capabilityId: requiredString(row, "capability_id"),
      issues: parsed.error.issues.slice(0, 5)
    });
  }

  return {
    capabilityId: requiredString(row, "capability_id"),
    repositoryId: requiredString(row, "repository_id"),
    analyzerName: requiredString(row, "analyzer_name"),
    analyzerVersion: requiredString(row, "analyzer_version"),
    capability: parsed.data
  };
}

function mapEvidenceInvalidation(row: Record<string, initSqlJs.SqlValue>): EvidenceInvalidationRow {
  const entityType = requiredString(row, "entity_type");
  if (!isEvidenceEntityType(entityType)) {
    throw new PersistenceError("Stored evidence invalidation has invalid entity type", { entityType });
  }
  const reason = requiredString(row, "reason");
  if (!isEvidenceInvalidationReason(reason)) {
    throw new PersistenceError("Stored evidence invalidation has invalid reason", { reason });
  }

  return {
    invalidationId: requiredString(row, "invalidation_id"),
    repositoryId: requiredString(row, "repository_id"),
    entityType,
    entityId: requiredString(row, "entity_id"),
    validFromSnapshotId: requiredString(row, "valid_from_snapshot_id"),
    invalidatedInSnapshotId: optionalString(row, "invalidated_in_snapshot_id"),
    reason,
    recordedAt: requiredString(row, "recorded_at")
  };
}

function isEvidenceCategory(value: string): boolean {
  return evidenceCategorySchema.safeParse(value).success;
}

function isSensitivity(value: string): boolean {
  return ["public", "internal", "confidential", "secret-redacted"].includes(value);
}

function isEvidenceEdgeKind(value: string): boolean {
  return ["import", "re-export", "test-association", "caller", "callee"].includes(value);
}

function isEvidenceApiSurface(value: string): boolean {
  return ["cli-command", "exported-function", "http-endpoint"].includes(value);
}

function isEvidenceEntityType(value: string): boolean {
  return evidenceEntityTypeSchema.safeParse(value).success;
}

function isEvidenceInvalidationReason(value: string): boolean {
  return evidenceInvalidationReasonSchema.safeParse(value).success;
}
