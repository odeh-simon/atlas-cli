import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError } from "@atlas/domain";
import {
  assertAiDataConsent,
  createAiCompletion,
  isCloudAiProvider,
  type AiCompletionResponse,
  type AiProviderConfig
} from "@atlas/llm";
import {
  addArtifactDependency,
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@atlas/persistence";
import { aiPlanningDraftSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ExportPlanningPackageResult {
  readonly sessionId: string;
  readonly planningArtifactId: string;
  readonly aiPlanningDraftArtifactId?: string | undefined;
  readonly state: string;
  readonly nextCommand: string;
}

export interface AiPlanningOptions {
  readonly provider: AiProviderConfig;
  readonly apiKey?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly completionImpl?: ((prompt: string) => Promise<AiCompletionResponse>) | undefined;
  readonly cloudDataConsent?: boolean | undefined;
}

export interface ExportPlanningPackageInput extends RuntimeOptions {
  readonly ai?: AiPlanningOptions | undefined;
}

export async function exportPlanningPackage(options: ExportPlanningPackageInput = {}): Promise<ExportPlanningPackageResult> {
  const runtime = await openAtlasRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for planning export");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const taskBrief = artifacts.find((artifact) => artifact.type === "task_brief");
    const contextManifest = artifacts.find((artifact) => artifact.type === "context_manifest");
    if (taskBrief === undefined || contextManifest === undefined) {
      throw new StateTransitionError("Planning export requires task brief and context manifest artifacts");
    }

    const now = new Date().toISOString();
    const next = transition({
      state: session.primaryState,
      command: "export_plan",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    const contentVersion =
      artifacts.filter((artifact) => artifact.type === "planning_package_metadata").length + 1;
    const artifactId = newId("art");
    const markdown = renderPlanningMarkdown({
      sessionId: session.sessionId,
      taskBriefId: taskBrief.artifactId,
      taskBriefHash: taskBrief.sha256,
      contextManifestId: contextManifest.artifactId,
      contextManifestHash: contextManifest.sha256
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "planning_package_metadata",
      contentVersion,
      mediaType: "text/markdown",
      content: markdown
    });

    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "planning_package_metadata",
      schemaVersion: 1,
      contentVersion,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "text/markdown",
      sensitivity: "confidential",
      status: "valid",
      producerType: "atlas",
      createdAt: now
    });

    let aiPlanningDraftArtifactId: string | undefined;
    if (options.ai !== undefined) {
      assertAiDataConsent(options.ai.provider, "code-context", options.ai.cloudDataConsent);
      const draftArtifactId = newId("art");
      const prompt = renderAiPlanningPrompt({
        taskBrief: readFileSync(join(runtime.paths.artifactRoot, taskBrief.storageUri), "utf8"),
        contextManifest: readFileSync(join(runtime.paths.artifactRoot, contextManifest.storageUri), "utf8"),
        taskBriefId: taskBrief.artifactId,
        taskBriefHash: taskBrief.sha256,
        contextManifestId: contextManifest.artifactId,
        contextManifestHash: contextManifest.sha256
      });
      const completion =
        options.ai.completionImpl === undefined
          ? await createAiCompletion({
              provider: options.ai.provider,
              apiKey: options.ai.apiKey,
              fetchImpl: options.ai.fetchImpl,
              messages: [
                {
                  role: "system",
                  content:
                    "You are Atlas planning assistant. Produce a concise implementation contract draft in Markdown."
                },
                { role: "user", content: prompt }
              ],
              temperature: 0,
              responseFormat: "text"
            })
          : await options.ai.completionImpl(prompt);
      const aiDraft = aiPlanningDraftSchema.parse({
        artifact_id: draftArtifactId,
        session_id: session.sessionId,
        type: "ai_planning_draft",
        schema_version: 1,
        content_version: artifacts.filter((artifact) => artifact.type === "ai_planning_draft").length + 1,
        created_at: now,
        producer: { type: "atlas" },
        sensitivity: "confidential",
        parents: [taskBrief.artifactId, contextManifest.artifactId, artifactId],
        content_sha256: "0".repeat(64),
        metadata: {
          planning_package_artifact_id: artifactId,
          next_gate: "atlas contract import <file>",
          data_egress: {
            destination: isCloudAiProvider(options.ai.provider) ? "cloud" : "local",
            consent: options.ai.cloudDataConsent === true,
            payload: "task-and-context-manifest"
          }
        },
        provider_alias: options.ai.provider.alias,
        model: options.ai.provider.model,
        task_artifact_id: taskBrief.artifactId,
        task_artifact_sha256: taskBrief.sha256,
        context_manifest_artifact_id: contextManifest.artifactId,
        context_manifest_sha256: contextManifest.sha256,
        draft_markdown: completion.content.trim(),
        ready_label: completion.content.trim().length === 0 ? "blocked" : "draft"
      });
      const aiWritten = writeImmutableArtifactContent({
        rootDir: runtime.paths.artifactRoot,
        sessionId: session.sessionId,
        artifactId: draftArtifactId,
        type: "ai_planning_draft",
        contentVersion: aiDraft.content_version,
        mediaType: "application/json",
        content: `${JSON.stringify(aiDraft, null, 2)}\n`
      });
      createArtifactRecord(runtime.db, {
        artifactId: draftArtifactId,
        sessionId: session.sessionId,
        type: "ai_planning_draft",
        schemaVersion: 1,
        contentVersion: aiDraft.content_version,
        storageUri: aiWritten.storageUri,
        sha256: aiWritten.sha256,
        byteLength: aiWritten.byteLength,
        mediaType: "application/json",
        sensitivity: "confidential",
        status: aiDraft.ready_label === "blocked" ? "rejected" : "valid",
        producerType: "atlas",
        createdAt: now
      });
      for (const dependsOnArtifactId of [taskBrief.artifactId, contextManifest.artifactId, artifactId]) {
        addArtifactDependency(runtime.db, {
          artifactId: draftArtifactId,
          dependsOnArtifactId,
          dependencyKind: "input"
        });
      }
      aiPlanningDraftArtifactId = draftArtifactId;
    }

    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "planning.exported",
      actorType: "atlas",
      occurredAt: now,
      summary: options.ai === undefined ? "Planning package exported" : "AI-assisted planning package exported",
      metadata: {
        planningArtifactId: artifactId,
        ...(aiPlanningDraftArtifactId === undefined ? {} : { aiPlanningDraftArtifactId })
      }
    });

    return {
      sessionId: session.sessionId,
      planningArtifactId: artifactId,
      ...(aiPlanningDraftArtifactId === undefined ? {} : { aiPlanningDraftArtifactId }),
      state: next,
      nextCommand: "atlas contract import <file>"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function renderAiPlanningPrompt(input: {
  readonly taskBrief: string;
  readonly contextManifest: string;
  readonly taskBriefId: string;
  readonly taskBriefHash: string;
  readonly contextManifestId: string;
  readonly contextManifestHash: string;
}): string {
  return `Create an implementation contract draft for Atlas.

Hard requirements:
- Reference task brief ${input.taskBriefId} (${input.taskBriefHash}).
- Reference context manifest ${input.contextManifestId} (${input.contextManifestHash}).
- Include objective, scope, technical approach, affected files/subsystems, tests, edge cases, and unresolved questions.
- Do not claim approval. The developer must still import and approve the final contract.

Task brief JSON:
${input.taskBrief}

Context manifest JSON:
${input.contextManifest}
`;
}

function renderPlanningMarkdown(input: {
  readonly sessionId: string;
  readonly taskBriefId: string;
  readonly taskBriefHash: string;
  readonly contextManifestId: string;
  readonly contextManifestHash: string;
}): string {
  return `# Atlas Planning Package

Session: ${input.sessionId}

## Inputs

- Task brief: ${input.taskBriefId} (${input.taskBriefHash})
- Context manifest: ${input.contextManifestId} (${input.contextManifestHash})

## Planning Instructions

Create an implementation contract with objective, scope, decisions, technical approach, reuse, constraints, data/state behavior, required states, edge cases, acceptance criteria, tests, unresolved questions, and prohibitions.
`;
}
