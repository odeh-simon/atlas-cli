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
import {
  EVIDENCE_INDEX_SCHEMA_VERSION,
  TYPESCRIPT_ANALYZER_NAME,
  TYPESCRIPT_ANALYZER_VERSION,
  analyzerGapSchema,
  evidenceApiEvidenceSchema,
  evidenceConfigEvidenceSchema,
  evidenceEdgeSchema,
  evidenceSymbolSchema,
  evidenceTestAssociationSchema,
  type AnalyzerCapability,
  type AnalyzerGap,
  type EvidenceApiEvidence,
  type EvidenceConfigEvidence,
  type EvidenceEdge,
  type EvidenceIndexPayload,
  type EvidenceInvalidationReason,
  type EvidenceSymbol,
  type EvidenceTestAssociation
} from "@atlas/schemas";

import { tryReadEvidenceGitFacts, type EvidenceGitFacts } from "./git-evidence.js";
import { buildIncrementalPayload } from "./invalidation.js";
import { createMetricsAccumulator, finalizeMetrics } from "./metrics.js";
import { hashAndClassifyFile, throwIfAborted, walkRepositoryCandidates, type HashedFileEvidence } from "./scan.js";
import type { EvidenceIndexEngineOptions, EvidenceIndexUpdateResult, UpdateOutcome } from "./types.js";
import {
  ensureDefaultAnalyzersRegistered,
  resolveRequestedAnalyzersExact
} from "./analyzer/registry.js";
import type { AnalyzerLimits } from "./analyzer/contract.js";

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

    // --- Analyzer v2 integration (fail-closed, deterministic, truthful provenance) ---
    ensureDefaultAnalyzersRegistered();
    // Default to typescript analyzer if none explicitly requested.
    const requestedAnalyzerVersions =
      analyzerVersions.length > 0
        ? [...analyzerVersions].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
        : [{ name: TYPESCRIPT_ANALYZER_NAME, version: TYPESCRIPT_ANALYZER_VERSION }];
    // Exact match required: identity and implementation version come from the
    // registered implementation. An arbitrary requested version fails closed.
    const selectedAnalyzers = resolveRequestedAnalyzersExact(requestedAnalyzerVersions);
    const effectiveAnalyzerVersions = selectedAnalyzers.map((analyzer) => ({
      name: analyzer.identity.name,
      version: analyzer.identity.version,
      fingerprint: analyzer.identity.fingerprint
    }));

    // Filter safe files for analyzer (never analyze secret/binary/excluded)
    const safeFilesForAnalyzer = hashedFiles.filter((f) => !f.binary && !f.secret && !f.excluded);
    const allAnalyzerFileInputs = safeFilesForAnalyzer
      .filter((f) => {
        const ext = f.uri.split(".").pop()?.toLowerCase() ?? "";
        return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(`.${ext}`);
      })
      .map((f) => ({
        uri: f.uri,
        absolutePath: resolve(resolvedRoot, ...f.uri.split("/")),
        contentSha256: f.contentSha256,
        byteLength: f.byteLength,
        fileId: deriveId("evfile", [identity.repositoryId, f.uri])
      }));

    // Incremental analyzer with deterministic reverse-dependent closure.
    // Changing a target invalidates edges from unchanged dependents; those
    // dependents must be reanalyzed or valid import/caller edges are lost.
    const previousAnalyzerVersions = previous?.snapshot.analyzer_capabilities.map((c) => ({ name: c.analyzer_name, version: c.analyzer_version })) ?? [];
    const analyzerVersionChanged =
      effectiveAnalyzerVersions.length !== previousAnalyzerVersions.length ||
      effectiveAnalyzerVersions.some((v) => !previousAnalyzerVersions.some((p) => p.name === v.name && p.version === v.version));
    const previousFileShaMap = new Map((previous?.payload.files ?? []).map((f) => [f.uri, f.content_sha256]));
    const directChangedUris = new Set<string>();
    if (analyzerVersionChanged || gitReset || previous === undefined || configChanged || forceManualRebuild) {
      for (const f of allAnalyzerFileInputs) directChangedUris.add(f.uri);
    } else {
      for (const f of allAnalyzerFileInputs) {
        const prevSha = previousFileShaMap.get(f.uri);
        if (prevSha !== f.contentSha256) directChangedUris.add(f.uri);
      }
    }
    const previousUris = new Set((previous?.payload.files ?? []).map((f) => f.uri));
    const currentUris = new Set(allAnalyzerFileInputs.map((f) => f.uri));
    const deletedOrRenamedSources = new Set<string>();
    for (const uri of previousUris) {
      if (!currentUris.has(uri) || !hashedFiles.some((h) => h.uri === uri)) {
        deletedOrRenamedSources.add(uri);
      }
    }
    for (const pair of renamePairs) {
      deletedOrRenamedSources.add(pair.from);
    }
    // Analyzer/config changes already force full reanalysis above. Otherwise
    // expand the affected set through the previous semantic graph.
    const affectedUris = computeAffectedUriClosure(previous?.payload, directChangedUris, deletedOrRenamedSources);
    const analyzerFileInputs = allAnalyzerFileInputs.filter((f) => affectedUris.has(f.uri));

    // Run selected analyzers deterministically. Any crash, cancellation,
    // malformed output, version mismatch, or blocking gap fails closed:
    // the error propagates, no candidate snapshot is promoted, and the
    // previous current snapshot remains authoritative.
    const analyzerGaps: AnalyzerGap[] = [];
    const analyzerSymbols: EvidenceSymbol[] = [];
    const analyzerEdges: EvidenceEdge[] = [];
    const analyzerTestAssociations: EvidenceTestAssociation[] = [];
    const analyzerApiEvidence: EvidenceApiEvidence[] = [];
    const analyzerConfigEvidence: EvidenceConfigEvidence[] = [];
    const buildTimestamp = now().toISOString();

    for (const analyzer of selectedAnalyzers) {
      throwIfAborted(options.signal);
      const filesForAnalyzer = analyzerFileInputs.filter((f) =>
        analyzer.identity.extensions.some((ext) => f.uri.toLowerCase().endsWith(ext))
      );
      // Even when no files match, capabilities below still report declared
      // supported/unsupported semantics. Skip execution but do not invent gaps.
      if (analyzerFileInputs.length > 0 && filesForAnalyzer.length === 0) continue;
      if (filesForAnalyzer.length === 0 && analyzerFileInputs.length === 0) continue;
      const output = analyzer.analyze({
        repositoryId: identity.repositoryId,
        rootPath: resolvedRoot,
        snapshotId: previous?.snapshot.snapshot_id ?? deriveId("evsnap", [identity.repositoryId, "initial"]),
        files: filesForAnalyzer,
        analyzerVersions: selectedAnalyzers.map((selected) => ({
          name: selected.identity.name,
          version: selected.identity.version
        })),
        configSha256,
        limits: toAnalyzerLimits(options.limits),
        signal: options.signal
      });
      // Runtime output validation before persistence.
      const validated = validateAnalyzerOutputOrThrow(
        identity.repositoryId,
        analyzer.identity.name,
        analyzer.identity.version,
        output
      );
      if (validated.status === "cancelled") {
        throw new CancellationError(`Analyzer ${analyzer.identity.name} cancelled`);
      }
      const blockingGaps = validated.gaps.filter((gap) => gap.blocking || gap.severity === "blocking");
      if (validated.status === "failed" || blockingGaps.length > 0) {
        throw new PersistenceError(
          `Analyzer ${analyzer.identity.name} failed with blocking gaps: ${blockingGaps.map((gap) => gap.code).sort().join(",") || validated.status}`
        );
      }
      analyzerSymbols.push(...validated.symbols);
      analyzerEdges.push(...validated.edges);
      analyzerTestAssociations.push(...validated.testAssociations);
      analyzerApiEvidence.push(...validated.apiEvidence);
      analyzerConfigEvidence.push(...validated.configEvidence);
      analyzerGaps.push(...validated.gaps);
      if (validated.metrics.truncated) {
        analyzerGaps.push({
          gap_id: deriveId("evgap", [identity.repositoryId, "analyzer-truncated", analyzer.identity.name, analyzer.identity.version]),
          analyzer_name: analyzer.identity.name,
          analyzer_version: analyzer.identity.version,
          code: "graph-resource-limit",
          severity: "warning",
          message: `Analyzer ${analyzer.identity.name} truncated output`,
          blocking: false,
          capability: "truncated",
          created_at: buildTimestamp
        });
      }
    }
    // No broad catch here: unexpected analyzer failures must not be
    // downgraded to nonblocking warnings. They propagate to the outer
    // fail-closed handler which marks the build failed without promoting.

    // Deterministic ordering already ensured by analyzer; merge with diff's carried-forward rows
    // For unchanged files, diff already carries forward previous symbols/edges; we need to merge analyzer's fresh symbols for changed files
    const baseSymbols = analyzerVersionChanged ? [] : diff.symbols;
    const baseEdges = analyzerVersionChanged ? [] : diff.edges;
    const baseTestAssociations = analyzerVersionChanged ? [] : diff.testAssociations;
    const baseApiEvidence = analyzerVersionChanged ? [] : diff.apiEvidence;
    const baseConfigEvidence = analyzerVersionChanged ? [] : diff.configEvidence;
    const mergedSymbols = dedupeById([...baseSymbols, ...analyzerSymbols], (s) => s.symbol_id);
    const mergedEdges = dedupeById([...baseEdges, ...analyzerEdges], (e) => e.edge_id);
    const mergedTestAssociations = dedupeById([...baseTestAssociations, ...analyzerTestAssociations], (a) => a.association_id);
    const mergedApiEvidence = dedupeById([...baseApiEvidence, ...analyzerApiEvidence], (a) => a.api_evidence_id);
    const mergedConfigEvidence = dedupeById([...baseConfigEvidence, ...analyzerConfigEvidence], (c) => c.config_evidence_id);

    // Filter merged to only those whose file still exists (not deleted) and is safe
    const liveUris = new Set(hashedFiles.map((f) => f.uri));
    const filteredSymbols = mergedSymbols.filter((s) => liveUris.has(s.uri));
    const filteredEdges = mergedEdges.filter((e) => liveUris.has(e.from_uri) && liveUris.has(e.to_uri));
    const filteredTestAssociations = mergedTestAssociations.filter((a) => liveUris.has(a.test_uri) && liveUris.has(a.source_uri));

    const analyzerCapabilities: AnalyzerCapability[] = selectedAnalyzers.map((analyzer) => {
      const gapsForAnalyzer = [...new Set(
        analyzerGaps.filter((gap) => gap.analyzer_name === analyzer.identity.name).map((gap) => gap.code)
      )].sort();
      const unsupportedForAnalyzer = [...analyzer.identity.unsupported].sort();
      return {
        capability_id: deriveId("evcap", [identity.repositoryId, analyzer.identity.name, analyzer.identity.version]),
        analyzer_name: analyzer.identity.name,
        analyzer_version: analyzer.identity.version,
        capabilities: [...analyzer.identity.capabilities].sort(),
        gaps: gapsForAnalyzer,
        languages: [...analyzer.identity.languages].sort(),
        unsupported: unsupportedForAnalyzer
      };
    });

    const relevantInputsSha256 = stableHash({
      engineVersion: ENGINE_VERSION,
      schemaVersion: EVIDENCE_INDEX_SCHEMA_VERSION,
      configSha256,
      analyzers: effectiveAnalyzerVersions,
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
      symbols: filteredSymbols.map((row) => toSymbolRow(identity.repositoryId, row)),
      edges: filteredEdges.map((row) => toEdgeRow(identity.repositoryId, row)),
      testAssociations: filteredTestAssociations.map((row) => toAssociationRow(identity.repositoryId, row)),
      configEvidence: mergedConfigEvidence.map((row) => toConfigRow(identity.repositoryId, row)),
      apiEvidence: mergedApiEvidence.map((row) => toApiRow(identity.repositoryId, row)),
      gaps: analyzerGaps.map((gap) => ({
        gapId: gap.gap_id,
        repositoryId: identity.repositoryId,
        snapshotId: undefined,
        analyzerName: gap.analyzer_name,
        analyzerVersion: gap.analyzer_version,
        code: gap.code,
        severity: gap.severity,
        scopeUri: gap.scope_uri,
        message: gap.message,
        blocking: gap.blocking,
        capability: gap.capability,
        createdAt: gap.created_at ?? buildTimestamp
      })),
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

function toSymbolRow(repositoryId: string, symbol: EvidenceSymbol): EvidenceSymbolRow {
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
    lineEnd: symbol.line_end,
    colStart: symbol.col_start,
    colEnd: symbol.col_end,
    proof: symbol.proof,
    analyzerName: symbol.analyzer_name,
    analyzerVersion: symbol.analyzer_version
  };
}

function toEdgeRow(repositoryId: string, edge: EvidenceEdge): EvidenceEdgeRow {
  return {
    edgeId: edge.edge_id,
    repositoryId,
    kind: edge.kind,
    fromFileId: edge.from_file_id,
    toFileId: edge.to_file_id,
    fromUri: edge.from_uri,
    toUri: edge.to_uri,
    rule: edge.rule,
    resolution: edge.resolution,
    proof: edge.proof,
    analyzerName: edge.analyzer_name,
    analyzerVersion: edge.analyzer_version,
    fromSourceSha256: edge.from_source_sha256,
    toSourceSha256: edge.to_source_sha256,
    fromLineStart: edge.from_line_start,
    fromLineEnd: edge.from_line_end,
    fromColStart: edge.from_col_start,
    fromColEnd: edge.from_col_end,
    toLineStart: edge.to_line_start,
    toLineEnd: edge.to_line_end,
    toColStart: edge.to_col_start,
    toColEnd: edge.to_col_end
  };
}

function toAssociationRow(repositoryId: string, association: EvidenceTestAssociation): EvidenceTestAssociationRow {
  return {
    associationId: association.association_id,
    repositoryId,
    testFileId: association.test_file_id,
    sourceFileId: association.source_file_id,
    testUri: association.test_uri,
    sourceUri: association.source_uri,
    rule: association.rule,
    proof: association.proof,
    analyzerName: association.analyzer_name,
    analyzerVersion: association.analyzer_version,
    sourceSha256: association.source_sha256,
    testSha256: association.test_sha256,
    lineStart: association.line_start,
    lineEnd: association.line_end,
    colStart: association.col_start,
    colEnd: association.col_end
  };
}

function toConfigRow(repositoryId: string, config: EvidenceConfigEvidence): EvidenceConfigEvidenceRow {
  return {
    configEvidenceId: config.config_evidence_id,
    repositoryId,
    uri: config.uri,
    sourceSha256: config.source_sha256,
    byteLength: config.byte_length,
    format: config.format,
    secretRedacted: config.secret_redacted,
    analyzerName: config.analyzer_name,
    analyzerVersion: config.analyzer_version,
    proof: config.proof
  };
}

function toApiRow(repositoryId: string, api: EvidenceApiEvidence): EvidenceApiEvidenceRow {
  return {
    apiEvidenceId: api.api_evidence_id,
    repositoryId,
    fileId: api.file_id,
    uri: api.uri,
    sourceSha256: api.source_sha256,
    name: api.name,
    surface: api.surface,
    lineStart: api.line_start,
    lineEnd: api.line_end,
    colStart: api.col_start,
    colEnd: api.col_end,
    proof: api.proof,
    analyzerName: api.analyzer_name,
    analyzerVersion: api.analyzer_version
  };
}

function dedupeById<T>(items: readonly T[], idFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = idFn(item);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(item);
    }
  }
  return out.sort((a, b) => idFn(a).localeCompare(idFn(b)));
}

export function computeAffectedUriClosure(
  previous: EvidenceIndexPayload | undefined,
  directChanged: ReadonlySet<string>,
  deletedOrRenamed: ReadonlySet<string>
): Set<string> {
  const affected = new Set<string>([...directChanged, ...deletedOrRenamed]);
  if (previous === undefined || affected.size === 0) {
    // When there is no baseline, callers already force full reanalysis.
    // When nothing changed, the closure is empty.
    return affected;
  }
  // Build reverse index: target URI -> set of source URIs that reference it
  // through imports, re-exports, caller/callee edges, or test associations.
  const reverseDependents = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    if (from === to) return;
    let set = reverseDependents.get(to);
    if (set === undefined) {
      set = new Set<string>();
      reverseDependents.set(to, set);
    }
    set.add(from);
  };
  for (const edge of previous.edges ?? []) {
    link(edge.from_uri, edge.to_uri);
  }
  for (const association of previous.test_associations ?? []) {
    link(association.test_uri, association.source_uri);
    link(association.source_uri, association.test_uri);
  }
  // Bounded stable fixpoint: propagate through import/re-export chains,
  // cycles, caller/callee evidence, and test associations.
  const queue: string[] = [...affected].sort();
  const visited = new Set<string>(queue);
  while (queue.length > 0) {
    // Deterministic order: always expand smallest URI first.
    queue.sort();
    const current = queue.shift() as string;
    const dependents = reverseDependents.get(current);
    if (dependents === undefined) continue;
    for (const dependent of [...dependents].sort()) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return affected;
}

function toAnalyzerLimits(
  limits: EvidenceIndexEngineOptions["limits"]
): AnalyzerLimits | undefined {
  if (limits === undefined) return undefined;
  const out: { maxFiles?: number; maxBytes?: number; maxGraphNodes?: number; maxGraphEdges?: number; maxDiagnostics?: number; wallClockMs?: number } = {};
  if (limits.maxFiles !== undefined) out.maxFiles = limits.maxFiles;
  if (limits.maxBytes !== undefined) out.maxBytes = limits.maxBytes;
  return out;
}

interface ValidatedAnalyzerOutput {
  readonly symbols: EvidenceSymbol[];
  readonly edges: EvidenceEdge[];
  readonly testAssociations: EvidenceTestAssociation[];
  readonly apiEvidence: EvidenceApiEvidence[];
  readonly configEvidence: EvidenceConfigEvidence[];
  readonly gaps: AnalyzerGap[];
  readonly status: string;
  readonly metrics: { truncated: boolean };
}

function validateAnalyzerOutputOrThrow(
  repositoryId: string,
  analyzerName: string,
  analyzerVersion: string,
  output: unknown
): ValidatedAnalyzerOutput {
  if (typeof output !== "object" || output === null) {
    throw new PersistenceError(`Analyzer ${analyzerName} returned malformed output`);
  }
  const record = output as Record<string, unknown>;
  const parseArray = <T>(
    value: unknown,
    schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: { issues: unknown } } },
    kind: string
  ): T[] => {
    if (!Array.isArray(value)) {
      throw new PersistenceError(`Analyzer ${analyzerName} returned malformed ${kind}`);
    }
    return value.map((entry) => {
      const parsed = schema.safeParse(entry);
      if (!parsed.success || parsed.data === undefined) {
        throw new PersistenceError(`Analyzer ${analyzerName} returned malformed ${kind}`);
      }
      return parsed.data;
    });
  };
  const symbols = parseArray<EvidenceSymbol>(record["symbols"], evidenceSymbolSchema, "symbols");
  const edges = parseArray<EvidenceEdge>(record["edges"], evidenceEdgeSchema, "edges");
  const testAssociations = parseArray<EvidenceTestAssociation>(
    record["testAssociations"],
    evidenceTestAssociationSchema,
    "testAssociations"
  );
  const apiEvidence = parseArray<EvidenceApiEvidence>(record["apiEvidence"], evidenceApiEvidenceSchema, "apiEvidence");
  const configEvidence = parseArray<EvidenceConfigEvidence>(
    record["configEvidence"],
    evidenceConfigEvidenceSchema,
    "configEvidence"
  );
  const gaps = parseArray<AnalyzerGap>(record["gaps"], analyzerGapSchema, "gaps");
  const status = typeof record["status"] === "string" ? (record["status"] as string) : "";
  if (status !== "completed" && status !== "partial" && status !== "unsupported" && status !== "cancelled" && status !== "failed") {
    throw new PersistenceError(`Analyzer ${analyzerName} returned malformed status`);
  }
  const metricsRecord =
    typeof record["metrics"] === "object" && record["metrics"] !== null
      ? (record["metrics"] as Record<string, unknown>)
      : {};
  const truncated = metricsRecord["truncated"] === true;
  // Truthful provenance: every record must claim the implementation that
  // actually produced it. Caller-supplied version text cannot relabel output.
  for (const entry of [...symbols, ...edges, ...testAssociations, ...apiEvidence, ...configEvidence, ...gaps]) {
    const claimedName = (entry as { analyzer_name?: unknown }).analyzer_name;
    const claimedVersion = (entry as { analyzer_version?: unknown }).analyzer_version;
    if (claimedName !== analyzerName || claimedVersion !== analyzerVersion) {
      throw new PersistenceError(
        `Analyzer ${analyzerName} identity mismatch: output claims ${String(claimedName)}@${String(claimedVersion)}`
      );
    }
    const entryRepository = (entry as { repository_id?: unknown }).repository_id;
    if (entryRepository !== undefined && entryRepository !== repositoryId) {
      throw new PersistenceError(`Analyzer ${analyzerName} returned cross-repository evidence`);
    }
  }
  return { symbols, edges, testAssociations, apiEvidence, configEvidence, gaps, status, metrics: { truncated } };
}
