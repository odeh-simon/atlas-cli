import { GateFailedError } from "@sigil/domain";
import type { ArtifactRecord, SessionRecord } from "@sigil/persistence";
import { agentImplementationPackageSchema, contextContentPackSchema } from "@sigil/schemas";

import { readVerifiedArtifactText } from "./evidence.js";
import type { WorkflowGitSnapshot } from "./git-safeguards.js";
import type { SigilRuntime } from "./runtime.js";

export type ParsedImplementationPackage = ReturnType<typeof agentImplementationPackageSchema.parse>;

export function readAndValidateImplementationPackage(input: {
  readonly runtime: SigilRuntime;
  readonly session: SessionRecord;
  readonly artifacts: readonly ArtifactRecord[];
  readonly implementationPackage: ArtifactRecord;
}): ParsedImplementationPackage {
  let parsed: ParsedImplementationPackage;
  try {
    parsed = agentImplementationPackageSchema.parse(
      JSON.parse(readVerifiedArtifactText(input.runtime.paths.artifactRoot, input.implementationPackage)) as unknown
    );
  } catch (error) {
    throw new GateFailedError(
      "Legacy or invalid implementation package lacks machine-readable bindings; export a new implementation package",
      undefined,
      error
    );
  }
  if (
    parsed.schema_version < 2 ||
    parsed.context_content_pack_artifact_id === undefined ||
    parsed.context_content_pack_sha256 === undefined ||
    parsed.git_snapshot_fingerprint === undefined ||
    parsed.git_base_fingerprint === undefined ||
    parsed.git_root_path_hash === undefined
  ) {
    throw new GateFailedError(
      "Legacy implementation package lacks trusted contract/context/Git bindings; export a new implementation package"
    );
  }
  const contract = input.artifacts.find(
    (artifact) =>
      artifact.artifactId === input.session.currentContractArtifactId &&
      artifact.type === "implementation_contract" &&
      artifact.status === "approved"
  );
  if (
    contract === undefined ||
    parsed.contract_artifact_id !== contract.artifactId ||
    parsed.contract_sha256 !== contract.sha256
  ) {
    throw new GateFailedError("Implementation package is bound to a superseded contract; export a new package");
  }
  const contextPack = input.artifacts.find(
    (artifact) =>
      artifact.artifactId === parsed.context_content_pack_artifact_id &&
      artifact.type === "context_content_pack" &&
      artifact.status === "valid"
  );
  if (contextPack === undefined || contextPack.sha256 !== parsed.context_content_pack_sha256) {
    throw new GateFailedError("Implementation package context evidence is missing, stale, or invalid; rebuild context and export a new package");
  }
  const parsedContextPack = contextContentPackSchema.parse(
    JSON.parse(readVerifiedArtifactText(input.runtime.paths.artifactRoot, contextPack)) as unknown
  );
  if (parsedContextPack.context_manifest_artifact_id !== input.session.currentContextArtifactId) {
    throw new GateFailedError("Implementation package context is no longer current; rebuild context and export a new package");
  }
  return parsed;
}

export function assertImplementationGitBase(input: {
  readonly package: ParsedImplementationPackage;
  readonly git: WorkflowGitSnapshot | undefined;
  readonly requireClean: boolean;
}): WorkflowGitSnapshot {
  const git = input.git;
  if (git === undefined) {
    throw new GateFailedError("Implementation requires the Git repository recorded by the implementation package");
  }
  if (
    git.root_path_hash !== input.package.git_root_path_hash ||
    git.base_fingerprint !== input.package.git_base_fingerprint ||
    git.branch !== input.package.git_branch ||
    git.head_sha !== input.package.git_head_sha
  ) {
    throw new GateFailedError("Git branch, HEAD, or repository root changed after package export; export a new implementation package");
  }
  if (input.requireClean && (git.dirty || git.fingerprint !== input.package.git_snapshot_fingerprint)) {
    throw new GateFailedError("Implementation requires the exact clean Git base recorded by the implementation package");
  }
  return git;
}
