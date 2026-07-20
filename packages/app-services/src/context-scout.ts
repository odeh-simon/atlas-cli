import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { discoverContextSources } from "@atlas/context-discovery";
import { StateTransitionError, ValidationError } from "@atlas/domain";
import { createAiCompletion, type AiProviderConfig, type AiCompletionResponse } from "@atlas/llm";
import {
  addArtifactDependency,
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository
} from "@atlas/persistence";
import { redactSecretText } from "@atlas/security";
import { aiContextRecommendationSchema } from "@atlas/schemas";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface RunAiContextScoutInput extends RuntimeOptions {
  readonly provider: AiProviderConfig;
  readonly apiKey?: string | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly completionImpl?: ((prompt: string) => Promise<AiCompletionResponse>) | undefined;
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
  const runtime = await openAtlasRuntime(input);
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
      rootPath: runtime.paths.cwd,
      maxInputTokens: input.provider.maxInputTokens,
      taskBriefText,
      sources: discovery.sources.filter((source) => source.included)
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
                  "You are Atlas context scout. Return strict JSON with recommendations, missing_context, and questions."
              },
              { role: "user", content: prompt }
            ],
            temperature: 0
          })
        : await input.completionImpl(prompt);
    const parsed = parseScoutResponse(completion.content, new Set(promptSources.map((source) => source.uri)));
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const recommendation = aiContextRecommendationSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "ai_context_recommendation",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "ai_context_recommendation").length + 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [taskBrief.artifactId],
      content_sha256: "0".repeat(64),
      metadata: {
        discovery: "ai-context-scout",
        candidate_count: discovery.sources.length,
        included_candidate_count: discovery.sources.filter((source) => source.included).length
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
      producerType: "atlas",
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
      actorType: "atlas",
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
    closeAtlasRuntime(runtime);
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
    readonly snippet: string;
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
  readonly rootPath: string;
  readonly maxInputTokens: number | undefined;
  readonly taskBriefText: string;
  readonly sources: readonly {
    readonly uri: string;
    readonly kind: string;
    readonly reason: string;
    readonly byte_length: number;
  }[];
}): Array<{
  readonly uri: string;
  readonly kind: string;
  readonly reason: string;
  readonly byteLength: number;
  readonly snippet: string;
}> {
  const maxPromptChars = (input.maxInputTokens ?? 12_000) * 4;
  const reservedChars = input.taskBriefText.length + 4_000;
  const sourceBudget = Math.max(2_000, maxPromptChars - reservedChars);
  const perSourceCap = Math.max(500, Math.min(4_000, Math.floor(sourceBudget / Math.max(1, input.sources.length))));
  const promptSources: Array<{
    uri: string;
    kind: string;
    reason: string;
    byteLength: number;
    snippet: string;
  }> = [];
  let usedChars = 0;

  for (const source of input.sources) {
    if (usedChars >= sourceBudget) break;
    const remaining = sourceBudget - usedChars;
    const snippet = readSafeSnippet(input.rootPath, source.uri, Math.min(perSourceCap, remaining));
    promptSources.push({
      uri: source.uri,
      kind: source.kind,
      reason: source.reason,
      byteLength: source.byte_length,
      snippet
    });
    usedChars += snippet.length;
  }

  return promptSources;
}

function parseScoutResponse(content: string, candidateUris: ReadonlySet<string>): z.infer<typeof scoutResponseSchema> {
  try {
    const parsed = scoutResponseSchema.parse(JSON.parse(extractJsonObject(content)));
    return {
      ...parsed,
      recommendations: parsed.recommendations.filter((recommendation) => candidateUris.has(recommendation.uri))
    };
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

function readSafeSnippet(rootPath: string, uri: string, maxChars = 4_000): string {
  const text = readFileSync(join(rootPath, uri), "utf8");
  return redactSecretText(text).slice(0, maxChars);
}
