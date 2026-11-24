import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";

import { main } from "./index.js";

const tempRoots: string[] = [];
const gitAvailable = commandSucceeds(["--version"]);

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-cli-"));
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
    expect(logs.join("\n")).toContain("sigil git status");
    expect(logs.join("\n")).toContain("sigil git preflight");
  });

  it.skipIf(!gitAvailable)("prints read-only Git repository facts", async () => {
    const repo = createRepo();
    const previousCwd = process.cwd();
    const logs = captureLogs();

    try {
      process.chdir(repo);
      const code = await main(["git", "status"]);

      expect(code).toBe(0);
      expect(logs).toContain(`Root: ${realpathSync(repo).replaceAll("\\", "/")}`);
      expect(logs).toContain("Branch: sigil-test");
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
      const code = await main(["git", "preflight", "--base", "sigil-test", "--target", "sigil-work"]);

      expect(code).toBe(0);
      expect(logs).toContain("PASS Current branch matches base branch sigil-test");
      expect(logs).toContain("PASS Working tree is clean");
      expect(logs).toContain("PASS Target branch is available: sigil-work");
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
      const code = await main(["git", "preflight", "--base", "sigil-test"]);

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
    expect(logs.join("\n")).toContain("sigil context build");
    expect(logs.join("\n")).toContain("sigil context inspect");
    expect(logs.join("\n")).toContain("sigil context summarize");
    expect(logs.join("\n")).toContain("sigil figma inspect");
    expect(logs.join("\n")).toContain("sigil github inspect");
    expect(logs.join("\n")).toContain("sigil git diff-safeguards");
    expect(logs.join("\n")).toContain("sigil checks design-scan");
    expect(logs.join("\n")).toContain("sigil fix prepare");
    expect(logs.join("\n")).toContain("sigil doctor");
    expect(logs.join("\n")).toContain("sigil artifacts show");
    expect(logs.join("\n")).toContain("sigil ai providers health");
    expect(logs.join("\n")).toContain("sigil visual capture");
    expect(logs.join("\n")).toContain("sigil visual compare");
    expect(logs.join("\n")).toContain("sigil visual review");
    expect(logs.join("\n")).toContain("sigil figma evidence");
  });

  it("requires a URL for visual capture", async () => {
    const logs = captureLogs();

    const code = await main(["visual", "capture"]);

    expect(code).toBe(2);
    expect(logs).toContain("sigil visual capture requires --url <url>");
  });

  it("compares visual evidence and exposes the binary diff path", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const referencePath = join(root, "reference.png");
    const actualPath = join(root, "actual.png");
    mkdirSync(repo, { recursive: true });
    const image = new PNG({ width: 2, height: 2 });
    image.data.fill(255);
    const png = PNG.sync.write(image);
    writeFileSync(referencePath, png);
    writeFileSync(actualPath, png);
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      await main(["start", "--manual", "--title", "Visual QA", "--objective", "Compare screenshots"]);
      logs.length = 0;

      const code = await main([
        "visual",
        "compare",
        "--reference",
        referencePath,
        "--actual",
        actualPath,
        "--allowed-ratio",
        "0"
      ]);
      const diffId = logs.find((line) => line.startsWith("Diff: "))?.replace("Diff: ", "");

      expect(code).toBe(0);
      expect(logs).toContain("Status: passed");
      expect(diffId).toMatch(/^art_/);
      logs.length = 0;
      expect(await main(["artifacts", "show", diffId ?? ""])).toBe(0);
      expect(logs.join("\n")).toContain("Binary artifact: visual_diff\nMedia type: image/png");
      expect(logs.join("\n")).toContain("Path:");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
    }
  });

  it("imports Figma evidence and runs a structured AI visual review", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const referencePath = join(root, "figma.png");
    const actualPath = join(root, "actual.png");
    mkdirSync(repo, { recursive: true });
    const image = new PNG({ width: 2, height: 2 });
    image.data.fill(255);
    const png = PNG.sync.write(image);
    writeFileSync(referencePath, png);
    writeFileSync(actualPath, png);
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "ollama.vision",
          providers: [
            {
              alias: "ollama.vision",
              provider: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              model: "vision-model",
              capabilities: ["text", "vision"]
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      await main(["start", "--manual", "--title", "Figma QA", "--objective", "Review implementation fidelity"]);
      logs.length = 0;
      expect(
        await main([
          "figma",
          "evidence",
          "https://www.figma.com/design/ABC123/Product?node-id=1-2",
          "--image",
          referencePath
        ])
      ).toBe(0);
      const referenceId = logs.find((line) => line.startsWith("Visual reference: "))?.replace("Visual reference: ", "");
      expect(referenceId).toMatch(/^art_/);

      logs.length = 0;
      expect(
        await main(["visual", "compare", "--reference-artifact", referenceId ?? "", "--actual", actualPath])
      ).toBe(0);
      const comparisonId = logs
        .find((line) => line.startsWith("Visual comparison: "))
        ?.replace("Visual comparison: ", "");
      expect(comparisonId).toMatch(/^art_/);

      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ images?: string[] }> };
        expect(body.messages.at(-1)?.images).toHaveLength(3);
        return new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ status: "passed", summary: "No visible regressions found.", findings: [] })
            }
          }),
          { status: 200 }
        );
      }) as typeof fetch;
      logs.length = 0;
      expect(await main(["visual", "review", "--comparison", comparisonId ?? ""])).toBe(0);
      expect(logs).toContain("Status: passed");
      expect(logs).toContain("Findings: 0 (0 blocking)");
      expect(logs.some((line) => line.startsWith("Visual review: art_"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      globalThis.fetch = previousFetch;
    }
  });

  it("shows artifact content by id", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "# Planning fixture\n");
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");

      const startCode = await main([
        "start",
        "--manual",
        "--title",
        "Artifact Demo",
        "--objective",
        "Show stored artifact content"
      ]);

      expect(startCode).toBe(0);
      const artifactId = logs.find((line) => line.startsWith("Task brief: "))?.replace("Task brief: ", "");
      expect(artifactId).toMatch(/^art_/);

      logs.length = 0;
      const showCode = await main(["artifacts", "show", artifactId ?? ""]);

      expect(showCode).toBe(0);
      expect(logs.join("\n")).toContain("Artifact Demo");
      expect(logs.join("\n")).toContain("Show stored artifact content");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
    }
  });

  it("summarizes and inspects the latest compact context manifest", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "target.ts"), "export const target = true;\n");
    writeFileSync(join(repo, "src", "target.test.ts"), "expect(true).toBe(true);\n");
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      await main(["start", "--manual", "--title", "Target", "--objective", "Update target source"]);
      await main(["context", "build", "--max-files", "1", "--max-bytes", "1000"]);
      logs.length = 0;

      expect(await main(["context", "summarize"])).toBe(0);
      expect(logs).toContain("Scanned files: 2");
      expect(logs).toContain("Candidates: 2");
      expect(logs).toContain("Included sources: 1");
      expect(logs).toContain("Excluded candidates: 1");

      logs.length = 0;
      expect(await main(["context", "inspect", "--excluded"])).toBe(0);
      expect(logs).toContain("Excluded:");
      expect(logs.some((line) => line.includes("file budget exceeded"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
    }
  });

  it("accepts pnpm-style leading argument separator", async () => {
    const logs = captureLogs();

    const code = await main(["--", "--help"]);

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Sigil 0.0.0");
  });

  it("prints Sigil async errors without leaking stack traces", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");

      const code = await main(["checks", "run"]);

      expect(code).toBe(4);
      expect(logs).toContain("No active session found for checks");
      expect(logs.join("\n")).not.toContain("at runBasicCheck");
    } finally {
      process.chdir(previousCwd);
      if (previousSigilHome === undefined) {
        delete process.env.SIGIL_HOME;
      } else {
        process.env.SIGIL_HOME = previousSigilHome;
      }
    }
  });

  it("stores credential aliases from environment variables without printing secrets", async () => {
    const root = tempRoot();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousToken = process.env.SIGIL_TEST_FIGMA_TOKEN;
    const logs = captureLogs();

    try {
      process.env.SIGIL_HOME = join(root, "home");
      process.env.SIGIL_TEST_FIGMA_TOKEN = "figd_test_secret_token";

      const addCode = await main([
        "auth",
        "add",
        "--provider",
        "figma",
        "--alias",
        "figma.default",
        "--value-env",
        "SIGIL_TEST_FIGMA_TOKEN"
      ]);
      const listCode = await main(["auth", "list"]);

      expect(addCode).toBe(0);
      expect(listCode).toBe(0);
      expect(logs.join("\n")).toContain("figma.default figma");
      expect(logs.join("\n")).not.toContain("figd_test_secret_token");
    } finally {
      restoreEnv("SIGIL_HOME", previousSigilHome);
      restoreEnv("SIGIL_TEST_FIGMA_TOKEN", previousToken);
    }
  });

  it("reports adapter health from configured aliases and commands", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "sigil.config.json"),
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
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousToken = process.env.SIGIL_TEST_FIGMA_TOKEN;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      process.env.SIGIL_TEST_FIGMA_TOKEN = "figd_test_secret_token";
      await main([
        "auth",
        "add",
        "--provider",
        "figma",
        "--alias",
        "figma.default",
        "--value-env",
        "SIGIL_TEST_FIGMA_TOKEN"
      ]);

      const code = await main(["adapters", "health"]);

      expect(code).toBe(1);
      expect(logs).toContain("figma: configured api-token-present");
      expect(logs).toContain("github: not-configured fixture");
      expect(logs).toContain("codex: configured");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      restoreEnv("SIGIL_TEST_FIGMA_TOKEN", previousToken);
    }
  });

  it("reports AI provider health from configured Ollama providers", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "ollama.local",
          providers: [
            {
              alias: "ollama.local",
              provider: "ollama",
              baseUrl: "http://localhost:11434",
              model: "qwen2.5-coder:7b",
              timeoutMs: 1000
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }] }), { status: 200 })) as typeof fetch;

      const code = await main(["ai", "providers", "health"]);

      expect(code).toBe(0);
      expect(logs).toContain("ollama.local: configured ollama qwen2.5-coder:7b ollama model available");
    } finally {
      process.chdir(previousCwd);
      globalThis.fetch = previousFetch;
    }
  });

  it("adds the Hetzner provider preset with explicit cloud-code consent", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({ schemaVersion: 1, project: { name: "fixture", baseBranch: "main" } })
    );
    const previousCwd = process.cwd();
    const logs = captureLogs();

    try {
      process.chdir(repo);
      const code = await main([
        "ai",
        "providers",
        "add",
        "hetzner",
        "--token-alias",
        "hetzner.default",
        "--allow-cloud-code"
      ]);
      const config = JSON.parse(readFileSync(join(repo, "sigil.config.json"), "utf8")) as {
        ai: { allowCloudCodeContext: boolean; providers: Array<Record<string, unknown>> };
      };

      expect(code).toBe(0);
      expect(config.ai.allowCloudCodeContext).toBe(true);
      expect(config.ai.providers[0]).toMatchObject({
        preset: "hetzner-inference",
        baseUrl: "https://inference.hetzner.com/api/v1",
        model: "Qwen/Qwen3.6-35B-A3B-FP8"
      });
      expect(logs).toContain("Cloud code context: allowed");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("runs a vision capability test and records the result", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    const imagePath = join(root, "screen.png");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      imagePath,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXcAAAAASUVORK5CYII=", "base64")
    );
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          allowCloudImages: true,
          providers: [
            {
              alias: "hetzner.default",
              provider: "openai-compatible",
              baseUrl: "https://inference.hetzner.com/api/v1",
              model: "Qwen/Qwen3.6-35B-A3B-FP8",
              capabilities: ["text", "vision"]
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown[] }> };
        expect(body.messages[0]?.content).toHaveLength(2);
        return new Response(JSON.stringify({ choices: [{ message: { content: "The interface is visually stable." } }] }), {
          status: 200
        });
      }) as typeof fetch;
      await main(["start", "--manual", "--title", "Visual QA", "--objective", "Review the interface"]);
      logs.length = 0;

      const code = await main(["ai", "vision", "test", imagePath, "--provider", "hetzner.default"]);

      expect(code).toBe(0);
      expect(logs.some((line) => line.startsWith("Vision result: art_"))).toBe(true);
      expect(logs).toContain("The interface is visually stable.");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      globalThis.fetch = previousFetch;
    }
  });

  it("blocks cloud context build when project consent is absent", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          providers: [
            {
              alias: "hetzner.default",
              provider: "openai-compatible",
              baseUrl: "https://inference.hetzner.com/api/v1",
              model: "Qwen/Qwen3.6-35B-A3B-FP8"
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      await main(["start", "--manual", "--title", "Target", "--objective", "Update target source"]);
      const code = await main(["context", "build", "--ai"]);

      expect(code).toBe(1);
      expect(logs).toContain(
        "Cloud AI provider hetzner.default requires explicit ai.allowCloudCodeContext=true consent"
      );
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
    }
  });

  it("lists AI models for a configured Ollama provider", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "ollama.local",
          providers: [
            {
              alias: "ollama.local",
              provider: "ollama",
              baseUrl: "http://localhost:11434",
              model: "qwen2.5-coder:7b"
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5-coder:7b" }] }), {
          status: 200
        })) as typeof fetch;

      const code = await main(["ai", "models"]);

      expect(code).toBe(0);
      expect(logs).toEqual(["llama3.2:3b", "qwen2.5-coder:7b"]);
    } finally {
      process.chdir(previousCwd);
      globalThis.fetch = previousFetch;
    }
  });

  it("builds AI-assisted context with a configured Ollama provider", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
    writeFileSync(join(repo, "README.md"), "# Fixture\n");
    writeFileSync(join(repo, "src", "target.ts"), "export const target = true;\n");
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "ollama.local",
          providers: [
            {
              alias: "ollama.local",
              provider: "ollama",
              baseUrl: "http://localhost:11434",
              model: "qwen2.5-coder:7b"
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                recommendations: [{ uri: "src/target.ts", reason: "Task-specific source", confidence: 0.97 }],
                missing_context: [],
                questions: []
              })
            }
          }),
          { status: 200 }
        )) as typeof fetch;

      const startCode = await main([
        "start",
        "--manual",
        "--title",
        "Target",
        "--objective",
        "Update target source",
        "--task-key",
        "manual-target"
      ]);
      const contextCode = await main(["context", "build", "--ai", "--max-files", "1", "--max-bytes", "1000"]);

      expect(startCode).toBe(0);
      expect(contextCode).toBe(0);
      expect(logs.some((line) => line.startsWith("AI recommendation: art_"))).toBe(true);
      expect(logs.some((line) => line.startsWith("Context quality: "))).toBe(true);
      expect(logs.some((line) => line.startsWith("Context quality report: art_"))).toBe(true);
      expect(logs).toContain("Scanned files: 4");
      expect(logs).toContain("Candidates: 2");
      expect(logs).toContain("Included sources: 1");
      expect(logs).toContain("Excluded candidates: 1");
      expect(logs).toContain("State: context_ready");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      globalThis.fetch = previousFetch;
    }
  });

  it("falls back to deterministic context when AI context scout returns malformed output", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
    writeFileSync(join(repo, "README.md"), "# Fixture\n");
    writeFileSync(join(repo, "src", "target.ts"), "export const target = true;\n");
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "ollama.local",
          providers: [
            {
              alias: "ollama.local",
              provider: "ollama",
              baseUrl: "http://localhost:11434",
              model: "qwen2.5-coder:0.5b"
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ message: { content: "not json" } }), { status: 200 })) as typeof fetch;

      await main([
        "start",
        "--manual",
        "--title",
        "Target",
        "--objective",
        "Update target source",
        "--task-key",
        "manual-target"
      ]);
      const code = await main(["context", "build", "--ai", "--max-files", "1", "--max-bytes", "1000"]);

      expect(code).toBe(0);
      expect(logs).toContain(
        "AI scout unavailable; falling back to deterministic context: AI context scout returned malformed JSON"
      );
      expect(logs.some((line) => line.startsWith("Built context art_"))).toBe(true);
      expect(logs).toContain("State: context_ready");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      globalThis.fetch = previousFetch;
    }
  });

  it("refreshes deterministic context after context is already ready", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "openrouter.free",
          providers: [
            {
              alias: "openrouter.free",
              provider: "openai-compatible",
              baseUrl: "https://openrouter.ai/api/v1",
              model: "openrouter/free"
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      globalThis.fetch = (async () => {
        throw new Error("fetch should not be called");
      }) as typeof fetch;

      await main(["start", "--manual", "--title", "Target", "--objective", "Update target source"]);
      await main(["context", "build", "--max-files", "1", "--max-bytes", "1000"]);
      const code = await main(["context", "build", "--max-files", "1", "--max-bytes", "1000"]);

      expect(code).toBe(0);
      expect(logs.filter((line) => line.startsWith("Built context art_"))).toHaveLength(2);
      expect(logs).toContain("Next: sigil plan");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      globalThis.fetch = previousFetch;
    }
  });

  it("exports AI-assisted planning drafts from the CLI", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "# Planning fixture\n");
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "ollama.local",
          providers: [
            {
              alias: "ollama.local",
              provider: "ollama",
              baseUrl: "http://localhost:11434",
              model: "qwen2.5-coder:7b"
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ message: { content: "## Objective\nShip the planned work." } }), {
          status: 200
        })) as typeof fetch;

      await main(["start", "--manual", "--title", "Plan", "--objective", "Plan the work", "--task-key", "manual-plan"]);
      await main(["context", "build"]);
      const code = await main(["plan", "--ai"]);

      expect(code).toBe(0);
      expect(logs.some((line) => line.startsWith("Planning package: art_"))).toBe(true);
      expect(logs.some((line) => line.startsWith("AI planning draft: art_"))).toBe(true);
      expect(logs).toContain("State: planning_ready");
      expect(logs).toContain("Next: sigil contract import <file>");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      globalThis.fetch = previousFetch;
    }
  });

  it("reports OpenAI-compatible AI health using an AI credential alias", async () => {
    const root = tempRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "sigil.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          providers: [
            {
              alias: "cloud.default",
              provider: "openai-compatible",
              baseUrl: "https://example.test/v1",
              model: "free-model",
              tokenAlias: "cloud.default"
            }
          ]
        }
      })
    );
    const previousCwd = process.cwd();
    const previousSigilHome = process.env.SIGIL_HOME;
    const previousToken = process.env.SIGIL_TEST_AI_TOKEN;
    const previousFetch = globalThis.fetch;
    const logs = captureLogs();

    try {
      process.chdir(repo);
      process.env.SIGIL_HOME = join(root, "home");
      process.env.SIGIL_TEST_AI_TOKEN = "sk_example_secret_token";
      await main(["auth", "add", "--provider", "ai", "--alias", "cloud.default", "--value-env", "SIGIL_TEST_AI_TOKEN"]);
      globalThis.fetch = (async (_url, init) => {
        expect(init?.headers).toMatchObject({ authorization: "Bearer sk_example_secret_token" });
        return new Response(JSON.stringify({ data: [{ id: "free-model" }] }), { status: 200 });
      }) as typeof fetch;

      const code = await main(["ai", "providers", "health"]);

      expect(code).toBe(0);
      expect(logs).toContain("cloud.default: configured openai-compatible free-model openai-compatible model available");
      expect(logs.join("\n")).not.toContain("sk_example_secret_token");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("SIGIL_HOME", previousSigilHome);
      restoreEnv("SIGIL_TEST_AI_TOKEN", previousToken);
      globalThis.fetch = previousFetch;
    }
  });

  it("inspects a Linear issue fixture", async () => {
    const root = tempRoot();
    const fixturePath = join(root, "linear.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({ identifier: "ENG-42", title: "Build intake", state: { name: "Todo" }, labels: ["sigil"] })
    );
    const logs = captureLogs();

    const code = await main(["linear", "inspect", fixturePath]);

    expect(code).toBe(0);
    expect(logs).toContain("Issue: ENG-42");
    expect(logs).toContain("Title: Build intake");
    expect(logs).toContain("Labels: sigil");
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

    const code = await main(["github", "inspect", "https://github.com/acme/sigil/pull/12"]);

    expect(code).toBe(0);
    expect(logs).toContain("Kind: pull_request");
    expect(logs).toContain("Repository: acme/sigil");
    expect(logs).toContain("Number: 12");
  });

  it("requires explicit approval for decision records", async () => {
    const logs = captureLogs();

    const code = await main(["decisions", "record", "--kind", "decision"]);

    expect(code).toBe(2);
    expect(logs).toContain("sigil decisions record requires --yes");
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
  git(repo, ["checkout", "-b", "sigil-test"]);
  git(repo, ["config", "user.name", "Sigil Test"]);
  git(repo, ["config", "user.email", "sigil@example.test"]);
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
