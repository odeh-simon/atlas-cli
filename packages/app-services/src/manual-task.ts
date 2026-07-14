import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { ValidationError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  createRepository,
  createSession,
  findActiveSessionByTask,
  getRepository,
  getSession,
  type SessionRecord
} from "@atlas/persistence";
import { taskBriefSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import {
  closeAtlasRuntime,
  newId,
  openAtlasRuntime,
  repoDisplayName,
  repoIdForPath,
  type RuntimeOptions
} from "./runtime.js";

export interface StartManualTaskInput extends RuntimeOptions {
  readonly title: string;
  readonly objective: string;
  readonly taskKey?: string | undefined;
  readonly references?: readonly string[] | undefined;
  readonly acceptanceCriteria?: readonly string[] | undefined;
}

export interface StartManualTaskResult {
  readonly session: SessionRecord;
  readonly taskBriefArtifactId: string;
  readonly resumedExisting: boolean;
  readonly nextCommand: string;
}

export async function startManualTask(input: StartManualTaskInput): Promise<StartManualTaskResult> {
  const title = input.title.trim();
  const objective = input.objective.trim();
  if (title.length === 0 || objective.length === 0) {
    throw new ValidationError("Manual task requires a title and objective");
  }

  const runtime = await openAtlasRuntime(input);
  try {
    const now = new Date().toISOString();
    const repoId = repoIdForPath(runtime.paths.cwd);
    const taskKey = input.taskKey?.trim() || manualTaskKey(title, objective);
    const existing = findActiveSessionByTask(runtime.db, repoId, "manual", taskKey);
    if (existing !== undefined) {
      return {
        session: existing,
        taskBriefArtifactId: existing.currentContextArtifactId ?? "",
        resumedExisting: true,
        nextCommand: "atlas context import <file>"
      };
    }

    if (getRepository(runtime.db, repoId) === undefined) {
      createRepository(runtime.db, {
        repoId,
        rootPath: runtime.paths.cwd,
        displayName: repoDisplayName(runtime.paths.cwd),
        now
      });
    }

    const next = transition({ state: "draft", command: "create_manual_session" }).to;
    const session = createSession(runtime.db, {
      sessionId: newId("ses"),
      repoId,
      taskKey,
      taskSource: "manual",
      primaryState: next,
      now
    });
    const artifactId = newId("art");
    const brief = taskBriefSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "task_brief",
      schema_version: 1,
      content_version: 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "internal",
      parents: [],
      content_sha256: "0".repeat(64),
      metadata: { task_key: taskKey },
      title,
      objective,
      source: "manual",
      repo_id: repoId,
      references: (input.references ?? []).map((reference) => ({
        original_text: reference,
        canonical_url: reference.startsWith("http") ? reference : undefined,
        kind: reference.includes("figma.com") ? "figma" : reference.includes("github.com") ? "github" : "unknown",
        status: "parsed"
      })),
      acceptance_criteria: [...(input.acceptanceCriteria ?? [])]
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "task_brief",
      contentVersion: 1,
      mediaType: "application/json",
      content: `${JSON.stringify(brief, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "task_brief",
      schemaVersion: 1,
      contentVersion: 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: "valid",
      producerType: "atlas",
      createdAt: now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "session.created",
      actorType: "atlas",
      occurredAt: now,
      summary: "Manual task session created",
      metadata: { taskKey, taskBriefArtifactId: artifactId }
    });

    return {
      session,
      taskBriefArtifactId: artifactId,
      resumedExisting: false,
      nextCommand: "atlas context import <file>"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function manualTaskKey(title: string, objective: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `manual-${slug || "task"}-${objective.length}`;
}
