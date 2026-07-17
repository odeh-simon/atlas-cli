import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildContextManifest, getStatus, openAtlasRuntime, runAiContextScout, startManualTask } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-context-build-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("buildContextManifest", () => {
  it("builds a context manifest from repository files and advances the session", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    writeFileSync(join(cwd, "src", "index.ts"), "export const value = 1;\n");
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });

    const result = await buildContextManifest({ cwd, env, maxFiles: 10 });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const contextArtifacts = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "context_manifest"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("context_ready");
    expect(result.includedSourceCount).toBe(3);
    expect(status.nextCommands[0]).toBe("atlas plan");
    expect(contextArtifacts).toHaveLength(1);
    expect(contextArtifacts[0]?.status).toBe("valid");
  });

  it("builds a hybrid manifest from AI recommendations", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    writeFileSync(join(cwd, "src", "target.ts"), "export const target = true;\n");
    await startManualTask({ cwd, env, title: "Target", objective: "Update target source", taskKey: "manual-target" });
    const scout = await runAiContextScout({
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
        content: JSON.stringify({
          recommendations: [{ uri: "src/target.ts", reason: "Task-specific source", confidence: 0.98 }],
          missing_context: [],
          questions: []
        })
      })
    });

    const result = await buildContextManifest({
      cwd,
      env,
      maxFiles: 1,
      maxBytes: 1_000,
      aiRecommendationArtifactId: scout.recommendationArtifactId
    });
    const runtime = await openAtlasRuntime({ cwd, env });
    try {
      const contextArtifact = listArtifactsForSession(runtime.db, result.sessionId).find(
        (artifact) => artifact.artifactId === result.contextArtifactId
      );
      expect(contextArtifact).toBeDefined();
      const manifest = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, contextArtifact?.storageUri ?? ""), "utf8")) as {
        metadata: Record<string, unknown>;
        sources: Array<{ uri: string; included: boolean; reason: string }>;
      };

      expect(manifest.metadata.discovery).toBe("hybrid");
      expect(manifest.metadata.ai_recommendation_artifact_id).toBe(scout.recommendationArtifactId);
      expect(manifest.sources.filter((source) => source.included).map((source) => source.uri)).toEqual(["src/target.ts"]);
      expect(manifest.sources[0]?.reason).toContain("AI recommended");
    } finally {
      closeAtlasRuntime(runtime, false);
    }
  });
});
