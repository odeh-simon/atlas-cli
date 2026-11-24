import { GitSafetyError } from "@sigil/domain";
import { readGitRepositoryFacts } from "@sigil/git";
import { stableHash } from "@sigil/domain";

export interface EvidenceGitChangedFile {
  readonly path: string;
  readonly index: string;
  readonly workingTree: string;
  readonly originalPath?: string | undefined;
}

export interface EvidenceGitFacts {
  readonly rootPath: string;
  readonly branch: string | undefined;
  readonly headSha: string | undefined;
  readonly dirty: boolean;
  readonly fingerprint: string;
  readonly baseFingerprint: string;
  readonly changedFiles: readonly EvidenceGitChangedFile[];
  readonly untrackedCount: number;
}

export function readEvidenceGitFacts(rootPath: string): EvidenceGitFacts {
  const facts = readGitRepositoryFacts({ cwd: rootPath });
  const changedFiles = facts.status.entries.map((entry) => ({
    path: entry.path,
    index: entry.index,
    working_tree: entry.workingTree,
    ...(entry.originalPath === undefined ? {} : { original_path: entry.originalPath })
  }));
  const base = {
    root_path_hash: facts.rootPathHash,
    branch: facts.branch,
    head_sha: facts.headSha
  };
  const status = {
    dirty: facts.status.isDirty,
    changed_file_count: facts.status.changedFileCount,
    changed_files: changedFiles
  };

  return {
    rootPath: facts.rootPath,
    branch: facts.branch,
    headSha: facts.headSha,
    dirty: facts.status.isDirty,
    fingerprint: stableHash({ ...base, ...status }),
    baseFingerprint: stableHash(base),
    changedFiles: changedFiles.map((file) => ({
      path: file.path,
      index: file.index,
      workingTree: file.working_tree,
      ...(file.original_path === undefined ? {} : { originalPath: file.original_path })
    })),
    untrackedCount: facts.status.entries.filter(
      (entry) => entry.index === "?" || entry.workingTree === "?"
    ).length
  };
}

export function tryReadEvidenceGitFacts(rootPath: string): EvidenceGitFacts | undefined {
  try {
    return readEvidenceGitFacts(rootPath);
  } catch (error) {
    if (error instanceof GitSafetyError) {
      return undefined;
    }
    throw error;
  }
}
