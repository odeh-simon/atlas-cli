import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getArtifactRecord, listArtifactsForSession, listSessionsForRepository } from "@sigil/persistence";
import { contextManifestSchema, type ContextSourceRecord } from "@sigil/schemas";

import { closeSigilRuntime, openSigilRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ContextManifestInspection {
  readonly artifactId: string;
  readonly schemaVersion: number;
  readonly semanticComplete: boolean;
  readonly discovery: string;
  readonly discoveryAlgorithm?: { readonly name: string; readonly version: string } | undefined;
  readonly freshness: "fresh" | "stale" | "partial";
  readonly scannedFileCount: number;
  readonly candidateFileCount: number;
  readonly omittedScanCount: number;
  readonly includedSources: readonly ContextSourceRecord[];
  readonly excludedCandidates: readonly ContextSourceRecord[];
  readonly taskTerms: readonly string[];
  readonly seeds: readonly { readonly uri: string; readonly score: number; readonly reasons: readonly string[] }[];
  readonly instructionChain: readonly {
    readonly uri: string;
    readonly scope_directory: string;
    readonly precedence: number;
    readonly applies_to: readonly string[];
    readonly truncated: boolean;
  }[];
  readonly symbolCount: number;
  readonly relationCounts: Readonly<Record<string, number>>;
  readonly evidenceFragmentCount: number;
  readonly gaps: readonly { readonly id: string; readonly severity: "blocking" | "warning" | "info"; readonly description: string }[];
  readonly pinsExclusions?: {
    readonly pinned_sources: readonly string[];
    readonly exclusions: readonly string[];
    readonly required_source_globs: readonly string[];
    readonly required_categories: readonly string[];
  } | undefined;
  readonly effectiveConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly effectiveConfigSha256?: string | undefined;
  readonly budgets: {
    readonly max_files: number;
    readonly max_bytes: number;
    readonly used_files: number;
    readonly used_bytes: number;
  };
}

export async function inspectContextManifest(
  input: RuntimeOptions & { readonly artifactId?: string | undefined } = {}
): Promise<ContextManifestInspection | undefined> {
  const runtime = await openSigilRuntime(input);
  try {
    const record =
      input.artifactId === undefined
        ? latestContextRecord(runtime.db, repoIdForPath(runtime.paths.cwd))
        : getArtifactRecord(runtime.db, input.artifactId);
    if (record === undefined || record.type !== "context_manifest") return undefined;

    const manifest = contextManifestSchema.parse(
      JSON.parse(readFileSync(join(runtime.paths.artifactRoot, record.storageUri), "utf8")) as unknown
    );
    const legacySources = manifest.sources ?? [];
    const includedSources = manifest.included_sources ?? legacySources.filter((source) => source.included);
    const excludedCandidates = manifest.excluded_candidates ?? legacySources.filter((source) => !source.included);
    const summary = manifest.discovery_summary;

    return {
      artifactId: record.artifactId,
      schemaVersion: manifest.schema_version,
      semanticComplete: manifest.schema_version >= 3 && manifest.semantic_complete === true,
      discovery: typeof manifest.metadata.discovery === "string" ? manifest.metadata.discovery : "unknown",
      ...(manifest.discovery_algorithm === undefined ? {} : { discoveryAlgorithm: manifest.discovery_algorithm }),
      freshness: manifest.freshness,
      scannedFileCount: summary?.scanned_file_count ?? legacySources.length,
      candidateFileCount: summary?.candidate_file_count ?? legacySources.length,
      omittedScanCount: summary?.omitted_scan_count ?? 0,
      includedSources,
      excludedCandidates,
      taskTerms: manifest.task_terms ?? [],
      seeds: manifest.seeds ?? [],
      instructionChain: manifest.instruction_chain ?? [],
      symbolCount: manifest.symbols?.length ?? 0,
      relationCounts: Object.fromEntries(
        [...new Set((manifest.relations ?? []).map((relation) => relation.kind))]
          .sort()
          .map((kind) => [kind, (manifest.relations ?? []).filter((relation) => relation.kind === kind).length])
      ),
      evidenceFragmentCount: manifest.evidence_fragments?.length ?? 0,
      gaps: manifest.gaps,
      ...(manifest.pins_exclusions === undefined ? {} : { pinsExclusions: manifest.pins_exclusions }),
      ...(manifest.effective_context_config === undefined ? {} : { effectiveConfig: manifest.effective_context_config }),
      ...(manifest.effective_context_config_sha256 === undefined ? {} : { effectiveConfigSha256: manifest.effective_context_config_sha256 }),
      budgets: manifest.budgets
    };
  } finally {
    closeSigilRuntime(runtime, false);
  }
}

function latestContextRecord(
  db: Parameters<typeof listArtifactsForSession>[0],
  repoId: string
): ReturnType<typeof listArtifactsForSession>[number] | undefined {
  const session = listSessionsForRepository(db, repoId)[0];
  if (session === undefined) return undefined;
  return listArtifactsForSession(db, session.sessionId)
    .filter((artifact) => artifact.type === "context_manifest" && artifact.status === "valid")
    .at(-1);
}
