import type { EvidenceInvalidationReason } from "@atlas/schemas";

import type { EvidenceIndexMetrics, EvidenceInvalidationReasonCounts, UpdateOutcome } from "./types.js";

export function emptyInvalidationCounts(): Record<EvidenceInvalidationReason, number> {
  return {
    "file-changed": 0,
    "file-deleted": 0,
    "git-reset": 0,
    "config-changed": 0,
    "manual-rebuild": 0
  };
}

export interface MetricsAccumulator {
  readonly invalidationsByReason: Record<EvidenceInvalidationReason, number>;
  filesScanned: number;
  filesHashed: number;
  cacheHits: number;
  added: number;
  changed: number;
  deleted: number;
  renamed: number;
  rowsCarriedForward: number;
  skippedSymlinks: number;
  skippedUnsafeUris: number;
}

export function createMetricsAccumulator(): MetricsAccumulator {
  return {
    invalidationsByReason: emptyInvalidationCounts(),
    filesScanned: 0,
    filesHashed: 0,
    cacheHits: 0,
    added: 0,
    changed: 0,
    deleted: 0,
    renamed: 0,
    rowsCarriedForward: 0,
    skippedSymlinks: 0,
    skippedUnsafeUris: 0
  };
}

export function finalizeMetrics(
  accumulator: MetricsAccumulator,
  outcome: UpdateOutcome,
  payloadBytes: number,
  durationMs: number
): EvidenceIndexMetrics {
  const metrics: EvidenceIndexMetrics = {
    outcome,
    filesScanned: accumulator.filesScanned,
    filesHashed: accumulator.filesHashed,
    cacheHits: accumulator.cacheHits,
    added: accumulator.added,
    changed: accumulator.changed,
    deleted: accumulator.deleted,
    renamed: accumulator.renamed,
    invalidationsByReason: { ...accumulator.invalidationsByReason } as EvidenceInvalidationReasonCounts,
    rowsCarriedForward: accumulator.rowsCarriedForward,
    skippedSymlinks: accumulator.skippedSymlinks,
    skippedUnsafeUris: accumulator.skippedUnsafeUris,
    payloadBytes,
    durationMs
  };
  return metrics;
}

export type { EvidenceInvalidationReasonCounts };
