import { basename, join } from "node:path";
import { readFileSync } from "node:fs";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { StateTransitionError, ValidationError } from "@atlas/domain";
import {
  addArtifactDependency,
  appendEvent,
  createArtifactRecord,
  getArtifactRecord,
  listArtifactsForSession,
  listSessionsForRepository
} from "@atlas/persistence";
import { visualCaptureSchema, visualComparisonSchema } from "@atlas/schemas";
import {
  comparePngImages,
  playwrightVisualCaptureAdapter,
  type CapturePageInput,
  type VisualCaptureAdapter
} from "@atlas/visual-qa";

import { closeAtlasRuntime, newId, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface CaptureVisualPageInput extends RuntimeOptions, CapturePageInput {
  readonly captureAdapter?: VisualCaptureAdapter | undefined;
}

export interface CaptureVisualPageResult {
  readonly sessionId: string;
  readonly captureArtifactId: string;
  readonly snapshotArtifactId: string;
  readonly snapshotPath: string;
  readonly snapshotSha256: string;
  readonly browserChannel: "msedge" | "chrome" | "chromium";
}

export interface CompareVisualEvidenceInput extends RuntimeOptions {
  readonly referencePath: string;
  readonly actualPath?: string | undefined;
  readonly actualArtifactId?: string | undefined;
  readonly pixelThreshold?: number | undefined;
  readonly allowedDiffRatio?: number | undefined;
  readonly maxPixels?: number | undefined;
}

export interface CompareVisualEvidenceResult {
  readonly sessionId: string;
  readonly comparisonArtifactId: string;
  readonly referenceArtifactId: string;
  readonly actualArtifactId: string;
  readonly diffArtifactId?: string | undefined;
  readonly diffPath?: string | undefined;
  readonly status: "passed" | "failed" | "dimension-mismatch";
  readonly mismatchedPixels: number;
  readonly totalPixels: number;
  readonly diffRatio: number;
}

export async function captureVisualPage(input: CaptureVisualPageInput): Promise<CaptureVisualPageResult> {
  const runtime = await openAtlasRuntime(input);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    if (session === undefined) throw new StateTransitionError("Visual capture requires an active Atlas session");
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const captured = await (input.captureAdapter ?? playwrightVisualCaptureAdapter).capture(input);
    const now = new Date().toISOString();
    const snapshot = storeBinaryArtifact(runtime, {
      sessionId: session.sessionId,
      type: "visual_snapshot",
      contentVersion: nextVersion(artifacts, "visual_snapshot"),
      content: captured.png,
      mediaType: "image/png",
      extension: ".png",
      now
    });
    const captureArtifactId = newId("art");
    const capture = visualCaptureSchema.parse({
      artifact_id: captureArtifactId,
      session_id: session.sessionId,
      type: "visual_capture",
      schema_version: 1,
      content_version: nextVersion(artifacts, "visual_capture"),
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [snapshot.artifactId],
      content_sha256: "0".repeat(64),
      metadata: { source: "playwright", snapshot_path: snapshot.storageUri },
      url: captured.url,
      title: captured.title,
      viewport: captured.viewport,
      full_page: captured.fullPage,
      browser_channel: captured.browserChannel,
      snapshot_artifact_id: snapshot.artifactId,
      snapshot_sha256: snapshot.sha256,
      captured_at: now
    });
    storeJsonArtifact(runtime, capture, now);
    addArtifactDependency(runtime.db, {
      artifactId: captureArtifactId,
      dependsOnArtifactId: snapshot.artifactId,
      dependencyKind: "evidence"
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "visual.captured",
      actorType: "atlas",
      occurredAt: now,
      summary: "Visual snapshot captured",
      metadata: { captureArtifactId, snapshotArtifactId: snapshot.artifactId, url: captured.url }
    });
    return {
      sessionId: session.sessionId,
      captureArtifactId,
      snapshotArtifactId: snapshot.artifactId,
      snapshotPath: snapshot.absolutePath,
      snapshotSha256: snapshot.sha256,
      browserChannel: captured.browserChannel
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

export async function compareVisualEvidence(input: CompareVisualEvidenceInput): Promise<CompareVisualEvidenceResult> {
  if ((input.actualPath === undefined) === (input.actualArtifactId === undefined)) {
    throw new ValidationError("Visual comparison requires exactly one of actualPath or actualArtifactId");
  }
  const runtime = await openAtlasRuntime(input);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    if (session === undefined) throw new StateTransitionError("Visual comparison requires an active Atlas session");
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const now = new Date().toISOString();
    const referenceBytes = readPng(input.referencePath, "reference");
    const reference = storeBinaryArtifact(runtime, {
      sessionId: session.sessionId,
      type: "visual_reference",
      contentVersion: nextVersion(artifacts, "visual_reference"),
      content: referenceBytes,
      mediaType: "image/png",
      extension: ".png",
      now
    });
    const actual =
      input.actualArtifactId === undefined
        ? storeBinaryArtifact(runtime, {
            sessionId: session.sessionId,
            type: "visual_snapshot",
            contentVersion: nextVersion(artifacts, "visual_snapshot"),
            content: readPng(input.actualPath ?? "", "actual"),
            mediaType: "image/png",
            extension: ".png",
            now
          })
        : resolveSnapshotArtifact(runtime, session.sessionId, input.actualArtifactId);
    const actualBytes = readFileSync(actual.absolutePath);
    const comparison = comparePngImages({
      reference: referenceBytes,
      actual: actualBytes,
      pixelThreshold: input.pixelThreshold,
      allowedDiffRatio: input.allowedDiffRatio,
      maxPixels: input.maxPixels
    });
    const diff =
      comparison.diffPng === undefined
        ? undefined
        : storeBinaryArtifact(runtime, {
            sessionId: session.sessionId,
            type: "visual_diff",
            contentVersion: nextVersion(artifacts, "visual_diff"),
            content: comparison.diffPng,
            mediaType: "image/png",
            extension: ".png",
            now
          });
    const comparisonArtifactId = newId("art");
    const report = visualComparisonSchema.parse({
      artifact_id: comparisonArtifactId,
      session_id: session.sessionId,
      type: "visual_comparison",
      schema_version: 1,
      content_version: nextVersion(artifacts, "visual_comparison"),
      created_at: now,
      producer: { type: "atlas" },
      sensitivity: "confidential",
      parents: [reference.artifactId, actual.artifactId, ...(diff === undefined ? [] : [diff.artifactId])],
      content_sha256: "0".repeat(64),
      metadata: {
        reference_name: basename(input.referencePath),
        actual_source: input.actualArtifactId ?? basename(input.actualPath ?? "")
      },
      status: comparison.status,
      reference: {
        artifact_id: reference.artifactId,
        sha256: reference.sha256,
        width: comparison.reference.width,
        height: comparison.reference.height
      },
      actual: {
        artifact_id: actual.artifactId,
        sha256: actual.sha256,
        width: comparison.actual.width,
        height: comparison.actual.height
      },
      ...(diff === undefined ? {} : { diff_artifact_id: diff.artifactId }),
      mismatched_pixels: comparison.mismatchedPixels,
      total_pixels: comparison.totalPixels,
      diff_ratio: comparison.diffRatio,
      pixel_threshold: comparison.pixelThreshold,
      allowed_diff_ratio: comparison.allowedDiffRatio
    });
    storeJsonArtifact(runtime, report, now);
    for (const evidenceId of report.parents) {
      addArtifactDependency(runtime.db, {
        artifactId: comparisonArtifactId,
        dependsOnArtifactId: evidenceId,
        dependencyKind: "evidence"
      });
    }
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "visual.compared",
      actorType: "atlas",
      occurredAt: now,
      summary: `Visual comparison ${comparison.status}`,
      metadata: { comparisonArtifactId, status: comparison.status, diffRatio: comparison.diffRatio }
    });
    return {
      sessionId: session.sessionId,
      comparisonArtifactId,
      referenceArtifactId: reference.artifactId,
      actualArtifactId: actual.artifactId,
      ...(diff === undefined ? {} : { diffArtifactId: diff.artifactId, diffPath: diff.absolutePath }),
      status: comparison.status,
      mismatchedPixels: comparison.mismatchedPixels,
      totalPixels: comparison.totalPixels,
      diffRatio: comparison.diffRatio
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

function storeBinaryArtifact(
  runtime: Awaited<ReturnType<typeof openAtlasRuntime>>,
  input: {
    readonly sessionId: string;
    readonly type: "visual_snapshot" | "visual_reference" | "visual_diff";
    readonly contentVersion: number;
    readonly content: Uint8Array;
    readonly mediaType: "image/png";
    readonly extension: ".png";
    readonly now: string;
  }
): { readonly artifactId: string; readonly absolutePath: string; readonly storageUri: string; readonly sha256: string } {
  const artifactId = newId("art");
  const written = writeImmutableArtifactContent({
    rootDir: runtime.paths.artifactRoot,
    sessionId: input.sessionId,
    artifactId,
    type: input.type,
    contentVersion: input.contentVersion,
    mediaType: input.mediaType,
    extension: input.extension,
    content: input.content
  });
  createArtifactRecord(runtime.db, {
    artifactId,
    sessionId: input.sessionId,
    type: input.type,
    schemaVersion: 1,
    contentVersion: input.contentVersion,
    storageUri: written.storageUri,
    sha256: written.sha256,
    byteLength: written.byteLength,
    mediaType: input.mediaType,
    sensitivity: "confidential",
    status: "valid",
    producerType: "atlas",
    createdAt: input.now
  });
  return { artifactId, absolutePath: written.absolutePath, storageUri: written.storageUri, sha256: written.sha256 };
}

function storeJsonArtifact(
  runtime: Awaited<ReturnType<typeof openAtlasRuntime>>,
  artifact: { readonly artifact_id: string; readonly session_id: string; readonly type: string; readonly content_version: number },
  now: string
): void {
  const written = writeImmutableArtifactContent({
    rootDir: runtime.paths.artifactRoot,
    sessionId: artifact.session_id,
    artifactId: artifact.artifact_id,
    type: artifact.type,
    contentVersion: artifact.content_version,
    mediaType: "application/json",
    content: `${JSON.stringify(artifact, null, 2)}\n`
  });
  createArtifactRecord(runtime.db, {
    artifactId: artifact.artifact_id,
    sessionId: artifact.session_id,
    type: artifact.type,
    schemaVersion: 1,
    contentVersion: artifact.content_version,
    storageUri: written.storageUri,
    sha256: written.sha256,
    byteLength: written.byteLength,
    mediaType: "application/json",
    sensitivity: "confidential",
    status: "valid",
    producerType: "atlas",
    createdAt: now
  });
}

function resolveSnapshotArtifact(
  runtime: Awaited<ReturnType<typeof openAtlasRuntime>>,
  sessionId: string,
  artifactId: string
): { readonly artifactId: string; readonly absolutePath: string; readonly storageUri: string; readonly sha256: string } {
  const record = getArtifactRecord(runtime.db, artifactId);
  if (record === undefined || record.sessionId !== sessionId || record.type !== "visual_snapshot" || record.mediaType !== "image/png") {
    throw new ValidationError(`Visual snapshot artifact is not available in the active session: ${artifactId}`);
  }
  return {
    artifactId: record.artifactId,
    absolutePath: join(runtime.paths.artifactRoot, record.storageUri),
    storageUri: record.storageUri,
    sha256: record.sha256
  };
}

function readPng(path: string, label: string): Buffer {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new ValidationError(`Visual ${label} must be a PNG image`);
  }
  return bytes;
}

function nextVersion(artifacts: readonly { readonly type: string }[], type: string): number {
  return artifacts.filter((artifact) => artifact.type === type).length + 1;
}
