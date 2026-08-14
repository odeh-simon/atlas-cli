import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getArtifactRecord, listArtifactsForSession, listSessionsForRepository } from "@atlas/persistence";
import { contextManifestSchema, type ContextSourceRecord } from "@atlas/schemas";

import { closeAtlasRuntime, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ContextManifestInspection {
  readonly artifactId: string;
  readonly discovery: string;
  readonly freshness: "fresh" | "stale" | "partial";
  readonly scannedFileCount: number;
  readonly candidateFileCount: number;
  readonly omittedScanCount: number;
  readonly includedSources: readonly ContextSourceRecord[];
  readonly excludedCandidates: readonly ContextSourceRecord[];
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
  const runtime = await openAtlasRuntime(input);
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
      discovery: typeof manifest.metadata.discovery === "string" ? manifest.metadata.discovery : "unknown",
      freshness: manifest.freshness,
      scannedFileCount: summary?.scanned_file_count ?? legacySources.length,
      candidateFileCount: summary?.candidate_file_count ?? legacySources.length,
      omittedScanCount: summary?.omitted_scan_count ?? 0,
      includedSources,
      excludedCandidates,
      budgets: manifest.budgets
    };
  } finally {
    closeAtlasRuntime(runtime, false);
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
