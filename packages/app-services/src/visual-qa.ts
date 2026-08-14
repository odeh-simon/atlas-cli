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
import { figmaVisualEvidenceSchema, visualCaptureSchema, visualComparisonSchema } from "@atlas/schemas";
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
  readonly referencePath?: string | undefined;
  readonly referenceArtifactId?: string | undefined;
  readonly actualPath?: string | undefined;
  readonly actualArtifactId?: string | undefined;
  readonly pixelThreshold?: number | undefined;
  readonly allowedDiffRatio?: number | undefined;
  readonly maxPixels?: number | undefined;
}

export interface ImportFigmaVisualEvidenceInput extends RuntimeOptions {
  readonly bytes: Uint8Array;
  readonly figmaUrl: string;
  readonly fileKey: string;
  readonly nodeId: string;
  readonly scale?: number | undefined;
  readonly source: "api" | "file";
  readonly maxBytes?: number | undefined;
}

export interface ImportFigmaVisualEvidenceResult {
  readonly sessionId: string;
  readonly evidenceArtifactId: string;
  readonly referenceArtifactId: string;
  readonly referencePath: string;
  readonly referenceSha256: string;
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

export async function importFigmaVisualEvidence(
  input: ImportFigmaVisualEvidenceInput
): Promise<ImportFigmaVisualEvidenceResult> {
  assertPng(input.bytes, "Figma reference");
  const maxBytes = input.maxBytes ?? 10_000_000;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new ValidationError("Figma evidence byte limit must be positive");
  if (input.bytes.length > maxBytes) {
    throw new ValidationError(`Figma reference exceeds the ${maxBytes} byte limit`);
  }
  const scale = input.scale ?? 1;
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 4) {
    throw new ValidationError("Figma evidence scale must be between 0.01 and 4");
  }
  const runtime = await openAtlasRuntime(input);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    if (session === undefined) throw new StateTransitionError("Figma visual evidence requires an active Atlas session");
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const now = new Date().toISOString();
    const reference = storeBinaryArtifact(runtime, {
      sessionId: session.sessionId,
      type: "visual_reference",
      contentVersion: nextVersion(artifacts, "visual_reference"),
      content: input.bytes,
      mediaType: "image/png",
      extension: ".png",
      now
    });
    const evidenceArtifactId = newId("art");
    const evidence = figmaVisualEvidenceSchema.parse({
      artifact_id: evidenceArtifactId,
      session_id: session.sessionId,
      type: "figma_visual_evidence",
      schema_version: 1,
      content_version: nextVersion(artifacts, "figma_visual_evidence"),
      created_at: now,
      producer: { type: "adapter", id: "figma" },
      sensitivity: "confidential",
      parents: [reference.artifactId],
      content_sha256: "0".repeat(64),
      metadata: { source: input.source, reference_path: reference.storageUri },
      figma_url: input.figmaUrl,
      file_key: input.fileKey,
      node_id: input.nodeId,
      scale,
      source: input.source,
      reference_artifact_id: reference.artifactId,
      reference_sha256: reference.sha256,
      retrieved_at: now
    });
    storeJsonArtifact(runtime, evidence, now);
    addArtifactDependency(runtime.db, {
      artifactId: evidenceArtifactId,
      dependsOnArtifactId: reference.artifactId,
      dependencyKind: "evidence"
    });
    appendEvent(runtime.db, {
      eventId: newId("evt"),
      sessionId: session.sessionId,
      eventType: "figma.visual_evidence_imported",
      actorType: "adapter",
      actorId: "figma",
      occurredAt: now,
      summary: "Figma visual reference imported",
      metadata: { evidenceArtifactId, referenceArtifactId: reference.artifactId, nodeId: input.nodeId }
    });
    return {
      sessionId: session.sessionId,
      evidenceArtifactId,
      referenceArtifactId: reference.artifactId,
      referencePath: reference.absolutePath,
      referenceSha256: reference.sha256
    };
  } finally {
    closeAtlasRuntime(runtime);
  }
}

export async function compareVisualEvidence(input: CompareVisualEvidenceInput): Promise<CompareVisualEvidenceResult> {
  if ((input.referencePath === undefined) === (input.referenceArtifactId === undefined)) {
    throw new ValidationError("Visual comparison requires exactly one of referencePath or referenceArtifactId");
  }
  if ((input.actualPath === undefined) === (input.actualArtifactId === undefined)) {
    throw new ValidationError("Visual comparison requires exactly one of actualPath or actualArtifactId");
  }
  const runtime = await openAtlasRuntime(input);
  try {
    const session = listSessionsForRepository(runtime.db, repoIdForPath(runtime.paths.cwd))[0];
    if (session === undefined) throw new StateTransitionError("Visual comparison requires an active Atlas session");
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    const now = new Date().toISOString();
    const reference =
      input.referenceArtifactId === undefined
        ? storeBinaryArtifact(runtime, {
            sessionId: session.sessionId,
            type: "visual_reference",
            contentVersion: nextVersion(artifacts, "visual_reference"),
            content: readPng(input.referencePath ?? "", "reference"),
            mediaType: "image/png",
            extension: ".png",
            now
          })
        : resolveVisualArtifact(runtime, session.sessionId, input.referenceArtifactId, "visual_reference");
    const referenceBytes = readFileSync(reference.absolutePath);
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
        : resolveVisualArtifact(runtime, session.sessionId, input.actualArtifactId, "visual_snapshot");
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
        reference_name: input.referenceArtifactId ?? basename(input.referencePath ?? ""),
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

function resolveVisualArtifact(
  runtime: Awaited<ReturnType<typeof openAtlasRuntime>>,
  sessionId: string,
  artifactId: string,
  type: "visual_reference" | "visual_snapshot"
): { readonly artifactId: string; readonly absolutePath: string; readonly storageUri: string; readonly sha256: string } {
  const record = getArtifactRecord(runtime.db, artifactId);
  if (
    record === undefined ||
    record.sessionId !== sessionId ||
    record.type !== type ||
    record.mediaType !== "image/png" ||
    record.status !== "valid"
  ) {
    throw new ValidationError(`Visual ${type} artifact is not available in the active session: ${artifactId}`);
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
  assertPng(bytes, `Visual ${label}`);
  return bytes;
}

function assertPng(bytes: Uint8Array, label: string): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < signature.length || !Buffer.from(bytes.subarray(0, 8)).equals(signature)) {
    throw new ValidationError(`${label} must be a PNG image`);
  }
}

function nextVersion(artifacts: readonly { readonly type: string }[], type: string): number {
  return artifacts.filter((artifact) => artifact.type === type).length + 1;
}
