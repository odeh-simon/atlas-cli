import { writeImmutableArtifactContent } from "@sigil/artifacts";
import { GateFailedError } from "@sigil/domain";
import { addArtifactDependency, createArtifactRecord, type ArtifactRecord } from "@sigil/persistence";
import { contextContentPackSchema, type ContextManifest } from "@sigil/schemas";
import { readContextDiscoveryConfig } from "@sigil/context-discovery";
import { redactSecretText } from "@sigil/security";

import { readBoundedRepositorySource, readSafeRepositorySource } from "./evidence.js";
import type { WorkflowGitSnapshot } from "./git-safeguards.js";
import { newId, type SigilRuntime } from "./runtime.js";

const HARD_PACK_LIMIT_BYTES = 200_000;

export function createContextContentPack(input: {
  readonly runtime: SigilRuntime;
  readonly sessionId: string;
  readonly taskBrief: ArtifactRecord;
  readonly contextManifest: ArtifactRecord;
  readonly manifest: ContextManifest;
  readonly git: WorkflowGitSnapshot | undefined;
  readonly now: string;
  readonly contentVersion: number;
}): ArtifactRecord {
  const artifactId = newId("art");
  const maxBytes = Math.min(HARD_PACK_LIMIT_BYTES, input.manifest.budgets.max_bytes);
  if (input.manifest.schema_version >= 3) assertContextManifestFresh({
    rootPath: input.runtime.paths.cwd,
    manifest: input.manifest,
    taskBriefSha256: input.taskBrief.sha256,
    git: input.git
  });
  let remaining = maxBytes;
  const sources = (input.manifest.included_sources ?? input.manifest.sources?.filter((source) => source.included) ?? []).map(
    (source) => {
      if (source.sha256 === undefined) {
        throw new GateFailedError("Included context source lacks a content hash; rebuild context", { uri: source.uri });
      }
      const instruction = input.manifest.instruction_chain?.find((item) => item.uri === source.uri);
      const sourceBudget = instruction === undefined ? remaining : Math.min(remaining, instruction.included_bytes);
      const resolved = readBoundedRepositorySource({
        rootPath: input.runtime.paths.cwd,
        uri: source.uri,
        expectedSha256: source.sha256,
        maxBytes: Math.max(0, sourceBudget)
      });
      if ((source.required === true || source.pinned === true) && (resolved.truncated || resolved.byteLength > sourceBudget)) {
        throw new GateFailedError("Required context evidence cannot fit the content-pack budget; increase the budget or narrow required sources", {
          uri: source.uri,
          byteLength: resolved.byteLength,
          availableBytes: sourceBudget
        });
      }
      remaining -= resolved.includedBytes;
      return {
        uri: source.uri,
        kind: source.kind,
        reason: source.reason,
        sha256: source.sha256,
        byte_length: resolved.byteLength,
        included_bytes: resolved.includedBytes,
        truncated: resolved.truncated,
        redacted: resolved.redacted,
        content: resolved.content,
        ...(source.category === undefined ? {} : { category: source.category }),
        ...(source.required === undefined ? {} : { required: source.required }),
        ...(source.pinned === undefined ? {} : { pinned: source.pinned }),
        ...(source.selection_reasons === undefined ? {} : { selection_reasons: source.selection_reasons })
      };
    }
  );
  const blockingGaps = input.manifest.gaps.filter((gap) => gap.severity === "blocking").map((gap) => gap.id);
  const pack = contextContentPackSchema.parse({
    artifact_id: artifactId,
    session_id: input.sessionId,
    type: "context_content_pack",
    schema_version: input.manifest.schema_version >= 3 ? 3 : 1,
    content_version: input.contentVersion,
    created_at: input.now,
    producer: { type: "sigil" },
    sensitivity: "confidential",
    parents: [input.taskBrief.artifactId, input.contextManifest.artifactId],
    content_sha256: "0".repeat(64),
    metadata: {},
    task_artifact_id: input.taskBrief.artifactId,
    task_artifact_sha256: input.taskBrief.sha256,
    context_manifest_artifact_id: input.contextManifest.artifactId,
    context_manifest_sha256: input.contextManifest.sha256,
    ...(input.git === undefined ? {} : { git_base_fingerprint: input.git.base_fingerprint, git_head_sha: input.git.head_sha }),
    max_bytes: maxBytes,
    used_bytes: maxBytes - remaining,
    truncated: sources.some((source) => source.truncated),
    blocking_gaps: blockingGaps,
    manifest_schema_version: input.manifest.schema_version,
    semantic_complete: input.manifest.schema_version >= 3 && input.manifest.semantic_complete === true,
    ...(input.manifest.repository_snapshot === undefined ? {} : {
      repository_snapshot: input.manifest.repository_snapshot,
      discovery_config_sha256: input.manifest.repository_snapshot.discovery_config_sha256
    }),
    ...(input.manifest.instruction_chain === undefined ? {} : { instruction_chain: input.manifest.instruction_chain }),
    ...(input.manifest.symbols === undefined ? {} : { symbols: input.manifest.symbols }),
    ...(input.manifest.relations === undefined ? {} : { relations: input.manifest.relations }),
    ...(input.manifest.evidence_fragments === undefined ? {} : { evidence_fragments: input.manifest.evidence_fragments }),
    sources
  });
  const written = writeImmutableArtifactContent({
    rootDir: input.runtime.paths.artifactRoot,
    sessionId: input.sessionId,
    artifactId,
    type: "context_content_pack",
    contentVersion: input.contentVersion,
    mediaType: "application/json",
    content: `${JSON.stringify(pack, null, 2)}\n`
  });
  const record = createArtifactRecord(input.runtime.db, {
    artifactId,
    sessionId: input.sessionId,
    type: "context_content_pack",
    schemaVersion: input.manifest.schema_version >= 3 ? 3 : 1,
    contentVersion: input.contentVersion,
    storageUri: written.storageUri,
    sha256: written.sha256,
    byteLength: written.byteLength,
    mediaType: "application/json",
    sensitivity: "confidential",
    status: blockingGaps.length === 0 ? "valid" : "rejected",
    producerType: "sigil",
    createdAt: input.now
  });
  for (const dependsOnArtifactId of pack.parents) {
    addArtifactDependency(input.runtime.db, { artifactId, dependsOnArtifactId, dependencyKind: "input" });
  }
  return record;
}

export function assertContextManifestFresh(input: {
  readonly rootPath: string;
  readonly manifest: ContextManifest;
  readonly taskBriefSha256: string;
  readonly git: WorkflowGitSnapshot | undefined;
}): void {
  if (
    input.manifest.schema_version < 3 ||
    input.manifest.semantic_complete !== true ||
    input.manifest.repository_snapshot === undefined ||
    input.manifest.discovery_algorithm?.version !== "3.0.0" ||
    input.manifest.invalidation === undefined
  ) {
    throw new GateFailedError("Legacy context lacks manifest v3 semantic completeness; rerun sigil context build");
  }
  const snapshot = input.manifest.repository_snapshot;
  const currentConfig = readContextDiscoveryConfig(input.rootPath);
  if (currentConfig.sha256 !== snapshot.discovery_config_sha256) {
    throw new GateFailedError("Context configuration changed after discovery; rebuild context");
  }
  if (input.taskBriefSha256 !== snapshot.task_brief_sha256) {
    throw new GateFailedError("Task brief changed after discovery; rebuild context");
  }
  const snapshotHasGit = snapshot.root_path_hash !== undefined || snapshot.git_base_fingerprint !== undefined || snapshot.git_head_sha !== undefined;
  if (snapshotHasGit && (
    input.git === undefined ||
    input.git.root_path_hash !== snapshot.root_path_hash ||
    input.git.base_fingerprint !== snapshot.git_base_fingerprint ||
    input.git.head_sha !== snapshot.git_head_sha
  )) {
    throw new GateFailedError("Repository root, branch, or HEAD changed after context discovery; rebuild context");
  }
  const instructionUris = new Set((input.manifest.instruction_chain ?? []).map((instruction) => instruction.uri));
  for (const instruction of input.manifest.instruction_chain ?? []) {
    const current = readSafeRepositorySource({ rootPath: input.rootPath, uri: instruction.uri });
    if (current.sha256 !== instruction.sha256) {
      throw new GateFailedError("Repository instructions changed after discovery; rebuild context", { uri: instruction.uri });
    }
  }
  for (const source of input.manifest.included_sources ?? []) {
    if (instructionUris.has(source.uri)) continue;
    if (source.sha256 === undefined) throw new GateFailedError("Selected context source lacks a hash; rebuild context", { uri: source.uri });
    const current = readSafeRepositorySource({ rootPath: input.rootPath, uri: source.uri });
    if (current.sha256 !== source.sha256) {
      throw new GateFailedError("Context source changed after discovery; rebuild context", { uri: source.uri });
    }
  }
  verifyEvidenceFragments(input.rootPath, input.manifest);
}

function verifyEvidenceFragments(rootPath: string, manifest: ContextManifest): void {
  const byUri = new Map((manifest.included_sources ?? []).map((source) => [source.uri, source]));
  const contentCache = new Map<string, readonly string[]>();
  for (const fragment of manifest.evidence_fragments ?? []) {
    const source = byUri.get(fragment.source_uri);
    if (source?.sha256 === undefined || source.sha256 !== fragment.source_sha256) {
      throw new GateFailedError("Context evidence fragment is not bound to the selected source hash; rebuild context", {
        fragmentId: fragment.id,
        uri: fragment.source_uri
      });
    }
    let lines = contentCache.get(fragment.source_uri);
    if (lines === undefined) {
      const safe = readSafeRepositorySource({ rootPath, uri: fragment.source_uri });
      if (safe.sha256 !== fragment.source_sha256) {
        throw new GateFailedError("Context source changed after fragment indexing; rebuild context", { uri: fragment.source_uri });
      }
      lines = safe.bytes.toString("utf8").split(/\r?\n/);
      contentCache.set(fragment.source_uri, lines);
    }
    if (fragment.line_start < 1 || fragment.line_end < fragment.line_start || fragment.line_end > lines.length) {
      throw new GateFailedError("Context evidence fragment has an unverifiable source line range; rebuild context", {
        fragmentId: fragment.id,
        uri: fragment.source_uri
      });
    }
    const exactRange = redactSecretText(lines.slice(fragment.line_start - 1, fragment.line_end).join("\n"));
    if (fragment.classification === "fact" && !exactRange.startsWith(fragment.excerpt)) {
      throw new GateFailedError("Context evidence excerpt no longer matches its cited source range; rebuild context", {
        fragmentId: fragment.id,
        uri: fragment.source_uri
      });
    }
  }
}
