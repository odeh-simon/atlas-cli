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
    const qualityArtifacts = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "context_quality_report"
    );
    const packs = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "context_content_pack"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("context_ready");
    expect(result.contextReadiness).toBe("weak");
    expect(result.includedSourceCount).toBe(3);
    expect(status.nextCommands[0]).toBe("atlas plan");
    expect(contextArtifacts).toHaveLength(1);
    expect(contextArtifacts[0]?.status).toBe("valid");
    expect(qualityArtifacts).toHaveLength(1);
    expect(qualityArtifacts[0]?.artifactId).toBe(result.contextQualityReportArtifactId);
    expect(packs[0]?.artifactId).toBe(result.contextContentPackArtifactId);
    expect(packs[0]?.status).toBe("valid");
  });

  it("propagates scout gaps and blocks context readiness", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    await startManualTask({ cwd, env, title: "Auth", objective: "Change auth", taskKey: "manual-auth" });
    const scout = await runAiContextScout({
      cwd,
      env,
      provider: { alias: "ollama.local", provider: "ollama", baseUrl: "http://localhost:11434", model: "test" },
      completionImpl: async () => ({
        providerAlias: "ollama.local",
        model: "test",
        content: JSON.stringify({ recommendations: [], missing_context: ["authorization policy"], questions: ["Which tenant owns it?"] })
      })
    });

    await expect(
      buildContextManifest({ cwd, env, aiRecommendationArtifactId: scout.recommendationArtifactId })
    ).rejects.toThrow("Context readiness gate failed");
    const status = await getStatus({ cwd, env });
    expect(status.session?.primaryState).toBe("intake_ready");
    const runtime = await openAtlasRuntime({ cwd, env });
    try {
      const artifacts = listArtifactsForSession(runtime.db, status.session?.sessionId ?? "");
      const manifestRecord = artifacts.find((artifact) => artifact.type === "context_manifest");
      const manifest = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, manifestRecord?.storageUri ?? ""), "utf8")) as {
        gaps: Array<{ severity: string; description: string }>;
      };
      expect(manifest.gaps).toHaveLength(2);
      expect(manifest.gaps.every((gap) => gap.severity === "blocking")).toBe(true);
      expect(artifacts.find((artifact) => artifact.type === "context_content_pack")?.status).toBe("rejected");
    } finally {
      closeAtlasRuntime(runtime, false);
    }
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
        discovery_summary: { scanned_file_count: number; candidate_file_count: number };
        included_sources: Array<{ uri: string; included: boolean; reason: string; selection_reasons: string[] }>;
        excluded_candidates: Array<{ uri: string; included: boolean; reason: string }>;
      };

      expect(manifest.metadata.discovery).toBe("hybrid");
      expect(manifest.metadata.ai_recommendation_artifact_id).toBe(scout.recommendationArtifactId);
      expect(manifest.discovery_summary).toMatchObject({ scanned_file_count: 3, candidate_file_count: 2 });
      expect(manifest.included_sources.map((source) => source.uri)).toEqual(["src/target.ts"]);
      expect(manifest.included_sources[0]?.selection_reasons.join(" ")).toContain("AI recommended");
      expect(manifest.excluded_candidates).toHaveLength(1);
      expect(result.contextReadiness).toBe("weak");
    } finally {
      closeAtlasRuntime(runtime, false);
    }
  });

  it("blocks when pinned evidence cannot fit the hard content-pack budget", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "required.ts"), `export const evidence = ${JSON.stringify("x".repeat(210_000))};\n`);
    writeFileSync(join(cwd, "atlas.config.json"), JSON.stringify({ context: { maxBytes: 300_000, pinnedSources: ["src/required.ts"] } }));
    await startManualTask({ cwd, env, title: "Evidence", objective: "Use required evidence", taskKey: "manual-pack-budget" });

    await expect(buildContextManifest({ cwd, env })).rejects.toThrow("Required context evidence cannot fit the content-pack budget");
    await expect(getStatus({ cwd, env })).resolves.toMatchObject({ session: { primaryState: "intake_ready" } });
  });
});
