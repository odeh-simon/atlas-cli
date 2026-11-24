import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertGitRootMatches,
  discoverGitRepository,
  preflightGitBranch,
  readGitRepositoryFacts,
  summarizeGitDiffSafeguards
} from "./index.js";

const tempRoots: string[] = [];
const gitAvailable = commandSucceeds(["--version"]);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-git-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!gitAvailable)("git repository facts", () => {
  it("reads root, branch, HEAD, and clean status without mutating the repo", () => {
    const repo = createRepo();

    const before = git(repo, ["rev-parse", "HEAD"]).trim();
    const facts = readGitRepositoryFacts({ cwd: join(repo, "src") });
    const after = git(repo, ["rev-parse", "HEAD"]).trim();

    expect(facts.rootPath).toBe(normalize(realpathSync(repo)));
    expect(facts.branch).toBe("atlas-test");
    expect(facts.headSha).toBe(before);
    expect(facts.detachedHead).toBe(false);
    expect(facts.status.isDirty).toBe(false);
    expect(facts.status.changedFileCount).toBe(0);
    expect(after).toBe(before);
  });

  it("summarizes modified, staged, and untracked files", () => {
    const repo = createRepo();
    writeFileSync(join(repo, "README.md"), "updated\n");
    git(repo, ["add", "README.md"]);
    writeFileSync(join(repo, "notes.txt"), "scratch\n");

    const facts = readGitRepositoryFacts({ cwd: repo });

    expect(facts.status.isDirty).toBe(true);
    expect(facts.status.hasStagedChanges).toBe(true);
    expect(facts.status.hasUntrackedFiles).toBe(true);
    expect(facts.status.entries.map((entry) => entry.path).sort()).toEqual(["README.md", "notes.txt"]);
  });

  it("returns undefined outside a Git work tree", () => {
    const root = tempRoot();

    expect(discoverGitRepository({ cwd: root })).toBeUndefined();
  });

  it("blocks when the discovered repo root differs from the expected root", () => {
    const repo = createRepo();
    const facts = readGitRepositoryFacts({ cwd: repo });

    expect(() => assertGitRootMatches(facts, tempRoot())).toThrow("Git repository root does not match expected root");
  });

  it("passes branch preflight for clean base branch with an available target branch", () => {
    const repo = createRepo();

    const result = preflightGitBranch({ cwd: repo, baseBranch: "atlas-test", targetBranch: "atlas-work" });

    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.checks.map((check) => [check.name, check.status])).toContainEqual(["target_branch", "pass"]);
  });

  it("fails branch preflight for dirty trees, wrong base branches, and branch collisions", () => {
    const repo = createRepo();
    git(repo, ["branch", "atlas-work"]);
    writeFileSync(join(repo, "notes.txt"), "scratch\n");

    const result = preflightGitBranch({ cwd: repo, baseBranch: "main", targetBranch: "atlas-work" });

    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.name).sort()).toEqual([
      "current_branch",
      "target_branch",
      "working_tree"
    ]);
  });

  it("can allow dirty trees during branch preflight", () => {
    const repo = createRepo();
    writeFileSync(join(repo, "notes.txt"), "scratch\n");

    const result = preflightGitBranch({ cwd: repo, baseBranch: "atlas-test", requireClean: false });

    expect(result.passed).toBe(true);
    expect(result.checks.find((check) => check.name === "working_tree")).toMatchObject({ status: "pass" });
  });

  it("summarizes reviewable text diffs", () => {
    const repo = createRepo();
    writeFileSync(join(repo, "README.md"), "hello\nworld\n");

    const result = summarizeGitDiffSafeguards({ cwd: repo });

    expect(result.reviewable).toBe(true);
    expect(result.totalFiles).toBe(1);
    expect(result.paths[0]).toMatchObject({ path: "README.md", binary: false, secretRisk: false });
  });

  it("flags secret-risk and binary diff paths", () => {
    const repo = createRepo();
    writeFileSync(join(repo, ".env"), "TOKEN=secret\n");
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2, 3]));
    git(repo, ["add", ".env", "image.bin"]);
    git(repo, ["commit", "-m", "add sensitive fixtures"]);
    writeFileSync(join(repo, ".env"), "TOKEN=changed\n");
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 9, 3]));

    const result = summarizeGitDiffSafeguards({ cwd: repo });

    expect(result.reviewable).toBe(false);
    expect(result.hasSecretRisk).toBe(true);
    expect(result.hasBinary).toBe(true);
  });

  it("marks large file counts as truncated", () => {
    const repo = createRepo();
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, ["add", "a.txt", "b.txt"]);
    git(repo, ["commit", "-m", "add diff fixtures"]);
    writeFileSync(join(repo, "a.txt"), "a changed\n");
    writeFileSync(join(repo, "b.txt"), "b changed\n");

    const result = summarizeGitDiffSafeguards({ cwd: repo, maxFiles: 1 });

    expect(result.truncated).toBe(true);
    expect(result.reviewable).toBe(false);
    expect(result.totalFiles).toBe(2);
    expect(result.paths).toHaveLength(1);
  });
});

function createRepo(): string {
  const repo = tempRoot();
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init"]);
  git(repo, ["checkout", "-b", "atlas-test"]);
  git(repo, ["config", "user.name", "Atlas Test"]);
  git(repo, ["config", "user.email", "atlas@example.test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function commandSucceeds(args: readonly string[]): boolean {
  try {
    git(process.cwd(), args);
    return true;
  } catch {
    return false;
  }
}

function normalize(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}
