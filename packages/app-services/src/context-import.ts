import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError, ValidationError } from "@atlas/domain";
import {
  addArtifactDependency,
  appendEvent,
  createArtifactRecord,
  getArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionContextArtifact
} from "@atlas/persistence";
import { contextManifestSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ImportContextInput extends RuntimeOptions {
  readonly filePath: string;
}

export interface ImportContextResult {
  readonly sessionId: string;
  readonly contextArtifactId: string;
  readonly state: string;
  readonly nextCommand: string;
}

export async function importContextManifest(input: ImportContextInput): Promise<ImportContextResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for context import");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const raw = JSON.parse(readFileSync(input.filePath, "utf8")) as unknown;
    const manifest = contextManifestSchema.parse(normalizeManifest(raw, session.sessionId, artifactId, now));
    const next = transition({
      state: session.primaryState,
      command: "import_context",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "context_manifest",
      contentVersion: 1,
      mediaType: "application/json",
      content: `${JSON.stringify(manifest, null, 2)}\n`
    });

    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "context_manifest",
      schemaVersion: 1,
      contentVersion: 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "import",
      createdAt: now
    });

    const taskBrief = listArtifactsForSession(runtime.db, session.sessionId).find((artifact) => artifact.type === "task_brief");
    if (taskBrief !== undefined && getArtifactRecord(runtime.db, taskBrief.artifactId) !== undefined) {
      addArtifactDependency(runtime.db, {
        artifactId,
        dependsOnArtifactId: taskBrief.artifactId,
        dependencyKind: "input"
      });
    }

    updateSessionContextArtifact(runtime.db, {
      sessionId: session.sessionId,
      artifactId,
      primaryState: next,
      now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "context.imported",
      actorType: "user",
      occurredAt: now,
      summary: "Context manifest imported",
      metadata: { contextArtifactId: artifactId, sourcePath: input.filePath }
    });

    return {
      sessionId: session.sessionId,
      contextArtifactId: artifactId,
      state: next,
      nextCommand: "atlas plan"
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError("Context manifest must be valid JSON", undefined, error);
    }
    throw error;
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function normalizeManifest(raw: unknown, sessionId: string, artifactId: string, now: string): unknown {
  if (typeof raw === "object" && raw !== null && "type" in raw) {
    return raw;
  }

  const value = raw as {
    sources?: unknown[];
    included_sources?: unknown[];
    excluded_candidates?: unknown[];
    discovery_summary?: unknown;
    gaps?: unknown[];
    budgets?: { max_files?: number; max_bytes?: number; used_files?: number; used_bytes?: number };
    freshness?: string;
  };
  const sources = Array.isArray(value.sources) ? value.sources : [];
  const includedSources = Array.isArray(value.included_sources) ? value.included_sources : undefined;
  const excludedCandidates = Array.isArray(value.excluded_candidates) ? value.excluded_candidates : undefined;
  const usedSources = includedSources ?? sources.filter((source) => isIncludedSource(source));
  return {
    artifact_id: artifactId,
    session_id: sessionId,
    type: "context_manifest",
    schema_version: 1,
    content_version: 1,
    created_at: now,
    producer: { type: "user" },
    sensitivity: "confidential",
    parents: [],
    content_sha256: "0".repeat(64),
    metadata: {},
    ...(includedSources === undefined && excludedCandidates === undefined ? { sources } : {}),
    ...(value.discovery_summary === undefined ? {} : { discovery_summary: value.discovery_summary }),
    ...(includedSources === undefined ? {} : { included_sources: includedSources }),
    ...(excludedCandidates === undefined ? {} : { excluded_candidates: excludedCandidates }),
    budgets: {
      max_files: value.budgets?.max_files ?? Math.max(1, usedSources.length),
      max_bytes: value.budgets?.max_bytes ?? 400000,
      used_files: value.budgets?.used_files ?? usedSources.length,
      used_bytes: value.budgets?.used_bytes ?? 0
    },
    gaps: Array.isArray(value.gaps) ? value.gaps : [],
    freshness: value.freshness ?? "fresh"
  };
}

function isIncludedSource(source: unknown): boolean {
  return typeof source === "object" && source !== null && "included" in source && source.included === true;
}
