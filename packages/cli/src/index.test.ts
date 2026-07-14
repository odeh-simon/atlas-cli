import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "./index.js";

const tempRoots: string[] = [];
const gitAvailable = commandSucceeds(["--version"]);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-cli-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("cli", () => {
  it("lists the Git status command in help", async () => {
    const logs = captureLogs();

    const code = await main(["--help"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("atlas git status");
  });

  it.skipIf(!gitAvailable)("prints read-only Git repository facts", async () => {
    const repo = createRepo();
    const previousCwd = process.cwd();
    const logs = captureLogs();

    try {
      process.chdir(repo);
      const code = await main(["git", "status"]);

      expect(code).toBe(0);
      expect(logs).toContain(`Root: ${repo.replaceAll("\\", "/")}`);
      expect(logs).toContain("Branch: atlas-test");
      expect(logs.some((line) => /^HEAD: [a-f0-9]{40}$/i.test(line))).toBe(true);
      expect(logs).toContain("Dirty: no");
      expect(logs).toContain("Changed files: 0");
    } finally {
      process.chdir(previousCwd);
    }
  });
});

function captureLogs(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  return logs;
}

function createRepo(): string {
  const repo = tempRoot();
  mkdirSync(repo, { recursive: true });
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
