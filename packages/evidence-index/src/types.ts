import type { EvidenceInvalidationReason } from "@sigil/schemas";

export interface EvidenceAnalyzerVersionRef {
  readonly name: string;
  readonly version: string;
}

export interface EvidenceIndexEngineLimits {
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxDepth?: number | undefined;
}

export interface EvidenceIndexEngineOptions {
  readonly rootPath: string;
  readonly dbPath: string;
  readonly displayName?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: EvidenceIndexEngineLimits | undefined;
  readonly analyzerVersions?: readonly EvidenceAnalyzerVersionRef[] | undefined;
  readonly configSha256?: string | undefined;
  readonly forceRebuild?: boolean | undefined;
  readonly onScanProgress?: ((filesProcessed: number) => void) | undefined;
}

export type UpdateOutcome = "reused" | "updated" | "rebuilt";

export type EvidenceInvalidationReasonCounts = Record<EvidenceInvalidationReason, number>;

export interface EvidenceIndexMetrics {
  readonly outcome: UpdateOutcome;
  readonly filesScanned: number;
  readonly filesHashed: number;
  readonly cacheHits: number;
  readonly added: number;
  readonly changed: number;
  readonly deleted: number;
  readonly renamed: number;
  readonly invalidationsByReason: EvidenceInvalidationReasonCounts;
  readonly rowsCarriedForward: number;
  readonly skippedSymlinks: number;
  readonly skippedUnsafeUris: number;
  readonly payloadBytes: number;
  readonly durationMs: number;
}

export interface EvidenceIndexUpdateResult {
  readonly repositoryId: string;
  readonly snapshotId: string | undefined;
  readonly metrics: EvidenceIndexMetrics;
}
