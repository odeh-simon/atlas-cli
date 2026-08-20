import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError } from "@atlas/domain";
import { addArtifactDependency, createArtifactRecord, type ArtifactRecord } from "@atlas/persistence";
import { contextContentPackSchema, type ContextManifest } from "@atlas/schemas";

import { readBoundedRepositorySource } from "./evidence.js";
import type { WorkflowGitSnapshot } from "./git-safeguards.js";
import { newId, type AtlasRuntime } from "./runtime.js";

const HARD_PACK_LIMIT_BYTES = 200_000;

export function createContextContentPack(input: {
  readonly runtime: AtlasRuntime;
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
  let remaining = maxBytes;
  const sources = (input.manifest.included_sources ?? input.manifest.sources?.filter((source) => source.included) ?? []).map(
    (source) => {
      if (source.sha256 === undefined) {
        throw new GateFailedError("Included context source lacks a content hash; rebuild context", { uri: source.uri });
      }
      const resolved = readBoundedRepositorySource({
        rootPath: input.runtime.paths.cwd,
        uri: source.uri,
        expectedSha256: source.sha256,
        maxBytes: Math.max(0, remaining)
      });
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
        content: resolved.content
      };
    }
  );
  const blockingGaps = input.manifest.gaps.filter((gap) => gap.severity === "blocking").map((gap) => gap.id);
  const pack = contextContentPackSchema.parse({
    artifact_id: artifactId,
    session_id: input.sessionId,
    type: "context_content_pack",
    schema_version: 1,
    content_version: input.contentVersion,
    created_at: input.now,
    producer: { type: "atlas" },
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
    schemaVersion: 1,
    contentVersion: input.contentVersion,
    storageUri: written.storageUri,
    sha256: written.sha256,
    byteLength: written.byteLength,
    mediaType: "application/json",
    sensitivity: "confidential",
    status: blockingGaps.length === 0 ? "valid" : "rejected",
    producerType: "atlas",
    createdAt: input.now
  });
  for (const dependsOnArtifactId of pack.parents) {
    addArtifactDependency(input.runtime.db, { artifactId, dependsOnArtifactId, dependencyKind: "input" });
  }
  return record;
}
