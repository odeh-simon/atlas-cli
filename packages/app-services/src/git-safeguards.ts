import { createHash } from "node:crypto";

import { readGitRepositoryFacts, summarizeGitDiffSafeguards, type GitRepositoryFacts } from "@sigil/git";

export interface WorkflowGitChangedFile {
  readonly path: string;
  readonly index: string;
  readonly working_tree: string;
  readonly original_path?: string | undefined;
}

export interface WorkflowGitDiffSummary {
  readonly base_ref: string;
  readonly total_files: number;
  readonly total_line_changes: number;
  readonly has_binary: boolean;
  readonly has_secret_risk: boolean;
  readonly truncated: boolean;
  readonly reviewable: boolean;
}

export interface WorkflowGitSnapshot {
  readonly fingerprint: string;
  readonly base_fingerprint: string;
  readonly root_path_hash: string;
  readonly branch?: string | undefined;
  readonly head_sha?: string | undefined;
  readonly dirty: boolean;
  readonly changed_file_count: number;
  readonly changed_files: readonly WorkflowGitChangedFile[];
  readonly diff_summary?: WorkflowGitDiffSummary | undefined;
}

export function readWorkflowGitSnapshot(cwd: string): WorkflowGitSnapshot | undefined {
  try {
    const facts = readGitRepositoryFacts({ cwd });
    const base = {
      root_path_hash: facts.rootPathHash,
      branch: facts.branch,
      head_sha: facts.headSha
    };
    const status = {
      dirty: facts.status.isDirty,
      changed_file_count: facts.status.changedFileCount,
      changed_files: facts.status.entries.map((entry) => ({
        path: entry.path,
        index: entry.index,
        working_tree: entry.workingTree,
        ...(entry.originalPath === undefined ? {} : { original_path: entry.originalPath })
      }))
    };
    const snapshot: WorkflowGitSnapshot = {
      fingerprint: hashStable({ ...base, ...status }),
      base_fingerprint: hashStable(base),
      root_path_hash: facts.rootPathHash,
      ...(facts.branch === undefined ? {} : { branch: facts.branch }),
      ...(facts.headSha === undefined ? {} : { head_sha: facts.headSha }),
      dirty: facts.status.isDirty,
      changed_file_count: facts.status.changedFileCount,
      changed_files: status.changed_files,
      ...diffSummaryForSnapshot(cwd, facts)
    };
    return snapshot;
  } catch {
    return undefined;
  }
}

export function hasStaleGitFingerprint(input: {
  readonly recorded: string | undefined;
  readonly current: string | undefined;
}): boolean {
  return input.recorded !== undefined && input.current !== undefined && input.recorded !== input.current;
}

function diffSummaryForSnapshot(cwd: string, facts: GitRepositoryFacts): { readonly diff_summary?: WorkflowGitDiffSummary } {
  if (facts.headSha === undefined) return {};
  try {
    const diff = summarizeGitDiffSafeguards({ cwd, baseRef: "HEAD" });
    return {
      diff_summary: {
        base_ref: diff.baseRef,
        total_files: diff.totalFiles,
        total_line_changes: diff.totalLineChanges,
        has_binary: diff.hasBinary,
        has_secret_risk: diff.hasSecretRisk,
        truncated: diff.truncated,
        reviewable: diff.reviewable
      }
    };
  } catch {
    return {};
  }
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortObject(value)), "utf8").digest("hex");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortObject((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
