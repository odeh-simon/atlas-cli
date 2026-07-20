import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listArtifactsForSession } from "@atlas/persistence";

import { closeAtlasRuntime, openAtlasRuntime } from "./runtime.js";
import { runAiContextScout, startManualTask } from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-context-scout-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runAiContextScout", () => {
  it("stores AI context recommendations from task brief and candidate snippets", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "package.json"), "{\"name\":\"fixture\"}\n");
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    writeFileSync(join(cwd, "table-cells.tsx"), "export function ReusableTableCell() { return null; }\n");
    const prompts: string[] = [];

    await startManualTask({
      cwd,
      env,
      title: "Reusable table value components",
      objective: "Build reusable table value components for regression-stable cells with precise loading states.",
      taskKey: "CLI-103"
    });
    const result = await runAiContextScout({
      cwd,
      env,
      provider: {
        alias: "ollama.local",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        model: "qwen2.5-coder:7b"
      },
      completionImpl: async (prompt) => {
        prompts.push(prompt);
        return {
          providerAlias: "ollama.local",
          model: "qwen2.5-coder:7b",
          content: JSON.stringify({
            recommendations: [
              {
                uri: "table-cells.tsx",
                reason: "Contains the table cell component candidate for the requested reusable value components.",
                confidence: 0.92
              }
            ],
            missing_context: ["Need visual regression expectations."],
            questions: []
          })
        };
      }
    });

    expect(result.recommendationCount).toBe(1);
    expect(result.missingContextCount).toBe(1);
    expect(prompts[0]).toContain("Build reusable table value components for regression-stable cells");
    expect(prompts[0]).toContain("ReusableTableCell");

    const runtime = await openAtlasRuntime({ cwd, env });
    try {
      const artifacts = listArtifactsForSession(runtime.db, result.sessionId);
      expect(artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: result.recommendationArtifactId,
            type: "ai_context_recommendation",
            status: "valid"
          })
        ])
      );
    } finally {
      closeAtlasRuntime(runtime);
    }
  });

  it("rejects malformed AI scout JSON", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "package.json"), "{\"name\":\"fixture\"}\n");
    await startManualTask({ cwd, env, title: "Task", objective: "Objective", taskKey: "TASK-1" });

    await expect(
      runAiContextScout({
        cwd,
        env,
        provider: {
          alias: "ollama.local",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "qwen2.5-coder:7b"
        },
        completionImpl: async () => ({
          providerAlias: "ollama.local",
          model: "qwen2.5-coder:7b",
          content: "not json"
        })
      })
    ).rejects.toThrow("AI context scout returned malformed JSON");
  });

  it("limits candidate snippets by provider input budget", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "package.json"), "{\"name\":\"fixture\"}\n");
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(cwd, `source-${index}.ts`), `export const value${index} = "${"x".repeat(5_000)}";\n`);
    }
    const prompts: string[] = [];
    await startManualTask({ cwd, env, title: "Task", objective: "Objective", taskKey: "TASK-1" });

    await runAiContextScout({
      cwd,
      env,
      maxFiles: 8,
      provider: {
        alias: "openrouter.free",
        provider: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openrouter/free",
        maxInputTokens: 1_000
      },
      completionImpl: async (prompt) => {
        prompts.push(prompt);
        return {
          providerAlias: "openrouter.free",
          model: "openrouter/free",
          content: JSON.stringify({ recommendations: [], missing_context: [], questions: [] })
        };
      }
    });

    expect(prompts[0]?.length).toBeLessThan(8_000);
  });
});
