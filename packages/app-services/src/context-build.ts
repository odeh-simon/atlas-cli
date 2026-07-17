import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import { aiContextRecommendationSchema, contextManifestSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface BuildContextInput extends RuntimeOptions {
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly aiRecommendationArtifactId?: string | undefined;
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

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const aiRecommendation = loadAiRecommendation(runtime.paths.artifactRoot, artifacts, input.aiRecommendationArtifactId);
    const discovery = discoverContextSources({
      rootPath: runtime.paths.cwd,
      budget: {
        ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
      },
      recommendations: aiRecommendation?.recommendations
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
      metadata: {
        discovery: aiRecommendation === undefined ? "deterministic" : "hybrid",
        ...(aiRecommendation === undefined
          ? {}
          : {
              ai_recommendation_artifact_id: aiRecommendation.artifact_id,
              ai_provider_alias: aiRecommendation.provider_alias,
              ai_recommendation_count: aiRecommendation.recommendations.length
            })
      },
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

    const taskBrief = artifacts.find((artifact) => artifact.type === "task_brief");
    if (taskBrief !== undefined && getArtifactRecord(runtime.db, taskBrief.artifactId) !== undefined) {
      addArtifactDependency(runtime.db, {
        artifactId,
        dependsOnArtifactId: taskBrief.artifactId,
        dependencyKind: "input"
      });
    }
    if (aiRecommendation !== undefined) {
      addArtifactDependency(runtime.db, {
        artifactId,
        dependsOnArtifactId: aiRecommendation.artifact_id,
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

function loadAiRecommendation(
  artifactRoot: string,
  artifacts: ReturnType<typeof listArtifactsForSession>,
  artifactId: string | undefined
): ReturnType<typeof aiContextRecommendationSchema.parse> | undefined {
  const record =
    artifactId === undefined
      ? artifacts.filter((artifact) => artifact.type === "ai_context_recommendation" && artifact.status === "valid").at(-1)
      : artifacts.find((artifact) => artifact.artifactId === artifactId);
  if (record === undefined) return undefined;
  if (record.type !== "ai_context_recommendation" || record.status !== "valid") {
    throw new StateTransitionError("AI recommendation artifact is not valid");
  }
  const raw = JSON.parse(readFileSync(join(artifactRoot, record.storageUri), "utf8")) as unknown;
  return aiContextRecommendationSchema.parse(raw);
}

function nextContextVersion(db: Parameters<typeof listArtifactsForSession>[0], sessionId: string): number {
  return listArtifactsForSession(db, sessionId).filter((artifact) => artifact.type === "context_manifest").length + 1;
}
