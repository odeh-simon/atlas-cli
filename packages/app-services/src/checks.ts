import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Bytes, writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError, StateTransitionError } from "@atlas/domain";
import {
  appendEvent,
  createArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository,
  updateSessionState
} from "@atlas/persistence";
import { checkResultSchema } from "@atlas/schemas";
import { transition } from "@atlas/workflow-engine";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface RunBasicCheckResult {
  readonly sessionId: string;
  readonly checkResultArtifactId: string;
  readonly status: "passed" | "failed";
  readonly state: string;
  readonly nextCommand: string;
}

export async function runBasicCheck(options: RuntimeOptions = {}): Promise<RunBasicCheckResult> {
  const runtime = await openAtlasRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      throw new StateTransitionError("No active session found for checks");
    }

    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const failures: string[] = [];
    if (!artifacts.some((artifact) => artifact.type === "implementation_contract" && artifact.status === "approved")) {
      failures.push("approved contract missing");
    }
    if (!artifacts.some((artifact) => artifact.type === "execution_report")) {
      failures.push("execution report missing");
    }
    for (const artifact of artifacts) {
      const bytes = readFileSync(join(runtime.paths.artifactRoot, artifact.storageUri));
      if (sha256Bytes(bytes) !== artifact.sha256) {
        failures.push(`artifact hash mismatch: ${artifact.artifactId}`);
      }
      const text = bytes.toString("utf8");
      if (/SECRET_FIXTURE|BEGIN PRIVATE KEY|AKIA[0-9A-Z]{16}/.test(text)) {
        failures.push(`secret-like content detected: ${artifact.artifactId}`);
      }
    }

    const status = failures.length === 0 ? "passed" : "failed";
    const now = new Date().toISOString();
    const artifactId = newId("art");
    const checkResult = checkResultSchema.parse({
      artifact_id: artifactId,
      session_id: session.sessionId,
      type: "check_result",
      schema_version: 1,
      content_version: 1,
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "internal",
      parents: [],
      content_sha256: "0".repeat(64),
      metadata: {},
      check_name: "basic-session-integrity",
      status,
      required: true,
      summary: status === "passed" ? "Basic session integrity passed" : failures.join("; ")
    });
    const written = writeImmutableArtifactContent({
      rootDir: runtime.paths.artifactRoot,
      sessionId: session.sessionId,
      artifactId,
      type: "check_result",
      contentVersion: artifacts.filter((artifact) => artifact.type === "check_result").length + 1,
      mediaType: "application/json",
      content: `${JSON.stringify(checkResult, null, 2)}\n`
    });
    createArtifactRecord(runtime.db, {
      artifactId,
      sessionId: session.sessionId,
      type: "check_result",
      schemaVersion: 1,
      contentVersion: artifacts.filter((artifact) => artifact.type === "check_result").length + 1,
      storageUri: written.storageUri,
      sha256: written.sha256,
      byteLength: written.byteLength,
      mediaType: "application/json",
      sensitivity: "internal",
      status: status === "passed" ? "valid" : "rejected",
      producerType: "atlas",
      createdAt: now
    });

    if (status === "failed") {
      appendEvent(runtime.db, {
        eventId: newId("evt"),
        sessionId: session.sessionId,
        eventType: "checks.failed",
        actorType: "atlas",
        occurredAt: now,
        summary: "Basic session integrity failed",
        metadata: { checkResultArtifactId: artifactId, failures }
      });
      throw new GateFailedError("Required check failed", { failures, checkResultArtifactId: artifactId });
    }

    const next = transition({
      state: session.primaryState,
      command: "run_basic_check",
      overlay: { paused: session.paused, archived: session.archived, disposition: session.disposition }
    }).to;
    updateSessionState(runtime.db, { sessionId: session.sessionId, primaryState: next, now });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "checks.passed",
      actorType: "atlas",
      occurredAt: now,
      summary: "Basic session integrity passed",
      metadata: { checkResultArtifactId: artifactId }
    });

    return {
      sessionId: session.sessionId,
      checkResultArtifactId: artifactId,
      status,
      state: next,
      nextCommand: "atlas review prepare"
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}
