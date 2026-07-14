import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError } from "@atlas/domain";
import { discoverContextSources } from "@atlas/context-discovery";
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

export interface BuildContextInput extends RuntimeOptions {
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export interface BuildContextResult {
  readonly sessionId: string;
  readonly contextArtifactId: string;
  readonly state: string;
  readonly sourceCount: number;
  readonly includedSourceCount: number;
  readonly nextCommand: string;
}

export async function buildContextManifest(input: BuildContextInput = {}): Promise<BuildContextResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for context build");
    }

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const discovery = discoverContextSources({
      rootPath: runtime.paths.cwd,
      budget: {
        ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
      }
    });
    const manifest = contextManifestSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "context_manifest",
      schema_version: 1,
      content_version: nextContextVersion(runtime.db, session.sessionId),
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [],
      content_sha256: "0".repeat(64),
      metadata: { discovery: "deterministic-file-scan" },
      sources: discovery.sources,
      budgets: discovery.budgets,
      gaps: [],
      freshness: discovery.freshness
    });
    const next = transition({
      state: session.primaryState,
      command: "import_context",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const contentVersion = nextContextVersion(runtime.db, session.sessionId);
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "context_manifest",
      contentVersion,
      mediaType: "application/json",
      content: `${JSON.stringify(manifest, null, 2)}\n`
    });

    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "context_manifest",
      schemaVersion: 1,
      contentVersion,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "atlas",
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

    updateSessionContextArtifact(runtime.db, { sessionId: session.sessionId, artifactId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "context.built",
      actorType: "atlas",
      occurredAt: now,
      summary: "Context manifest built from repository sources",
      metadata: {
        contextArtifactId: artifactId,
        sourceCount: discovery.sources.length,
        includedSourceCount: discovery.sources.filter((source) => source.included).length
      }
    });

    return {
      sessionId: session.sessionId,
      contextArtifactId: artifactId,
      state: next,
      sourceCount: discovery.sources.length,
      includedSourceCount: discovery.sources.filter((source) => source.included).length,
      nextCommand: "atlas plan"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function nextContextVersion(db: Parameters<typeof listArtifactsForSession>[0], sessionId: string): number {
  return listArtifactsForSession(db, sessionId).filter((artifact) => artifact.type === "context_manifest").length + 1;
}
