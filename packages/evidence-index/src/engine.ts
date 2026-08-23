import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { hostname } from "node:os";

import {
  ArtifactIntegrityError,
  CancellationError,
  PersistenceError,
  canonicalizeRepositoryRootPath,
  deriveEvidenceRepositoryIdentity,
  deriveId,
  stableHash
} from "@atlas/domain";
import type { SqlDatabase } from "@atlas/persistence";
import {
  abandonForeignRunningBuilds,
  assertSupportedIndexSchema,
  commitIndexSnapshot,
  deleteEvidenceScanCacheEntries,
  finishEvidenceIndexBuild,
  ensureEvidenceRepository,
  getEvidenceScanCacheEntries,
  queryOne,
  readCurrentIndexSnapshot,
  saveDatabase,
  startEvidenceIndexBuild,
  upsertEvidenceScanCacheEntries,
  type EvidenceApiEvidenceRow,
  type EvidenceConfigEvidenceRow,
  type EvidenceEdgeRow,
  type EvidenceSymbolRow,
  type EvidenceTestAssociationRow
} from "@atlas/persistence";
import { EVIDENCE_INDEX_SCHEMA_VERSION, type AnalyzerCapability, type EvidenceInvalidationReason } from "@atlas/schemas";

import { tryReadEvidenceGitFacts, type EvidenceGitFacts } from "./git-evidence.js";
import { buildIncrementalPayload, type IncrementalBuildOutput } from "./invalidation.js";
import { createMetricsAccumulator, finalizeMetrics } from "./metrics.js";
import { hashAndClassifyFile, throwIfAborted, walkRepositoryCandidates, type HashedFileEvidence } from "./scan.js";
import type { EvidenceIndexEngineOptions, EvidenceIndexUpdateResult, UpdateOutcome } from "./types.js";

const ENGINE_VERSION = 1;
const CANCELLATION_CHECK_INTERVAL = 64;

export interface EvidenceIndexEngineInternalOptions extends EvidenceIndexEngineOptions {
  readonly saveImplementation?: ((dbPath: string, database: SqlDatabase) => void) | undefined;
}

export function updateEvidenceIndex(
  db: SqlDatabase,
  options: EvidenceIndexEngineInternalOptions
): EvidenceIndexUpdateResult {
  const persist = options.saveImplementation ?? saveDatabase;
  assertSupportedIndexSchema(db);
  const startedAtMs = Date.now();
  const now = options.now ?? (() => new Date());
  const accumulator = createMetricsAccumulator();

  throwIfAborted(options.signal);

  const resolvedRoot = resolve(options.rootPath);
  const canonicalRoot = canonicalizeRepositoryRootPath(resolvedRoot);
  if (canonicalRoot.length === 0) {
    throw new PersistenceError("Evidence index root path is required");
  }
  const displayName =
    options.displayName ?? (canonicalRoot === "/" ? "root" : basename(canonicalRoot) || canonicalRoot);
  const identity = deriveEvidenceRepositoryIdentity({ displayName, rootPath: resolvedRoot });

  const gitFacts = tryReadEvidenceGitFacts(resolvedRoot);
  if (gitFacts === undefined) {
    throw new PersistenceError("Evidence index requires a Git work tree", { rootPath: canonicalRoot });
  }

  ensureEvidenceRepository(db, { displayName, rootPath: resolvedRoot }, now().toISOString());

  abandonForeignRunningBuilds(db, {
    repositoryId: identity.repositoryId,
    pid: process.pid,
    hostname: hostname(),
    abandonedAt: now().toISOString()
  });

  let previous: ReturnType<typeof readCurrentIndexSnapshot> | undefined;
  let baselineUnreadable = false;
  try {
    previous = readCurrentIndexSnapshot(db, identity.repositoryId);
  } catch (error) {
    if (!options.forceRebuild || !(error instanceof ArtifactIntegrityError)) {
      throw error;
    }
    baselineUnreadable = true;
    previous = undefined;
    const corrupted = queryOne(
      db,
      "SELECT snapshot_id FROM evidence_index_snapshots WHERE repository_id = ? AND status = 'current'",
      [identity.repositoryId]
    );
    if (corrupted !== undefined) {
      db.run("DELETE FROM evidence_index_snapshots WHERE snapshot_id = ?", [
        String(corrupted.snapshot_id)
      ]);
    }
  }

  const configSha256 = options.configSha256 ?? stableHash({ engine_version: ENGINE_VERSION, config: "default" });
  const analyzerVersions = [...(options.analyzerVersions ?? [])].sort(byName);

  const tierZeroKey = stableHash({
    engineVersion: ENGINE_VERSION,
    schemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION,
    configSha256,
    baseFingerprint: gitFacts.baseFingerprint,
    fingerprint: gitFacts.fingerprint,
    analyzerVersions
  });

  if (
    !options.forceRebuild &&
    previous !== undefined &&
    previous.payload.engine?.k0 === tierZeroKey &&
    !gitFacts.dirty &&
    gitFacts.untrackedCount === 0
  ) {
    return {
      repositoryId: identity.repositoryId,
      snapshotId: previous.snapshot.snapshot_id,
      metrics: finalizeMetrics(accumulator, "reused", previous.payload.engine === undefined ? 0 : Buffer.byteLength(JSON.stringify(previous.payload)), Date.now() - startedAtMs)
    };
  }

  const buildMarker = startEvidenceIndexBuild(db, {
    buildId: deriveId("evbuild", [identity.repositoryId, randomUUID()]),
    repositoryId: identity.repositoryId,
    pid: process.pid,
    hostname: hostname(),
    now: now().toISOString()
  });
  persist(options.dbPath, db);

  try {
    throwIfAborted(options.signal);

    const walk = walkRepositoryCandidates({
      rootPath: resolvedRoot,
      limits: options.limits,
      signal: options.signal,
      onProgress: (filesProcessed) => {
        accumulator.filesScanned = filesProcessed;
        options.onScanProgress?.(filesProcessed);
      }
    });
    accumulator.skippedSymlinks += walk.skippedSymlinks;
    accumulator.skippedUnsafeUris += walk.skippedUnsafeUris;

    const cacheByUri = new Map(
      getEvidenceScanCacheEntries(db, identity.repositoryId).map((entry) => [entry.uri, entry])
    );
    const gitReset =
      previous?.payload.git_snapshot !== undefined &&
      previous.payload.git_snapshot.base_fingerprint !== gitFacts.baseFingerprint;

    const hashedFiles: HashedFileEvidence[] = [];
    const cacheUpdates: Array<{
      repositoryId: string;
      uri: string;
      size: number;
      mtimeMs: number;
      contentSha256: string;
      scannedSnapshotId: string;
    }> = [];
    const cachedUris = new Set<string>();

    for (let index = 0; index < walk.candidates.length; index += 1) {
      if (index % CANCELLATION_CHECK_INTERVAL === CANCELLATION_CHECK_INTERVAL - 1) {
        throwIfAborted(options.signal);
      }
      const candidate = walk.candidates[index];
      if (candidate === undefined) continue;

      const cached = cacheByUri.get(candidate.uri);
      if (
        !gitReset &&
        cached !== undefined &&
        cached.size === candidate.size &&
        cached.mtimeMs === candidate.mtimeMs
      ) {
        accumulator.cacheHits += 1;
        const evidence = hashAndClassifyFile(resolvedRoot, candidate);
        hashedFiles.push({ ...evidence, contentSha256: cached.contentSha256 });
        cachedUris.add(candidate.uri);
        cacheUpdates.push({
          repositoryId: identity.repositoryId,
          uri: candidate.uri,
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          contentSha256: cached.contentSha256,
          scannedSnapshotId: ""
        });
        continue;
      }

      const evidence = hashAndClassifyFile(resolvedRoot, candidate);
      accumulator.filesHashed += 1;
      hashedFiles.push(evidence);
      cacheUpdates.push({
        repositoryId: identity.repositoryId,
        uri: candidate.uri,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        contentSha256: evidence.contentSha256,
        scannedSnapshotId: ""
      });
    }
    accumulator.filesScanned = Math.max(accumulator.filesScanned, walk.candidates.length);

    hashedFiles.sort((a, b) => byUri(a, b));

    const renamePairs = renamePairsFrom(gitFacts.changedFiles);
    const previousEngine = previous?.payload.engine;
    const configChanged =
      previous !== undefined && previousEngine?.config_sha256 !== undefined && previousEngine.config_sha256 !== configSha256;
    const forceManualRebuild = options.forceRebuild === true && !baselineUnreadable && previous !== undefined;

    const diff = buildIncrementalPayload({
      repositoryId: identity.repositoryId,
      referenceSnapshotId: previous?.snapshot.snapshot_id,
      previous: previous?.payload,
      hashedFiles,
      renamePairs,
      configChanged,
      gitReset,
      forceManualRebuild,
      recordedAt: now().toISOString()
    });

    accumulator.added = diff.metrics.added;
    accumulator.changed = diff.metrics.changed;
    accumulator.deleted = diff.metrics.deleted;
    accumulator.renamed = diff.metrics.renamed;
    accumulator.rowsCarriedForward = diff.metrics.rowsCarriedForward;
    for (const [reason, count] of Object.entries(diff.metrics.invalidationsByReason)) {
      addInvalidations(accumulator.invalidationsByReason, reason as keyof typeof accumulator.invalidationsByReason, count);
    }
    if (baselineUnreadable) {
      accumulator.invalidationsByReason["manual-rebuild"] += 1;
    }

    throwIfAborted(options.signal);

    const analyzerCapabilities: AnalyzerCapability[] = analyzerVersions.map((analyzer) => ({
      capability_id: deriveId("evcap", [identity.repositoryId, analyzer.name, analyzer.version]),
      analyzer_name: analyzer.name,
      analyzer_version: analyzer.version,
      capabilities: ["files", "classifications"],
      gaps: [],
      languages: [],
      unsupported: []
    }));

    const relevantInputsSha256 = stableHash({
      engineVersion: ENGINE_VERSION,
      schemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION,
      configSha256,
      analyzers: analyzerVersions,
      files: hashedFiles.map((file) => ({ path: file.uri, sha256: file.contentSha256 }))
    });

    const outcome: UpdateOutcome = baselineUnreadable || forceManualRebuild ? "rebuilt" : "updated";

    const result = commitIndexSnapshot(db, {
      repository: { displayName, rootPath: resolvedRoot },
      ...gitSnapshotInput(gitFacts, identity.repositoryId, identity.rootPathHash, now().toISOString()),
      engine: {
        engineVersion: ENGINE_VERSION,
        k0: tierZeroKey,
        ...(options.configSha256 === undefined ? {} : { configSha256 })
      },
      relevantInputsSha256,
      analyzers: analyzerCapabilities,
      files: diff.files,
      contents: diff.contents.map((content) => ({
        contentSha256: content.content_sha256,
        byteLength: content.byte_length,
        mediaType: content.media_type,
        binary: content.binary,
        redacted: content.redacted,
        sensitivity: content.sensitivity
      })),
      classifications: diff.classifications,
      symbols: diff.symbols.map((row) => toSymbolRow(identity.repositoryId, row)),
      edges: diff.edges.map((row) => toEdgeRow(identity.repositoryId, row)),
      testAssociations: diff.testAssociations.map((row) => toAssociationRow(identity.repositoryId, row)),
      configEvidence: diff.configEvidence.map((row) => toConfigRow(identity.repositoryId, row)),
      apiEvidence: diff.apiEvidence.map((row) => toApiRow(identity.repositoryId, row)),
      invalidations: diff.invalidations,
      createdAt: now().toISOString()
    });

    for (const tombstone of diff.tombstones) {
      db.run("UPDATE evidence_files SET deleted_at_snapshot_id = ? WHERE repository_id = ? AND uri = ?", [
        tombstone.deletedAtSnapshotId,
        tombstone.repositoryId,
        tombstone.uri
      ]);
    }

    upsertEvidenceScanCacheEntries(
      db,
      cacheUpdates.map((update) => ({ ...update, scannedSnapshotId: result.snapshot.snapshot_id }))
    );
    deleteEvidenceScanCacheEntries(
      db,
      identity.repositoryId,
      [...cacheByUri.keys()].filter((uri) => !cachedUris.has(uri) && !hashedFiles.some((file) => file.uri === uri))
    );

    finishEvidenceIndexBuild(db, {
      buildId: buildMarker.buildId,
      state: "completed",
      finishedAt: now().toISOString(),
      metricsJson: JSON.stringify({
        outcome,
        added: diff.metrics.added,
        changed: diff.metrics.changed,
        deleted: diff.metrics.deleted,
        renamed: diff.metrics.renamed
      })
    });
    persist(options.dbPath, db);

    return {
      repositoryId: identity.repositoryId,
      snapshotId: result.snapshot.snapshot_id,
      metrics: finalizeMetrics(accumulator, outcome, result.payloadBytes, Date.now() - startedAtMs)
    };
  } catch (error) {
    finishEvidenceIndexBuild(db, {
      buildId: buildMarker.buildId,
      state: "failed",
      finishedAt: now().toISOString(),
      errorJson: JSON.stringify({ message: error instanceof Error ? error.message : String(error) })
    });
    persist(options.dbPath, db);
    throw error;
  }
}

function addInvalidations(
  counts: Record<EvidenceInvalidationReason, number>,
  reason: EvidenceInvalidationReason,
  count: number
): void {
  counts[reason] += count;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function byUri(a: { uri: string }, b: { uri: string }): number {
  return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
}

function renamePairsFrom(
  changedFiles: readonly { index: string; path: string; originalPath?: string | undefined }[]
): Array<{ from: string; to: string }> {
  return changedFiles
    .filter((entry): entry is { index: string; path: string; originalPath: string } => entry.originalPath !== undefined)
    .map((entry) => ({ from: entry.originalPath, to: entry.path }));
}

function gitSnapshotInput(
  facts: EvidenceGitFacts,
  repositoryId: string,
  rootPathHash: string,
  createdAt: string
): { gitSnapshot: {
    repositoryId: string;
    snapshotId: string;
    fingerprint: string;
    baseFingerprint: string;
    branch?: string | undefined;
    headSha?: string | undefined;
    dirty: boolean;
    snapshot: Record<string, unknown>;
    createdAt: string;
  } } {
  return {
    gitSnapshot: {
      repositoryId,
      snapshotId: deriveId("evgit", [facts.fingerprint, facts.baseFingerprint]),
      fingerprint: facts.fingerprint,
      baseFingerprint: facts.baseFingerprint,
      ...(facts.branch === undefined ? {} : { branch: facts.branch }),
      ...(facts.headSha === undefined ? {} : { headSha: facts.headSha }),
      dirty: facts.dirty,
      snapshot: {
        fingerprint: facts.fingerprint,
        base_fingerprint: facts.baseFingerprint,
        root_path_hash: rootPathHash,
        ...(facts.branch === undefined ? {} : { branch: facts.branch }),
        ...(facts.headSha === undefined ? {} : { head_sha: facts.headSha }),
        dirty: facts.dirty,
        changed_file_count: facts.changedFiles.length,
        changed_files: facts.changedFiles.map((entry) => ({
          path: entry.path,
          index: entry.index,
          working_tree: entry.workingTree,
          ...(entry.originalPath === undefined ? {} : { original_path: entry.originalPath })
        })),
        parents: [],
        created_at: createdAt
      },
      createdAt
    }
  };
}

type PayloadSymbol = IncrementalBuildOutput["symbols"][number];
type PayloadEdge = IncrementalBuildOutput["edges"][number];
type PayloadAssociation = IncrementalBuildOutput["testAssociations"][number];
type PayloadConfig = IncrementalBuildOutput["configEvidence"][number];
type PayloadApi = IncrementalBuildOutput["apiEvidence"][number];

function toSymbolRow(repositoryId: string, symbol: PayloadSymbol): EvidenceSymbolRow {
  return {
    symbolId: symbol.symbol_id,
    repositoryId,
    fileId: symbol.file_id,
    uri: symbol.uri,
    sourceSha256: symbol.source_sha256,
    name: symbol.name,
    kind: symbol.kind,
    exported: symbol.exported,
    lineStart: symbol.line_start,
    lineEnd: symbol.line_end
  };
}

function toEdgeRow(repositoryId: string, edge: PayloadEdge): EvidenceEdgeRow {
  return {
    edgeId: edge.edge_id,
    repositoryId,
    kind: edge.kind,
    fromFileId: edge.from_file_id,
    toFileId: edge.to_file_id,
    fromUri: edge.from_uri,
    toUri: edge.to_uri,
    rule: edge.rule,
    resolution: edge.resolution
  };
}

function toAssociationRow(repositoryId: string, association: PayloadAssociation): EvidenceTestAssociationRow {
  return {
    associationId: association.association_id,
    repositoryId,
    testFileId: association.test_file_id,
    sourceFileId: association.source_file_id,
    testUri: association.test_uri,
    sourceUri: association.source_uri,
    rule: association.rule
  };
}

function toConfigRow(repositoryId: string, config: PayloadConfig): EvidenceConfigEvidenceRow {
  return {
    configEvidenceId: config.config_evidence_id,
    repositoryId,
    uri: config.uri,
    sourceSha256: config.source_sha256,
    byteLength: config.byte_length,
    format: config.format,
    secretRedacted: config.secret_redacted
  };
}

function toApiRow(repositoryId: string, api: PayloadApi): EvidenceApiEvidenceRow {
  return {
    apiEvidenceId: api.api_evidence_id,
    repositoryId,
    fileId: api.file_id,
    uri: api.uri,
    sourceSha256: api.source_sha256,
    name: api.name,
    surface: api.surface,
    lineStart: api.line_start,
    lineEnd: api.line_end
  };
}
