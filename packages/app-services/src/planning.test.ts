import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildContextManifest, exportPlanningPackage, getStatus, importContextManifest, openAtlasRuntime, startManualTask } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession, updateArtifactStatus } from "@atlas/persistence";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-plan-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("exportPlanningPackage", () => {
  it("exports a deterministic planning package and advances to planning_ready", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
    await buildContextManifest({ cwd, env });

    const result = await exportPlanningPackage({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const planning = listArtifactsForSession(runtime.db, result.sessionId).find(
      (artifact) => artifact.artifactId === result.planningArtifactId
    );
    const content = readFileSync(join(runtime.paths.artifactRoot, planning?.storageUri ?? ""), "utf8");
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("planning_ready");
    expect(status.session?.primaryState).toBe("planning_ready");
    expect(status.nextCommands[0]).toBe("atlas contract import <file>");
    expect(content).toContain("# Atlas Planning Package");
    expect(content).toContain("Context manifest:");
  });

  it("exports an AI planning draft without bypassing contract import", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
    await buildContextManifest({ cwd, env });
    const prompts: string[] = [];

    const result = await exportPlanningPackage({
      cwd,
      env,
      ai: {
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
            content: "## Objective\nShip usage flow.\n\n## Tests\nRun pnpm test."
          };
        }
      }
    });
    const runtime = await openAtlasRuntime({ cwd, env });
    const aiDraft = listArtifactsForSession(runtime.db, result.sessionId).find(
      (artifact) => artifact.artifactId === result.aiPlanningDraftArtifactId
    );
    const draftContent = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, aiDraft?.storageUri ?? ""), "utf8")) as {
      type: string;
      draft_markdown: string;
      context_manifest_artifact_id: string;
      task_artifact_id: string;
    };
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("planning_ready");
    expect(result.nextCommand).toBe("atlas contract import <file>");
    expect(result.aiPlanningDraftArtifactId).toMatch(/^art_/);
    expect(aiDraft?.type).toBe("ai_planning_draft");
    expect(aiDraft?.status).toBe("valid");
    expect(draftContent.draft_markdown).toContain("Ship usage flow");
    expect(draftContent.context_manifest_artifact_id).toMatch(/^art_/);
    expect(draftContent.task_artifact_id).toMatch(/^art_/);
    expect(prompts[0]).toContain("Do not claim approval");
  });

  it("fails a legacy/incomplete session safely when its content pack is unavailable", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-legacy" });
    const manifestPath = join(root, "context.json");
    writeFileSync(manifestPath, JSON.stringify({ sources: [{ uri: "README.md", kind: "file", reason: "Context", byte_length: 1, included: true }] }));
    await importContextManifest({ cwd, env, filePath: manifestPath });
    const runtime = await openAtlasRuntime({ cwd, env });
    const pack = listArtifactsForSession(runtime.db, runtime.db.exec("SELECT session_id FROM sessions")[0]?.values[0]?.[0] as string)
      .find((artifact) => artifact.type === "context_content_pack");
    if (pack === undefined) throw new Error("Missing fixture content pack");
    updateArtifactStatus(runtime.db, { artifactId: pack.artifactId, status: "stale" });
    closeAtlasRuntime(runtime);

    await expect(exportPlanningPackage({ cwd, env })).rejects.toThrow("legacy sessions must rerun atlas context build");
    await expect(getStatus({ cwd, env })).resolves.toMatchObject({ nextCommands: ["atlas context build"] });
    await expect(buildContextManifest({ cwd, env })).resolves.toMatchObject({ state: "context_ready" });
    await expect(exportPlanningPackage({ cwd, env })).resolves.toMatchObject({ state: "planning_ready" });
  });

  it("invalidates planning when indexed source fragments change and recovers through a context refresh", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Original evidence\n");
    await startManualTask({ cwd, env, title: "Evidence", objective: "Use README evidence", taskKey: "manual-source-freshness" });
    await buildContextManifest({ cwd, env });

    writeFileSync(join(cwd, "README.md"), "# Changed evidence\n");

    await expect(exportPlanningPackage({ cwd, env })).rejects.toThrow("Context source changed after discovery");
    await expect(getStatus({ cwd, env })).resolves.toMatchObject({ nextCommands: ["atlas context build"], context: { fresh: false } });
    await buildContextManifest({ cwd, env });
    await expect(exportPlanningPackage({ cwd, env })).resolves.toMatchObject({ state: "planning_ready" });
  });

  it("invalidates planning when repository instructions or effective project context config changes", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "Use existing conventions.\n");
    writeFileSync(join(cwd, "README.md"), "# Evidence\n");
    writeFileSync(join(cwd, "atlas.config.json"), JSON.stringify({ context: { maxFiles: 20 } }));
    await startManualTask({ cwd, env, title: "Evidence", objective: "Use README evidence", taskKey: "manual-config-freshness" });
    await buildContextManifest({ cwd, env });

    writeFileSync(join(cwd, "AGENTS.md"), "Use revised conventions.\n");
    await expect(exportPlanningPackage({ cwd, env })).rejects.toThrow("Repository instructions changed after discovery");
    await buildContextManifest({ cwd, env });
    writeFileSync(join(cwd, "atlas.config.json"), JSON.stringify({ context: { maxFiles: 21 } }));
    await expect(exportPlanningPackage({ cwd, env })).rejects.toThrow("Context configuration changed after discovery");
  });
});
