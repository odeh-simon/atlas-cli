import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository
} from "@atlas/persistence";
import { adapterWritebackSchema } from "@atlas/schemas";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface RecordAdapterWritebackInput extends RuntimeOptions {
  readonly provider: "linear" | "github" | "figma";
  readonly mode: "dry-run" | "write";
  readonly status: "prepared" | "written" | "blocked" | "failed";
  readonly target: string;
  readonly summary: string;
  readonly remoteId?: string | undefined;
  readonly remoteUrl?: string | undefined;
  readonly evidence?: readonly string[] | undefined;
}

export interface RecordAdapterWritebackResult {
  readonly sessionId: string;
  readonly writebackArtifactId: string;
  readonly provider: "linear" | "github" | "figma";
  readonly status: "prepared" | "written" | "blocked" | "failed";
}

export async function recordAdapterWriteback(
  input: RecordAdapterWritebackInput
): Promise<RecordAdapterWritebackResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for adapter writeback");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const writeback = adapterWritebackSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "adapter_writeback",
      schema_version: 1,
      content_version: artifacts.filter((artifact) => artifact.type === "adapter_writeback").length + 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "internal",
      parents: artifacts
        .filter((artifact) => artifact.type === "completion_report" || artifact.type === "orchestration_run")
        .slice(-3)
        .map((artifact) => artifact.artifactId),
      content_sha256: "0".repeat(64),
      metadata: {},
      provider: input.provider,
      mode: input.mode,
      status: input.status,
      target: input.target,
      summary: input.summary,
      ...(input.remoteId === undefined ? {} : { remote_id: input.remoteId }),
      ...(input.remoteUrl === undefined ? {} : { remote_url: input.remoteUrl }),
      evidence: input.evidence ?? []
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "adapter_writeback",
      contentVersion: writeback.content_version,
      mediaType: "application/json",
      content: `${JSON.stringify(writeback, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "adapter_writeback",
      schemaVersion: 1,
      contentVersion: writeback.content_version,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: input.status === "written" || input.status === "prepared" ? "valid" : "rejected",
      producerType: "atlas",
      createdAt: now
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "adapter.writeback_recorded",
      actorType: "atlas",
      occurredAt: now,
      summary: `Adapter writeback ${input.status}`,
      metadata: { writebackArtifactId: artifactId, provider: input.provider, mode: input.mode, target: input.target }
    });

    return {
      sessionId: session.sessionId,
      writebackArtifactId: artifactId,
      provider: input.provider,
      status: input.status
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}
