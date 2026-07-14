import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@atlas/persistence";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface ExportPlanningPackageResult {
  readonly sessionId: string;
  readonly planningArtifactId: string;
  readonly state: string;
  readonly nextCommand: string;
}

export async function exportPlanningPackage(options: RuntimeOptions = {}): Promise<ExportPlanningPackageResult> {
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
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "planning.exported",
      actorType: "atlas",
      occurredAt: now,
      summary: "Planning package exported",
      metadata: { planningArtifactId: artifactId }
    });

    return {
      sessionId: session.sessionId,
      planningArtifactId: artifactId,
      state: next,
      nextCommand: "atlas contract import <file>"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
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
