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
    expect(logs.join("\n")).toContain("atlas git preflight");
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

  it.skipIf(!gitAvailable)("prints passing Git preflight results", async () => {
    const repo = createRepo();
    const previousCwd = process.cwd();
    const logs = captureLogs();

    try {
      process.chdir(repo);
      const code = await main(["git", "preflight", "--base", "atlas-test", "--target", "atlas-work"]);

      expect(code).toBe(0);
      expect(logs).toContain("PASS Current branch matches base branch atlas-test");
      expect(logs).toContain("PASS Working tree is clean");
      expect(logs).toContain("PASS Target branch is available: atlas-work");
      expect(logs).toContain("Result: pass");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it.skipIf(!gitAvailable)("fails Git preflight on a dirty working tree", async () => {
    const repo = createRepo();
    writeFileSync(join(repo, "notes.txt"), "scratch\n");
    const previousCwd = process.cwd();
    const logs = captureLogs();

    try {
      process.chdir(repo);
      const code = await main(["git", "preflight", "--base", "atlas-test"]);

      expect(code).toBe(1);
      expect(logs.some((line) => /^FAIL Working tree is dirty with 1 changed file\(s\)$/.test(line))).toBe(true);
      expect(logs).toContain("Result: fail");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("lists context build in help", async () => {
    const logs = captureLogs();

    const code = await main(["--help"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("atlas context build");
    expect(logs.join("\n")).toContain("atlas figma inspect");
    expect(logs.join("\n")).toContain("atlas github inspect");
    expect(logs.join("\n")).toContain("atlas git diff-safeguards");
    expect(logs.join("\n")).toContain("atlas checks design-scan");
    expect(logs.join("\n")).toContain("atlas fix prepare");
    expect(logs.join("\n")).toContain("atlas doctor");
  });

  it("accepts pnpm-style leading argument separator", async () => {
    const logs = captureLogs();

    const code = await main(["--", "--help"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Atlas 0.0.0");
  });

  it("prints Atlas async errors without leaking stack traces", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const previousCwd = process.cwd();
    const previousAtlasHome = process.env.ATLAS_HOME;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.ATLAS_HOME = join(root, "home");

      const code = await main(["checks", "run"]);

      expect(code).toBe(4);
      expect(logs).toContain("No active session found for checks");
      expect(logs.join("\n")).not.toContain("at runBasicCheck");
    } finally {
      process.chdir(previousCwd);
      if (previousAtlasHome === undefined) {
        delete process.env.ATLAS_HOME;
      } else {
        process.env.ATLAS_HOME = previousAtlasHome;
      }
    }
  });

  it("stores credential aliases from environment variables without printing secrets", async () => {
    const root = tempRoot();
    const previousAtlasHome = process.env.ATLAS_HOME;
    const previousToken = process.env.ATLAS_TEST_FIGMA_TOKEN;
    const logs = captureLogs();

    try {
      process.env.ATLAS_HOME = join(root, "home");
      process.env.ATLAS_TEST_FIGMA_TOKEN = "figd_test_secret_token";

      const addCode = await main([
        "auth",
        "add",
        "--provider",
        "figma",
        "--alias",
        "figma.default",
        "--value-env",
        "ATLAS_TEST_FIGMA_TOKEN"
      ]);
      const listCode = await main(["auth", "list"]);

      expect(addCode).toBe(0);
      expect(listCode).toBe(0);
      expect(logs.join("\n")).toContain("figma.default figma");
      expect(logs.join("\n")).not.toContain("figd_test_secret_token");
    } finally {
      restoreEnv("ATLAS_HOME", previousAtlasHome);
      restoreEnv("ATLAS_TEST_FIGMA_TOKEN", previousToken);
    }
  });

  it("reports adapter health from configured aliases and commands", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        adapters: {
          figma: { tokenAlias: "figma.default" },
          codex: { command: "codex" },
          claudeCode: { command: "claude" }
        }
      })
    );
    const previousCwd = process.cwd();
    const previousAtlasHome = process.env.ATLAS_HOME;
    const previousToken = process.env.ATLAS_TEST_FIGMA_TOKEN;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.ATLAS_HOME = join(root, "home");
      process.env.ATLAS_TEST_FIGMA_TOKEN = "figd_test_secret_token";
      await main([
        "auth",
        "add",
        "--provider",
        "figma",
        "--alias",
        "figma.default",
        "--value-env",
        "ATLAS_TEST_FIGMA_TOKEN"
      ]);

      const code = await main(["adapters", "health"]);

      expect(code).toBe(1);
      expect(logs).toContain("figma: configured api-token-present");
      expect(logs).toContain("github: not-configured fixture");
      expect(logs).toContain("codex: configured");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("ATLAS_HOME", previousAtlasHome);
      restoreEnv("ATLAS_TEST_FIGMA_TOKEN", previousToken);
    }
  });

  it("inspects a Linear issue fixture", async () => {
    const root = tempRoot();
    const fixturePath = join(root, "linear.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({ identifier: "ENG-42", title: "Build intake", state: { name: "Todo" }, labels: ["atlas"] })
    );
    const logs = captureLogs();

    const code = await main(["linear", "inspect", fixturePath]);

    expect(code).toBe(0);
    expect(logs).toContain("Issue: ENG-42");
    expect(logs).toContain("Title: Build intake");
    expect(logs).toContain("Labels: atlas");
  });

  it("inspects a Figma URL", async () => {
    const logs = captureLogs();

    const code = await main([
      "figma",
      "inspect",
      "https://www.figma.com/design/AbCdEf123456/Product?node-id=10-20"
    ]);

    expect(code).toBe(0);
    expect(logs).toContain("Kind: design");
    expect(logs).toContain("File: AbCdEf123456");
    expect(logs).toContain("Node: 10-20");
  });

  it("inspects a GitHub URL", async () => {
    const logs = captureLogs();

    const code = await main(["github", "inspect", "https://github.com/acme/atlas/pull/12"]);

    expect(code).toBe(0);
    expect(logs).toContain("Kind: pull_request");
    expect(logs).toContain("Repository: acme/atlas");
    expect(logs).toContain("Number: 12");
  });

  it("requires explicit approval for decision records", async () => {
    const logs = captureLogs();

    const code = await main(["decisions", "record", "--kind", "decision"]);

    expect(code).toBe(2);
    expect(logs).toContain("atlas decisions record requires --yes");
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
