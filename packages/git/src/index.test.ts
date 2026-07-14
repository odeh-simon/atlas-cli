import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertGitRootMatches, discoverGitRepository, readGitRepositoryFacts } from "./index.js";

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

    expect(facts.rootPath).toBe(normalize(repo));
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
