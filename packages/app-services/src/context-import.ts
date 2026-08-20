import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError, StateTransitionError, ValidationError } from "@atlas/domain";
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
import { createContextContentPack } from "./context-pack.js";
import { readSafeRepositorySource } from "./evidence.js";
import { readWorkflowGitSnapshot } from "./git-safeguards.js";

export interface ImportContextInput extends RuntimeOptions {
  readonly filePath: string;
}

export interface ImportContextResult {
  readonly sessionId: string;
  readonly contextArtifactId: string;
  readonly contextContentPackArtifactId: string;
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

    const next = transition({
      state: session.primaryState,
      command: "import_context",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const raw = JSON.parse(readFileSync(input.filePath, "utf8")) as unknown;
    const manifest = contextManifestSchema.parse(enrichSourceHashes(normalizeManifest(raw, session.sessionId, artifactId, now), runtime.paths.cwd));
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "context_manifest",
      contentVersion: 1,
      mediaType: "application/json",
      content: `${JSON.stringify(manifest, null, 2)}\n`
    });

    const contextRecord = createArtifactRecord(runtime.db, {
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

    const existingArtifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const taskBrief = existingArtifacts.find((artifact) => artifact.type === "task_brief" && artifact.status === "valid");
    if (taskBrief !== undefined && getArtifactRecord(runtime.db, taskBrief.artifactId) !== undefined) {
      addArtifactDependency(runtime.db, {
        artifactId,
        dependsOnArtifactId: taskBrief.artifactId,
        dependencyKind: "input"
      });
    }
    if (taskBrief === undefined) throw new GateFailedError("Imported context requires a valid task brief");
    const contextPackRecord = createContextContentPack({
      runtime,
      sessionId: session.sessionId,
      taskBrief,
      contextManifest: contextRecord,
      manifest,
      git: readWorkflowGitSnapshot(runtime.paths.cwd),
      now,
      contentVersion: existingArtifacts.filter((artifact) => artifact.type === "context_content_pack").length + 1
    });
    if (manifest.gaps.some((gap) => gap.severity === "blocking")) {
      throw new GateFailedError("Imported context contains blocking gaps; resolve them and re-import");
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
      metadata: { contextArtifactId: artifactId, contextContentPackArtifactId: contextPackRecord.artifactId, sourcePath: input.filePath }
    });

    return {
      sessionId: session.sessionId,
      contextArtifactId: artifactId,
      contextContentPackArtifactId: contextPackRecord.artifactId,
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

function enrichSourceHashes(raw: unknown, cwd: string): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  const enrich = (sources: unknown): unknown =>
    Array.isArray(sources)
      ? sources.map((source) => {
          if (typeof source !== "object" || source === null || typeof (source as Record<string, unknown>).uri !== "string") return source;
          const value = source as Record<string, unknown>;
          if (value.included !== true) return source;
          const sourceContent = readSafeRepositorySource({ rootPath: cwd, uri: value.uri as string });
          return {
            ...value,
            sha256: value.sha256 ?? sourceContent.sha256,
            byte_length: sourceContent.bytes.byteLength
          };
        })
      : sources;
  return {
    ...record,
    ...(record.sources === undefined ? {} : { sources: enrich(record.sources) }),
    ...(record.included_sources === undefined ? {} : { included_sources: enrich(record.included_sources) })
  };
}

function normalizeManifest(raw: unknown, sessionId: string, artifactId: string, now: string): unknown {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as {
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
    // Envelope identity is always established by this trusted import boundary.
    // Imported envelope fields are untrusted and must never cross sessions.
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
