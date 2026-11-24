import { writeImmutableArtifactContent } from "@sigil/artifacts";
import type { LinearIssueSnapshot } from "@sigil/adapters-linear";
import { ValidationError } from "@sigil/domain";
import {
  appendEvent,
  createArtifactRecord,
  createRepository,
  createSession,
  findActiveSessionByTask,
  getRepository,
  getSession,
  type SessionRecord
} from "@sigil/persistence";
import { taskBriefSchema } from "@sigil/schemas";
import { transition } from "@sigil/workflow-engine";

import {
  closeSigilRuntime,
  newId,
  openSigilRuntime,
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

export interface StartLinearIssueTaskInput extends RuntimeOptions {
  readonly issue: LinearIssueSnapshot;
}

export async function startManualTask(input: StartManualTaskInput): Promise<StartManualTaskResult> {
  const title = input.title.trim();
  const objective = input.objective.trim();
  if (title.length === 0 || objective.length === 0) {
    throw new ValidationError("Manual task requires a title and objective");
  }

  const runtime = await openSigilRuntime(input);
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
        nextCommand: "sigil context import <file>"
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
      producer: { type: "sigil" },
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
      producerType: "sigil",
      createdAt: now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "session.created",
      actorType: "sigil",
      occurredAt: now,
      summary: "Manual task session created",
      metadata: { taskKey, taskBriefArtifactId: artifactId }
    });

    return {
      session,
      taskBriefArtifactId: artifactId,
      resumedExisting: false,
      nextCommand: "sigil context import <file>"
    };
  } finally {
    closeSigilRuntime(runtime);
  }
}

export async function startLinearIssueTask(input: StartLinearIssueTaskInput): Promise<StartManualTaskResult> {
  return startTaskSession({
    ...input,
    title: input.issue.title,
    objective: input.issue.description || input.issue.title,
    taskKey: input.issue.issueKey,
    taskSource: "linear",
    source: "linear",
    references: [
      ...(input.issue.url === undefined ? [] : [input.issue.url]),
      ...input.issue.links.map((link) => link.url)
    ],
    acceptanceCriteria: input.issue.labels.map((label) => `Linear label: ${label}`),
    metadata: {
      task_key: input.issue.issueKey,
      linear_issue_id: input.issue.issueId,
      linear_state: input.issue.state,
      linear_priority: input.issue.priority,
      linear_comment_count: input.issue.comments.length
    }
  });
}

async function startTaskSession(
  input: StartManualTaskInput & {
    readonly taskSource: "manual" | "linear";
    readonly source: "manual" | "linear";
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  }
): Promise<StartManualTaskResult> {
  const title = input.title.trim();
  const objective = input.objective.trim();
  if (title.length === 0 || objective.length === 0) {
    throw new ValidationError("Task requires a title and objective");
  }

  const runtime = await openSigilRuntime(input);
  try {
    const now = new Date().toISOString();
    const repoId = repoIdForPath(runtime.paths.cwd);
    const taskKey = input.taskKey?.trim() || manualTaskKey(title, objective);
    const existing = findActiveSessionByTask(runtime.db, repoId, input.taskSource, taskKey);
    if (existing !== undefined) {
      return {
        session: existing,
        taskBriefArtifactId: existing.currentContextArtifactId ?? "",
        resumedExisting: true,
        nextCommand: "sigil context import <file>"
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
      taskSource: input.taskSource,
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
      producer: { type: "sigil" },
      sensitivity: "internal",
      parents: [],
      content_sha256: "0".repeat(64),
      metadata: input.metadata ?? { task_key: taskKey },
      title,
      objective,
      source: input.source,
      repo_id: repoId,
      references: (input.references ?? []).map((reference) => ({
        original_text: reference,
        canonical_url: reference.startsWith("http") ? reference : undefined,
        kind: reference.includes("figma.com") ? "figma" : reference.includes("github.com") ? "github" : "url",
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
      producerType: "sigil",
      createdAt: now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "session.created",
      actorType: "sigil",
      occurredAt: now,
      summary: `${input.source === "linear" ? "Linear" : "Manual"} task session created`,
      metadata: { taskKey, taskBriefArtifactId: artifactId }
    });

    return {
      session,
      taskBriefArtifactId: artifactId,
      resumedExisting: false,
      nextCommand: "sigil context import <file>"
    };
  } finally {
    closeSigilRuntime(runtime);
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
