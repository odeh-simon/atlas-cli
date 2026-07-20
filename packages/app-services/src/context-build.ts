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
import { aiContextRecommendationSchema, contextManifestSchema, contextQualityReportSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface BuildContextInput extends RuntimeOptions {
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly aiRecommendationArtifactId?: string | undefined;
}

export interface BuildContextResult {
  readonly sessionId: string;
  readonly contextArtifactId: string;
  readonly contextQualityReportArtifactId: string;
  readonly contextReadiness: "ready" | "weak" | "blocked";
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
    const git = readWorkflowGitSnapshot(runtime.paths.cwd);
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
        ...(git === undefined
          ? {}
          : {
              git,
              git_fingerprint: git.base_fingerprint
            }),
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

    const qualityArtifactId = newId("art");
    const qualityReport = contextQualityReportSchema.parse({
      artifact_id: qualityArtifactId,
      session_id: session.sessionId,
      type: "context_quality_report",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "context_quality_report").length + 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "internal",
      parents: [artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        discovery: manifest.metadata.discovery,
        context_manifest_artifact_id: artifactId,
        ...(git === undefined
          ? {}
          : {
              git,
              git_fingerprint: git.base_fingerprint
            })
      },
      context_manifest_artifact_id: artifactId,
      ...evaluateContextQuality({ discovery, aiRecommendation })
    });
    const qualityWritten = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId: qualityArtifactId,
      type: "context_quality_report",
      contentVersion: qualityReport.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(qualityReport, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId: qualityArtifactId,
      sessionId: session.sessionId,
      type: "context_quality_report",
      schemaVersion: 1,
      contentVersion: qualityReport.content_version,
      storageUri: qualityWritten.storageUri,
      sha256: qualityWritten.sha256,
      byteLength: qualityWritten.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: qualityReport.readiness === "blocked" ? "rejected" : "valid",
      producerType: "atlas",
      createdAt: now
    });
    addArtifactDependency(runtime.db, {
      artifactId: qualityArtifactId,
      dependsOnArtifactId: artifactId,
      dependencyKind: "input"
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
        contextQualityReportArtifactId: qualityArtifactId,
        contextReadiness: qualityReport.readiness,
        gitFingerprint: git?.base_fingerprint,
        sourceCount: discovery.sources.length,
        includedSourceCount: discovery.sources.filter((source) => source.included).length
      }
    });

    return {
      sessionId: session.sessionId,
      contextArtifactId: artifactId,
      contextQualityReportArtifactId: qualityArtifactId,
      contextReadiness: qualityReport.readiness,
      state: next,
      sourceCount: discovery.sources.length,
      includedSourceCount: discovery.sources.filter((source) => source.included).length,
      nextCommand: "atlas plan"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function evaluateContextQuality(input: {
  readonly discovery: ReturnType<typeof discoverContextSources>;
  readonly aiRecommendation: ReturnType<typeof aiContextRecommendationSchema.parse> | undefined;
}): {
  readonly readiness: "ready" | "weak" | "blocked";
  readonly issues: readonly { readonly code: string; readonly severity: "blocking" | "warning" | "info"; readonly summary: string }[];
  readonly recommended_next_actions: readonly string[];
} {
  const includedSources = input.discovery.sources.filter((source) => source.included);
  const issues: Array<{ code: string; severity: "blocking" | "warning" | "info"; summary: string }> = [];
  if (includedSources.length === 0) {
    issues.push({ code: "no-context-sources", severity: "blocking", summary: "No context sources were included." });
  }
  if (!includedSources.some((source) => source.kind === "test")) {
    issues.push({ code: "no-test-context", severity: "warning", summary: "No test sources were included in context." });
  }
  if (input.discovery.freshness === "partial") {
    issues.push({ code: "partial-context-budget", severity: "warning", summary: "Some candidate sources were excluded by context budgets." });
  }
  if (input.aiRecommendation !== undefined && input.aiRecommendation.recommendations.length === 0) {
    issues.push({ code: "ai-no-recommendations", severity: "warning", summary: "AI scout returned no file recommendations." });
  }
  const averageConfidence =
    input.aiRecommendation === undefined || input.aiRecommendation.recommendations.length === 0
      ? undefined
      : input.aiRecommendation.recommendations.reduce((sum, recommendation) => sum + recommendation.confidence, 0) /
        input.aiRecommendation.recommendations.length;
  if (averageConfidence !== undefined && averageConfidence < 0.5) {
    issues.push({ code: "low-ai-confidence", severity: "warning", summary: "AI scout confidence is low." });
  }

  const readiness = issues.some((issue) => issue.severity === "blocking")
    ? "blocked"
    : issues.some((issue) => issue.severity === "warning")
      ? "weak"
      : "ready";
  const recommended_next_actions =
    readiness === "ready"
      ? ["Proceed to atlas plan."]
      : issues.map((issue) => `Review ${issue.code}: ${issue.summary}`);
  return { readiness, issues, recommended_next_actions };
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
