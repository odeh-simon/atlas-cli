import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { GitSafetyError } from "@sigil/domain";

export const gitPackage = "@sigil/git";

export interface GitAdapterOptions {
  readonly cwd?: string | undefined;
  readonly gitPath?: string | undefined;
}

export interface GitRepositoryLocation {
  readonly rootPath: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly worktreePath: string;
}

export interface GitStatusEntry {
  readonly index: string;
  readonly workingTree: string;
  readonly path: string;
  readonly originalPath?: string | undefined;
}

export interface GitStatusSummary {
  readonly entries: readonly GitStatusEntry[];
  readonly isDirty: boolean;
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly changedFileCount: number;
}

export interface GitRepositoryFacts extends GitRepositoryLocation {
  readonly branch: string | undefined;
  readonly headSha: string | undefined;
  readonly detachedHead: boolean;
  readonly status: GitStatusSummary;
  readonly rootPathHash: string;
}

export type GitPreflightCheckName = "repository" | "head" | "current_branch" | "working_tree" | "target_branch";
export type GitPreflightCheckStatus = "pass" | "fail" | "skip";

export interface GitPreflightCheck {
  readonly name: GitPreflightCheckName;
  readonly status: GitPreflightCheckStatus;
  readonly summary: string;
}

export interface GitBranchPreflightOptions extends GitAdapterOptions {
  readonly expectedRootPath?: string | undefined;
  readonly baseBranch?: string | undefined;
  readonly targetBranch?: string | undefined;
  readonly requireClean?: boolean | undefined;
}

export interface GitBranchPreflightResult {
  readonly passed: boolean;
  readonly facts: GitRepositoryFacts;
  readonly checks: readonly GitPreflightCheck[];
  readonly failures: readonly GitPreflightCheck[];
}

export interface GitDiffSafeguardOptions extends GitAdapterOptions {
  readonly baseRef?: string | undefined;
  readonly maxFiles?: number | undefined;
  readonly maxLineChanges?: number | undefined;
}

export interface GitDiffPathSummary {
  readonly path: string;
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly binary: boolean;
  readonly secretRisk: boolean;
}

export interface GitDiffSafeguardResult {
  readonly baseRef: string;
  readonly paths: readonly GitDiffPathSummary[];
  readonly totalFiles: number;
  readonly totalLineChanges: number;
  readonly hasBinary: boolean;
  readonly hasSecretRisk: boolean;
  readonly truncated: boolean;
  readonly reviewable: boolean;
}

export function discoverGitRepository(options: GitAdapterOptions = {}): GitRepositoryLocation | undefined {
  const cwd = resolve(options.cwd ?? process.cwd());
  const gitPath = options.gitPath ?? "git";
  const inside = runGit({ gitPath, cwd, args: ["rev-parse", "--is-inside-work-tree"], allowFailure: true });
  if (inside.trim() !== "true") {
    return undefined;
  }

  return {
    rootPath: normalizeGitPath(runRequiredGit({ gitPath, cwd, args: ["rev-parse", "--show-toplevel"] })),
    gitDir: normalizeGitPath(runRequiredGit({ gitPath, cwd, args: ["rev-parse", "--absolute-git-dir"] })),
    commonDir: normalizeGitPath(runRequiredGit({ gitPath, cwd, args: ["rev-parse", "--git-common-dir"] })),
    worktreePath: cwd
  };
}

export function readGitRepositoryFacts(options: GitAdapterOptions = {}): GitRepositoryFacts {
  const cwd = resolve(options.cwd ?? process.cwd());
  const gitPath = options.gitPath ?? "git";
  const location = discoverGitRepository({ cwd, gitPath });
  if (location === undefined) {
    throw new GitSafetyError("Path is not inside a Git work tree", { cwd });
  }

  const branch = readBranch({ gitPath, cwd });
  const headSha = readHeadSha({ gitPath, cwd });
  const status = readStatus({ gitPath, cwd });

  return {
    ...location,
    branch,
    headSha,
    detachedHead: branch === undefined && headSha !== undefined,
    status,
    rootPathHash: sha256(location.rootPath)
  };
}

export function assertGitRootMatches(facts: GitRepositoryFacts, expectedRootPath: string): void {
  const expected = normalizeGitPath(expectedRootPath);
  if (facts.rootPath !== expected) {
    throw new GitSafetyError("Git repository root does not match expected root", {
      actualRootPath: facts.rootPath,
      expectedRootPath: expected
    });
  }
}

export function preflightGitBranch(options: GitBranchPreflightOptions = {}): GitBranchPreflightResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const gitPath = options.gitPath ?? "git";
  const facts = readGitRepositoryFacts({ cwd, gitPath });
  const checks: GitPreflightCheck[] = [];

  if (options.expectedRootPath === undefined) {
    checks.push({ name: "repository", status: "pass", summary: `Repository root detected: ${facts.rootPath}` });
  } else {
    const expectedRootPath = normalizeGitPath(options.expectedRootPath);
    checks.push(
      facts.rootPath === expectedRootPath
        ? { name: "repository", status: "pass", summary: "Repository root matches expected root" }
        : {
            name: "repository",
            status: "fail",
            summary: `Repository root mismatch: expected ${expectedRootPath}, found ${facts.rootPath}`
          }
    );
  }

  checks.push(
    facts.headSha === undefined
      ? { name: "head", status: "fail", summary: "HEAD is unavailable" }
      : { name: "head", status: "pass", summary: `HEAD is ${facts.headSha}` }
  );

  if (facts.detachedHead || facts.branch === undefined) {
    checks.push({ name: "current_branch", status: "fail", summary: "Repository is in detached HEAD state" });
  } else if (options.baseBranch === undefined) {
    checks.push({ name: "current_branch", status: "pass", summary: `Current branch is ${facts.branch}` });
  } else {
    checks.push(
      facts.branch === options.baseBranch
        ? { name: "current_branch", status: "pass", summary: `Current branch matches base branch ${options.baseBranch}` }
        : {
            name: "current_branch",
            status: "fail",
            summary: `Current branch ${facts.branch} does not match base branch ${options.baseBranch}`
          }
    );
  }

  const requireClean = options.requireClean ?? true;
  if (!requireClean) {
    checks.push({
      name: "working_tree",
      status: "pass",
      summary: facts.status.isDirty
        ? `Working tree has ${facts.status.changedFileCount} changed file(s), allowed by --allow-dirty`
        : "Working tree is clean"
    });
  } else {
    checks.push(
      facts.status.isDirty
        ? {
            name: "working_tree",
            status: "fail",
            summary: `Working tree is dirty with ${facts.status.changedFileCount} changed file(s)`
          }
        : { name: "working_tree", status: "pass", summary: "Working tree is clean" }
    );
  }

  if (options.targetBranch === undefined) {
    checks.push({ name: "target_branch", status: "skip", summary: "No target branch requested" });
  } else if (!isValidBranchName({ gitPath, cwd, branch: options.targetBranch })) {
    checks.push({ name: "target_branch", status: "fail", summary: `Invalid target branch name: ${options.targetBranch}` });
  } else if (branchExists({ gitPath, cwd, branch: options.targetBranch })) {
    checks.push({ name: "target_branch", status: "fail", summary: `Target branch already exists: ${options.targetBranch}` });
  } else {
    checks.push({ name: "target_branch", status: "pass", summary: `Target branch is available: ${options.targetBranch}` });
  }

  const failures = checks.filter((check) => check.status === "fail");
  return { passed: failures.length === 0, facts, checks, failures };
}

export function summarizeGitDiffSafeguards(options: GitDiffSafeguardOptions = {}): GitDiffSafeguardResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const gitPath = options.gitPath ?? "git";
  const baseRef = options.baseRef ?? "HEAD";
  const maxFiles = options.maxFiles ?? 100;
  const maxLineChanges = options.maxLineChanges ?? 10_000;
  const output = runRequiredGit({
    gitPath,
    cwd,
    args: ["diff", "--numstat", baseRef, "--"]
  });
  const allPaths = parseNumstat(output);
  const paths = allPaths.slice(0, maxFiles);
  const totalLineChanges = paths.reduce((sum, path) => sum + (path.additions ?? 0) + (path.deletions ?? 0), 0);
  const hasBinary = paths.some((path) => path.binary);
  const hasSecretRisk = paths.some((path) => path.secretRisk);
  const truncated = allPaths.length > maxFiles || totalLineChanges > maxLineChanges;

  return {
    baseRef,
    paths,
    totalFiles: allPaths.length,
    totalLineChanges,
    hasBinary,
    hasSecretRisk,
    truncated,
    reviewable: !hasBinary && !hasSecretRisk && !truncated
  };
}

function readBranch(input: { readonly gitPath: string; readonly cwd: string }): string | undefined {
  const branch = runGit({
    ...input,
    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    allowFailure: true
  }).trim();
  return branch.length === 0 ? undefined : branch;
}

function readHeadSha(input: { readonly gitPath: string; readonly cwd: string }): string | undefined {
  const head = runGit({ ...input, args: ["rev-parse", "--verify", "HEAD"], allowFailure: true }).trim();
  return /^[a-f0-9]{40}$/i.test(head) ? head : undefined;
}

function readStatus(input: { readonly gitPath: string; readonly cwd: string }): GitStatusSummary {
  const output = runRequiredGit({
    ...input,
    args: ["status", "--porcelain=v1", "-z"]
  });
  const entries = parsePorcelainStatus(output);
  return {
    entries,
    isDirty: entries.length > 0,
    hasStagedChanges: entries.some((entry) => entry.index !== " " && entry.index !== "?"),
    hasUnstagedChanges: entries.some((entry) => entry.workingTree !== " " && entry.workingTree !== "?"),
    hasUntrackedFiles: entries.some((entry) => entry.index === "?" && entry.workingTree === "?"),
    changedFileCount: entries.length
  };
}

function parsePorcelainStatus(output: string): GitStatusEntry[] {
  const records = output.split("\0").filter((record) => record.length > 0);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const entry: GitStatusEntry = {
      index: status[0] ?? " ",
      workingTree: status[1] ?? " ",
      path
    };
    if ((entry.index === "R" || entry.index === "C") && records[index + 1] !== undefined) {
      entries.push({ ...entry, originalPath: records[index + 1] });
      index += 1;
    } else {
      entries.push(entry);
    }
  }
  return entries;
}

function parseNumstat(output: string): GitDiffPathSummary[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [additionsRaw, deletionsRaw, pathRaw] = line.split("\t");
      const binary = additionsRaw === "-" || deletionsRaw === "-";
      const path = pathRaw ?? "";
      return {
        path,
        additions: binary ? undefined : Number(additionsRaw),
        deletions: binary ? undefined : Number(deletionsRaw),
        binary,
        secretRisk: isSecretRiskPath(path)
      };
    });
}

function isSecretRiskPath(path: string): boolean {
  return /(^|[/\\])(\.env|\.npmrc|\.pypirc|id_rsa|id_dsa|id_ed25519|credentials|secrets?)(\.|$|[/\\])/i.test(path);
}

function runRequiredGit(input: {
  readonly gitPath: string;
  readonly cwd: string;
  readonly args: readonly string[];
}): string {
  return runGit({ ...input, allowFailure: false });
}

function runGit(input: {
  readonly gitPath: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly allowFailure: boolean;
}): string {
  try {
    return execFileSync(input.gitPath, input.args, {
      cwd: input.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (input.allowFailure) {
      return "";
    }

    throw new GitSafetyError("Git command failed", {
      cwd: input.cwd,
      args: input.args,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function branchExists(input: { readonly gitPath: string; readonly cwd: string; readonly branch: string }): boolean {
  return gitCommandSucceeds({
    gitPath: input.gitPath,
    cwd: input.cwd,
    args: ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`]
  });
}

function isValidBranchName(input: { readonly gitPath: string; readonly cwd: string; readonly branch: string }): boolean {
  return gitCommandSucceeds({
    gitPath: input.gitPath,
    cwd: input.cwd,
    args: ["check-ref-format", "--branch", input.branch]
  });
}

function gitCommandSucceeds(input: {
  readonly gitPath: string;
  readonly cwd: string;
  readonly args: readonly string[];
}): boolean {
  try {
    execFileSync(input.gitPath, input.args, {
      cwd: input.cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeGitPath(path: string): string {
  const lexical = resolve(path.trim());
  // Git reports real paths, so resolve symlinks (such as macOS /var -> /private/var) before comparing.
  let real = lexical;
  try {
    real = realpathSync(lexical);
  } catch {
    // Path does not exist yet; keep the lexical form.
  }
  return real.replaceAll("\\", "/");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
