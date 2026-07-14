import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError, type DecisionRecordKind, type MaterialChangeCategory } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  createDecisionRecord,
  listArtifactsForSession,
  listSessionsForRepository
} from "@atlas/persistence";
import { decisionRecordSchema } from "@atlas/schemas";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface RecordDecisionInput extends RuntimeOptions {
  readonly kind: DecisionRecordKind;
  readonly title: string;
  readonly rationale: string;
  readonly category: MaterialChangeCategory;
  readonly actorId?: string | undefined;
  readonly supersedesDecisionId?: string | undefined;
}

export interface RecordDecisionResult {
  readonly sessionId: string;
  readonly decisionId: string;
  readonly artifactId: string;
  readonly kind: DecisionRecordKind;
}

export async function recordDecision(input: RecordDecisionInput): Promise<RecordDecisionResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) throw new StateTransitionError("No active session found for decision record");

    const now = new Date().toISOString();
    const artifactId = newId("art");
    const decisionId = newId(input.kind === "decision" ? "dec" : "dev");
    const actorId = input.actorId ?? "local-user";
    const decision = decisionRecordSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "decision_record",
      schema_version: 1,
      content_version: 1,
      created_at: now,
      producer: { type: "user", id: actorId },
      sensitivity: "internal",
      parents: [],
      content_sha256: "0".repeat(64),
      metadata: {},
      decision_id: decisionId,
      kind: input.kind,
      title: input.title,
      rationale: input.rationale,
      category: input.category,
      approved_by: actorId,
      approved_at: now,
      ...(input.supersedesDecisionId === undefined ? {} : { supersedes_decision_id: input.supersedesDecisionId })
    });
    const contentVersion =
      listArtifactsForSession(runtime.db, session.sessionId).filter((artifact) => artifact.type === "decision_record")
        .length + 1;
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "decision_record",
      contentVersion,
      mediaType: "application/json",
      content: `${JSON.stringify(decision, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "decision_record",
      schemaVersion: 1,
      contentVersion,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: "approved",
      producerType: "user",
      producerId: actorId,
      createdAt: now,
      approvedAt: now
    });
    createDecisionRecord(runtime.db, {
      decisionId,
      sessionId: session.sessionId,
      artifactId,
      kind: input.kind,
      title: input.title,
      rationale: input.rationale,
      category: input.category,
      approvedBy: actorId,
      approvedAt: now,
      supersedesDecisionId: input.supersedesDecisionId
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "decision.recorded",
      actorType: "user",
      actorId,
      occurredAt: now,
      summary: `${input.kind === "decision" ? "Decision" : "Deviation"} recorded`,
      metadata: { decisionId, artifactId, category: input.category }
    });

    return { sessionId: session.sessionId, decisionId, artifactId, kind: input.kind };
  } finally {
    closeAtlasRuntime(runtime);
  }
}
