import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeImmutableArtifactContent } from "@atlas/artifacts";
import { GateFailedError } from "@atlas/domain";
import { addArtifactDependency, createArtifactRecord, type ArtifactRecord } from "@atlas/persistence";
import { redactSecretText } from "@atlas/security";
import { implementationDiffSchema } from "@atlas/schemas";

import { isSecretRiskPath } from "./evidence.js";
import type { WorkflowGitSnapshot } from "./git-safeguards.js";
import { newId, type AtlasRuntime } from "./runtime.js";

const MAX_PATCH_BYTES = 500_000;

export function captureImplementationDiff(input: {
  readonly runtime: AtlasRuntime;
  readonly sessionId: string;
  readonly runId: string;
  readonly before: WorkflowGitSnapshot | undefined;
  readonly after: WorkflowGitSnapshot | undefined;
  readonly parentArtifactIds: readonly string[];
  readonly contentVersion: number;
  readonly now: string;
  readonly requireCleanBase?: boolean | undefined;
}): ArtifactRecord {
  if (input.before === undefined || input.after === undefined) {
    throw new GateFailedError("Implementation diff capture requires a Git repository; initialize Git and rerun implementation");
  }
  if (input.requireCleanBase === true && input.before.dirty) {
    throw new GateFailedError("Implementation agent requires a clean Git base so its exact diff can be isolated");
  }
  if (
    input.before.root_path_hash !== input.after.root_path_hash ||
    input.before.branch !== input.after.branch ||
    input.before.head_sha !== input.after.head_sha ||
    input.before.base_fingerprint !== input.after.base_fingerprint
  ) {
    throw new GateFailedError("Implementation changed the bound Git repository, branch, or HEAD; commits and branch changes are not permitted");
  }
  const secretPaths = input.after.changed_files.map((entry) => entry.path).filter(isSecretRiskPath);
  const binaryPaths = input.after.changed_files
    .map((entry) => entry.path)
    .filter((path) => !secretPaths.includes(path) && fileLooksBinary(input.runtime.paths.cwd, path));
  const hasSecretRisk = secretPaths.length > 0 || input.after.diff_summary?.has_secret_risk === true;
  const hasBinary = binaryPaths.length > 0 || input.after.diff_summary?.has_binary === true;
  let patch = hasSecretRisk ? "[ATLAS PATCH OMITTED: secret-sensitive path detected]\n" : readTrackedPatch(input.runtime.paths.cwd);
  if (!hasSecretRisk) {
    patch += readUntrackedPatches(input.runtime.paths.cwd, input.after.changed_files.map((entry) => entry.path), binaryPaths);
    patch = redactSecretText(patch);
  }
  const patchBytes = Buffer.from(patch, "utf8");
  const truncated = patchBytes.byteLength > MAX_PATCH_BYTES;
  if (truncated) patch = `${patchBytes.subarray(0, MAX_PATCH_BYTES).toString("utf8")}\n[ATLAS PATCH TRUNCATED]\n`;
  const finalBytes = Buffer.from(patch, "utf8");
  const patchSha256 = createHash("sha256").update(finalBytes).digest("hex");
  const artifactId = newId("art");
  const artifact = implementationDiffSchema.parse({
    artifact_id: artifactId,
    session_id: input.sessionId,
    type: "implementation_diff",
    schema_version: 1,
    content_version: input.contentVersion,
    created_at: input.now,
    producer: { type: "atlas" },
    sensitivity: hasSecretRisk ? "secret-redacted" : "confidential",
    parents: [...input.parentArtifactIds],
    content_sha256: "0".repeat(64),
    metadata: {},
    run_id: input.runId,
    base_fingerprint: input.before.fingerprint,
    result_fingerprint: input.after.fingerprint,
    ...(input.before.head_sha === undefined ? {} : { base_head_sha: input.before.head_sha }),
    ...(input.after.head_sha === undefined ? {} : { result_head_sha: input.after.head_sha }),
    patch_sha256: patchSha256,
    patch,
    byte_length: finalBytes.byteLength,
    truncated,
    has_binary: hasBinary,
    has_secret_risk: hasSecretRisk,
    reviewable: !hasSecretRisk && !hasBinary && !truncated,
    omitted_paths: [...secretPaths, ...binaryPaths],
    changed_files: input.after.changed_files.map((entry) => entry.path)
  });
  const written = writeImmutableArtifactContent({
    rootDir: input.runtime.paths.artifactRoot,
    sessionId: input.sessionId,
    artifactId,
    type: "implementation_diff",
    contentVersion: input.contentVersion,
    mediaType: "application/json",
    content: `${JSON.stringify(artifact, null, 2)}\n`
  });
  const record = createArtifactRecord(input.runtime.db, {
    artifactId,
    sessionId: input.sessionId,
    type: "implementation_diff",
    schemaVersion: 1,
    contentVersion: input.contentVersion,
    storageUri: written.storageUri,
    sha256: written.sha256,
    byteLength: written.byteLength,
    mediaType: "application/json",
    sensitivity: hasSecretRisk ? "secret-redacted" : "confidential",
    status: artifact.reviewable ? "valid" : "rejected",
    producerType: "atlas",
    createdAt: input.now
  });
  for (const dependsOnArtifactId of input.parentArtifactIds) {
    addArtifactDependency(input.runtime.db, { artifactId, dependsOnArtifactId, dependencyKind: "parent" });
  }
  if (!artifact.reviewable) {
    throw new GateFailedError("Implementation diff is not safely reviewable", {
      hasBinary,
      hasSecretRisk,
      truncated,
      omittedPaths: artifact.omitted_paths,
      repair: "Remove secret/binary changes or split the task, then rerun implementation"
    });
  }
  return record;
}

function readTrackedPatch(cwd: string): string {
  return execFileSync("git", ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_PATCH_BYTES * 2
  });
}

function readUntrackedPatches(cwd: string, changedFiles: readonly string[], binaryPaths: readonly string[]): string {
  const untracked = new Set(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
  );
  return changedFiles
    .filter((path) => untracked.has(path) && !binaryPaths.includes(path) && !isSecretRiskPath(path))
    .map((path) => {
      const content = readFileSync(join(cwd, path), "utf8");
      const lines = content.split(/\r?\n/).map((line) => `+${line}`).join("\n");
      return `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${content.split(/\r?\n/).length} @@\n${lines}\n`;
    })
    .join("");
}

function fileLooksBinary(cwd: string, path: string): boolean {
  try {
    return readFileSync(join(cwd, path)).subarray(0, 8_192).includes(0);
  } catch {
    return false;
  }
}
