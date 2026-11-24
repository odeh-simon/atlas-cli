import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeImmutableArtifactContent } from "@sigil/artifacts";
import { discoverContextSources } from "@sigil/context-discovery";
import { StateTransitionError, ValidationError } from "@sigil/domain";
import {
  assertAiDataConsent,
  createAiCompletion,
  isCloudAiProvider,
  type AiProviderConfig,
  type AiCompletionResponse
} from "@sigil/llm";
import {
  addArtifactDependency,
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository
} from "@sigil/persistence";
import { aiContextRecommendationSchema } from "@sigil/schemas";

import { closeSigilRuntime, newId, openSigilRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface RunAiContextScoutInput extends RuntimeOptions {
  readonly provider: AiProviderConfig;
  readonly apiKey?: string | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly completionImpl?: ((prompt: string) => Promise<AiCompletionResponse>) | undefined;
  readonly cloudDataConsent?: boolean | undefined;
}

export interface RunAiContextScoutResult {
  readonly sessionId: string;
  readonly recommendationArtifactId: string;
  readonly recommendationCount: number;
  readonly missingContextCount: number;
}

const scoutResponseSchema = z.object({
  recommendations: z.array(
    z.object({
      uri: z.string().min(1),
      reason: z.string().min(1),
      confidence: z.number().min(0).max(1)
    })
  ),
  missing_context: z.array(z.string().min(1)).default([]),
  questions: z.array(z.string().min(1)).default([])
});

export async function runAiContextScout(input: RunAiContextScoutInput): Promise<RunAiContextScoutResult> {
  assertAiDataConsent(input.provider, "code-context", input.cloudDataConsent);
  const runtime = await openSigilRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for AI context scout");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const taskBrief = artifacts.find((artifact) => artifact.type === "task_brief" && artifact.status === "valid");
    if (taskBrief === undefined) {
      throw new StateTransitionError("AI context scout requires a task brief");
    }

    const taskBriefText = readFileSync(join(runtime.paths.artifactRoot, taskBrief.storageUri), "utf8");
    const discovery = discoverContextSources({
      rootPath: runtime.paths.cwd,
      budget: {
        ...(input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
      },
      taskText: taskBriefText
    });
    const promptSources = buildPromptSources({
      maxInputTokens: input.provider.maxInputTokens,
      taskBriefText,
      sources: discovery.includedSources,
      fragments: discovery.evidenceFragments,
      symbols: discovery.symbols,
      relations: discovery.relations
    });
    const prompt = buildScoutPrompt({
      taskBriefText,
      repoRoot: runtime.paths.cwd,
      sources: promptSources
    });
    const completion =
      input.completionImpl === undefined
        ? await createAiCompletion({
            provider: input.provider,
            apiKey: input.apiKey,
            fetchImpl: input.fetchImpl,
            responseFormat: "json",
            messages: [
              {
                role: "system",
                content:
                  "You are Sigil context scout. Return strict JSON with recommendations, missing_context, and questions."
              },
              { role: "user", content: prompt }
            ],
            temperature: 0
          })
        : await input.completionImpl(prompt);
    const parsed = parseScoutResponse(completion.content);
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const recommendation = aiContextRecommendationSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "ai_context_recommendation",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "ai_context_recommendation").length + 1,
      created_at: now,
      producer: { type: "sigil" },
      sensitivity: "confidential",
      parents: [taskBrief.artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        discovery: "ai-context-scout",
        scanned_file_count: discovery.scannedFileCount,
        candidate_count: discovery.sources.length,
        included_candidate_count: discovery.includedSources.length,
        omitted_scan_count: discovery.omittedScanCount,
        data_egress: {
          destination: isCloudAiProvider(input.provider) ? "cloud" : "local",
          consent: input.cloudDataConsent === true,
          payload: "task-and-source-context"
        }
      },
      provider_alias: input.provider.alias,
      model: input.provider.model,
      task_artifact_id: taskBrief.artifactId,
      recommendations: parsed.recommendations,
      missing_context: parsed.missing_context,
      questions: parsed.questions
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "ai_context_recommendation",
      contentVersion: recommendation.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(recommendation, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "ai_context_recommendation",
      schemaVersion: 1,
      contentVersion: recommendation.content_version,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "confidential",
      status: "valid",
      producerType: "sigil",
      createdAt: now
    });
    addArtifactDependency(runtime.db, {
      artifactId,
      dependsOnArtifactId: taskBrief.artifactId,
      dependencyKind: "input"
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "context.ai_scouted",
      actorType: "sigil",
      occurredAt: now,
      summary: "AI context recommendation created",
      metadata: {
        recommendationArtifactId: artifactId,
        providerAlias: input.provider.alias,
        recommendationCount: recommendation.recommendations.length
      }
    });

    return {
      sessionId: session.sessionId,
      recommendationArtifactId: artifactId,
      recommendationCount: recommendation.recommendations.length,
      missingContextCount: recommendation.missing_context.length
    };
  } finally {
    closeSigilRuntime(runtime);
  }
}

function buildScoutPrompt(input: {
  readonly taskBriefText: string;
  readonly repoRoot: string;
  readonly sources: readonly {
    readonly uri: string;
    readonly kind: string;
    readonly reason: string;
    readonly byteLength: number;
    readonly category: string;
    readonly deterministicScore: number;
    readonly selectionReasons: readonly string[];
    readonly symbols: readonly string[];
    readonly relations: readonly string[];
    readonly evidence: readonly { readonly lineStart: number; readonly lineEnd: number; readonly excerpt: string; readonly truncated: boolean }[];
  }[];
}): string {
  return JSON.stringify(
    {
      instruction:
        "Rank the files needed for an implementation-planning agent. Use only provided candidate URIs. Do not invent files. Return only a JSON object, with no markdown fences or explanatory text.",
      response_shape: {
        recommendations: [{ uri: "path", reason: "why this source matters", confidence: 0.8 }],
        missing_context: ["important missing source or ambiguity"],
        questions: ["blocking clarification question"]
      },
      repo_root: input.repoRoot,
      task_brief: JSON.parse(input.taskBriefText),
      candidates: input.sources
    },
    null,
    2
  );
}

function buildPromptSources(input: {
  readonly maxInputTokens: number | undefined;
  readonly taskBriefText: string;
  readonly sources: readonly {
    readonly uri: string;
    readonly kind: string;
    readonly category: string;
    readonly reason: string;
    readonly byte_length: number;
    readonly deterministic_score: number;
    readonly selection_reasons: readonly string[];
  }[];
  readonly fragments: readonly { readonly source_uri: string; readonly line_start: number; readonly line_end: number; readonly excerpt: string; readonly excerpt_truncated: boolean }[];
  readonly symbols: readonly { readonly source_uri: string; readonly name: string; readonly kind: string }[];
  readonly relations: readonly { readonly kind: string; readonly from_uri: string; readonly to_uri: string; readonly rule: string }[];
}): Array<{
  readonly uri: string;
  readonly kind: string;
  readonly reason: string;
  readonly byteLength: number;
  readonly category: string;
  readonly deterministicScore: number;
  readonly selectionReasons: readonly string[];
  readonly symbols: readonly string[];
  readonly relations: readonly string[];
  readonly evidence: readonly { readonly lineStart: number; readonly lineEnd: number; readonly excerpt: string; readonly truncated: boolean }[];
}> {
  const maxPromptChars = (input.maxInputTokens ?? 12_000) * 4;
  const reservedChars = input.taskBriefText.length + 4_000;
  const sourceBudget = Math.max(2_000, maxPromptChars - reservedChars);
  const perSourceCap = Math.max(500, Math.min(4_000, Math.floor(sourceBudget / Math.max(1, input.sources.length))));
  const promptSources: ReturnType<typeof buildPromptSources> = [];
  let usedChars = 0;

  for (const source of input.sources) {
    if (usedChars >= sourceBudget) break;
    const remaining = sourceBudget - usedChars;
    const evidence = input.fragments.filter((fragment) => fragment.source_uri === source.uri).map((fragment) => ({
      lineStart: fragment.line_start,
      lineEnd: fragment.line_end,
      excerpt: fragment.excerpt,
      truncated: fragment.excerpt_truncated
    }));
    const summary = {
      uri: source.uri,
      kind: source.kind,
      reason: source.reason,
      byteLength: source.byte_length,
      category: source.category,
      deterministicScore: source.deterministic_score,
      selectionReasons: source.selection_reasons,
      symbols: input.symbols.filter((symbol) => symbol.source_uri === source.uri).slice(0, 20).map((symbol) => `${symbol.kind}:${symbol.name}`),
      relations: input.relations.filter((relation) => relation.from_uri === source.uri || relation.to_uri === source.uri).slice(0, 20).map((relation) => `${relation.kind}:${relation.from_uri}->${relation.to_uri}:${relation.rule}`),
      evidence
    };
    const bounded = boundCandidateSummary(summary, Math.min(perSourceCap, remaining));
    promptSources.push(bounded);
    usedChars += JSON.stringify(bounded).length;
  }

  return promptSources;
}

function parseScoutResponse(content: string): z.infer<typeof scoutResponseSchema> {
  try {
    return scoutResponseSchema.parse(JSON.parse(extractJsonObject(content)));
  } catch (error) {
    throw new ValidationError("AI context scout returned malformed JSON", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    const fencedContent = fenced[1].trim();
    if (fencedContent.startsWith("{") && fencedContent.endsWith("}")) return fencedContent;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) return trimmed;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, index + 1);
    }
  }
  return trimmed;
}

function boundCandidateSummary<T extends { readonly evidence: readonly { readonly excerpt: string }[] }>(summary: T, maxChars: number): T {
  const fixedLength = JSON.stringify({ ...summary, evidence: [] }).length;
  let remaining = Math.max(0, maxChars - fixedLength);
  const evidence = summary.evidence.map((fragment) => {
    const excerpt = [...fragment.excerpt].slice(0, remaining).join("");
    remaining -= excerpt.length;
    return { ...fragment, excerpt };
  });
  return { ...summary, evidence };
}
