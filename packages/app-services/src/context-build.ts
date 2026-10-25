import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError, StateTransitionError } from "@atlas/domain";
import { ContextConfigurationError, discoverContextSources, readContextDiscoveryConfig } from "@atlas/context-discovery";
import {
  addArtifactDependency,
  appendEvent,
  createArtifactRecord,
  getArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionContextArtifact
} from "@atlas/persistence";
import { aiContextRecommendationSchema, contextManifestSchema, contextQualityReportSchema, taskBriefSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { readWorkflowGitSnapshot } from "./git-safeguards.js";
import { createContextContentPack } from "./context-pack.js";
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
  readonly contextContentPackArtifactId: string;
  readonly contextReadiness: "ready" | "weak" | "blocked";
  readonly state: string;
  readonly sourceCount: number;
  readonly includedSourceCount: number;
  readonly scannedFileCount: number;
  readonly candidateSourceCount: number;
  readonly excludedCandidateCount: number;
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
    const taskBrief = artifacts.find((artifact) => artifact.type === "task_brief");
    const taskBriefContent = taskBrief === undefined ? undefined : readFileSync(join(runtime.paths.artifactRoot, taskBrief.storageUri), "utf8");
    const parsedTaskBrief = taskBriefContent === undefined ? undefined : taskBriefSchema.parse(JSON.parse(taskBriefContent) as unknown);
    const taskText = parsedTaskBrief === undefined
      ? undefined
      : [parsedTaskBrief.title, parsedTaskBrief.objective, ...parsedTaskBrief.acceptance_criteria].join("\n");
    let configured;
    try {
      configured = readContextDiscoveryConfig(runtime.paths.cwd);
    } catch (error) {
      if (error instanceof ContextConfigurationError) {
        throw new GateFailedError("Context configuration is invalid; fix atlas.config.json before discovery", { error: error.message }, error);
      }
      throw error;
    }
    const discovery = discoverContextSources({
      rootPath: runtime.paths.cwd,
      config: configured.config,
      budget: {
        ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
      },
      recommendations: aiRecommendation?.recommendations,
      taskText,
      snapshot: {
        rootPathHash: git?.root_path_hash,
        gitBaseFingerprint: git?.base_fingerprint,
        gitHeadSha: git?.head_sha,
        taskBriefSha256: taskBrief?.sha256
      }
    });
    const gaps = [
      ...discovery.gaps.map((gap) => ({ id: gap.id, severity: gap.severity, description: gap.description })),
      ...gapsFromAiRecommendation(aiRecommendation)
    ];
    const relevantInputsSha256 = createHash("sha256").update(JSON.stringify({
      taskBriefSha256: taskBrief?.sha256,
      discoveryConfigSha256: configured.sha256,
      effectiveContextConfigSha256: discovery.configSha256,
      gitBaseFingerprint: git?.base_fingerprint,
      sources: discovery.includedSources.map((source) => [source.uri, source.sha256]),
      instructions: discovery.instructionChain.map((instruction) => [instruction.uri, instruction.sha256])
    })).digest("hex");
    const manifest = contextManifestSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "context_manifest",
      schema_version: 3,
      content_version: nextContextVersion(runtime.db, session.sessionId),
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [
        ...(taskBrief === undefined ? [] : [taskBrief.artifactId]),
        ...(aiRecommendation === undefined ? [] : [aiRecommendation.artifact_id])
      ],
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
      discovery_summary: {
        scanned_file_count: discovery.scannedFileCount,
        candidate_file_count: discovery.sources.length,
        included_source_count: discovery.includedSources.length,
        excluded_candidate_count: discovery.excludedCandidates.length,
        omitted_scan_count: discovery.omittedScanCount
      },
      included_sources: discovery.includedSources,
      excluded_candidates: discovery.excludedCandidates,
      budgets: discovery.budgets,
      gaps,
      freshness: discovery.freshness,
      semantic_complete: true,
      repository_snapshot: {
        ...(git === undefined ? {} : {
          root_path_hash: git.root_path_hash,
          git_base_fingerprint: git.base_fingerprint,
          ...(git.head_sha === undefined ? {} : { git_head_sha: git.head_sha })
        }),
        task_brief_sha256: taskBrief?.sha256 ?? "0".repeat(64),
        discovery_config_sha256: configured.sha256
      },
      discovery_algorithm: discovery.algorithm,
      effective_context_config: discovery.effectiveConfig,
      effective_context_config_sha256: discovery.configSha256,
      task_terms: discovery.taskTerms,
      seeds: discovery.seeds,
      instruction_chain: discovery.instructionChain,
      symbols: discovery.symbols,
      relations: discovery.relations,
      evidence_fragments: discovery.evidenceFragments,
      pins_exclusions: {
        pinned_sources: discovery.effectiveConfig.pinnedSources,
        exclusions: discovery.effectiveConfig.exclusions,
        required_source_globs: discovery.effectiveConfig.requiredSourceGlobs,
        required_categories: discovery.effectiveConfig.requiredCategories
      },
      semantic_budgets: {
        max_graph_nodes: discovery.budgets.max_graph_nodes,
        used_graph_nodes: discovery.budgets.used_graph_nodes,
        max_graph_edges: discovery.budgets.max_graph_edges,
        used_graph_edges: discovery.budgets.used_graph_edges,
        max_evidence_fragments: discovery.budgets.max_evidence_fragments,
        used_evidence_fragments: discovery.budgets.used_evidence_fragments,
        instruction_max_bytes: discovery.budgets.instruction_max_bytes,
        instruction_used_bytes: discovery.budgets.instruction_used_bytes
      },
      invalidation: {
        source_hashes: Object.fromEntries(discovery.includedSources.map((source) => [source.uri, source.sha256])),
        instruction_hashes: Object.fromEntries(discovery.instructionChain.map((instruction) => [instruction.uri, instruction.sha256])),
        relevant_inputs_sha256: relevantInputsSha256
      }
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

    const contextRecord = createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "context_manifest",
      schemaVersion: 3,
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

    if (taskBrief === undefined || taskBrief.status !== "valid") {
      throw new GateFailedError("Context content pack requires a valid task brief; restart or repair the session");
    }
    const contextPackRecord = createContextContentPack({
      runtime,
      sessionId: session.sessionId,
      taskBrief,
      contextManifest: contextRecord,
      manifest,
      git,
      now,
      contentVersion: artifacts.filter((artifact) => artifact.type === "context_content_pack").length + 1
    });

    if (qualityReport.readiness === "blocked") {
      appendEvent(runtime.db, {
        eventId: newId("evt"),
        sessionId: session.sessionId,
        eventType: "context.blocked",
        actorType: "atlas",
        occurredAt: now,
        summary: "Context evidence is incomplete; session remains at intake",
        metadata: { contextArtifactId: artifactId, contextContentPackArtifactId: contextPackRecord.artifactId, gaps }
      });
      throw new GateFailedError("Context readiness gate failed; resolve missing context/questions and rebuild", {
        gaps: gaps.map((gap) => gap.description),
        repair: "Rerun atlas context scout/build after resolving the listed gaps"
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
        contextContentPackArtifactId: contextPackRecord.artifactId,
        contextReadiness: qualityReport.readiness,
        gitFingerprint: git?.base_fingerprint,
        scannedFileCount: discovery.scannedFileCount,
        candidateSourceCount: discovery.sources.length,
        includedSourceCount: discovery.includedSources.length,
        excludedCandidateCount: discovery.excludedCandidates.length
      }
    });

    return {
      sessionId: session.sessionId,
      contextArtifactId: artifactId,
      contextQualityReportArtifactId: qualityArtifactId,
      contextContentPackArtifactId: contextPackRecord.artifactId,
      contextReadiness: qualityReport.readiness,
      state: next,
      sourceCount: discovery.sources.length,
      includedSourceCount: discovery.includedSources.length,
      scannedFileCount: discovery.scannedFileCount,
      candidateSourceCount: discovery.sources.length,
      excludedCandidateCount: discovery.excludedCandidates.length,
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
  const includedSources = input.discovery.includedSources;
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
  for (const gap of input.discovery.gaps) {
    issues.push({ code: gap.code, severity: gap.severity, summary: gap.description });
  }
  for (const gap of gapsFromAiRecommendation(input.aiRecommendation)) {
    issues.push({ code: gap.id, severity: gap.severity, summary: gap.description });
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

function gapsFromAiRecommendation(
  recommendation: ReturnType<typeof aiContextRecommendationSchema.parse> | undefined
): Array<{ id: string; severity: "blocking"; description: string }> {
  if (recommendation === undefined) return [];
  return [
    ...recommendation.missing_context.map((description, index) => ({
      id: `scout-missing-${String(index + 1).padStart(3, "0")}`,
      severity: "blocking" as const,
      description: `Missing required context: ${description}`
    })),
    ...recommendation.questions.map((description, index) => ({
      id: `scout-question-${String(index + 1).padStart(3, "0")}`,
      severity: "blocking" as const,
      description: `Unresolved context question: ${description}`
    }))
  ];
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
