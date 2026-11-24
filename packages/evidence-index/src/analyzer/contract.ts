import type { EvidenceApiEvidence, EvidenceConfigEvidence, EvidenceEdge, EvidenceSymbol, EvidenceTestAssociation, AnalyzerGap, AnalyzerStatus } from "@sigil/schemas";

export interface AnalyzerIdentity {
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly languages: readonly string[];
  readonly extensions: readonly string[];
  readonly capabilities: readonly string[];
  readonly unsupported: readonly string[];
}

export interface AnalyzerLimits {
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxGraphNodes?: number | undefined;
  readonly maxGraphEdges?: number | undefined;
  readonly maxDiagnostics?: number | undefined;
  readonly wallClockMs?: number | undefined;
}

export interface AnalyzerInput {
  readonly repositoryId: string;
  readonly rootPath: string;
  readonly snapshotId: string;
  readonly files: readonly AnalyzerFileInput[];
  readonly analyzerVersions: readonly { name: string; version: string }[];
  readonly configSha256?: string | undefined;
  readonly limits?: AnalyzerLimits | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AnalyzerFileInput {
  readonly uri: string;
  readonly absolutePath: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly fileId: string;
}

export interface AnalyzerOutput {
  readonly symbols: readonly EvidenceSymbol[];
  readonly edges: readonly EvidenceEdge[];
  readonly testAssociations: readonly EvidenceTestAssociation[];
  readonly apiEvidence: readonly EvidenceApiEvidence[];
  readonly configEvidence: readonly EvidenceConfigEvidence[];
  readonly gaps: readonly AnalyzerGap[];
  readonly diagnostics: readonly AnalyzerDiagnostic[];
  readonly status: AnalyzerStatus;
  readonly metrics: AnalyzerMetrics;
}

export interface AnalyzerDiagnostic {
  readonly code: string;
  readonly severity: "blocking" | "warning" | "info";
  readonly message: string;
  readonly uri?: string | undefined;
  readonly blocking: boolean;
}

export interface AnalyzerMetrics {
  readonly filesAnalyzed: number;
  readonly symbolsEmitted: number;
  readonly edgesEmitted: number;
  readonly gapsEmitted: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface EvidenceAnalyzer {
  readonly identity: AnalyzerIdentity;
  analyze(input: AnalyzerInput): AnalyzerOutput;
}
