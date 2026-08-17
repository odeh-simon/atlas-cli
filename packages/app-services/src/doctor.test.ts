import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, openAtlasRuntime, runDoctor } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareApprovedContract } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-doctor-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runDoctor", () => {
  it("passes on intact session artifacts", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("passed");
    expect(result.issues).toHaveLength(0);
    expect(result.artifactCount).toBeGreaterThan(0);
  });

  it("detects artifact hash mismatches without mutating state", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    if (status.session === undefined) throw new Error("Expected session fixture");
    const artifact = listArtifactsForSession(runtime.db, status.session.sessionId)[0];
    if (artifact === undefined) throw new Error("Expected artifact fixture");
    const path = join(runtime.paths.artifactRoot, artifact.storageUri);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}\ncorrupt\n`);
    closeAtlasRuntime(runtime, false);

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain("artifact.hash_mismatch");
  });

  it("reports malformed config JSON instead of crashing", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    writeFileSync(join(cwd, "atlas.config.json"), "{ nope");

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain("config.invalid_json");
  });

  it("reports missing AI credential aliases", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    writeFileSync(
      join(cwd, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          providers: [
            {
              alias: "cloud.default",
              provider: "openai-compatible",
              baseUrl: "https://api.example.test/v1",
              model: "free-model",
              tokenAlias: "ai.missing"
            }
          ]
        }
      })
    );

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("passed");
    expect(result.issues.map((issue) => issue.summary)).toContain("Configured AI credential alias is missing: ai.missing");
  });

  it("validates configuration before a session exists", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "atlas.config.json"), "{ nope");

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("failed");
    expect(result.sessionId).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toContain("config.invalid_json");
  });

  it("fails clearly on an unsupported Node.js runtime", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });

    const result = await runDoctor({ cwd, env, runtimeVersion: "20.19.0" });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain("runtime.unsupported_node");
  });

  it("reports interrupted database sidecars without deleting them", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    const interruptedPath = join(env.ATLAS_HOME, "atlas.db.tmp");
    writeFileSync(interruptedPath, "preserve me");

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain("storage.interrupted_write");
    expect(readFileSync(interruptedPath, "utf8")).toBe("preserve me");
  });

  it("reports invalid AI defaults and disabled cloud context separately", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: {
          defaultProviderAlias: "missing.default",
          providers: [
            {
              alias: "cloud.default",
              provider: "openai-compatible",
              baseUrl: "https://api.example.test/v1",
              model: "free-model"
            }
          ]
        }
      })
    );

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["config.ai_default_missing", "cloud.code_context_disabled"])
    );
  });

  it("reports malformed AI provider collections without crashing", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(cwd, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        ai: { providers: { alias: "not-an-array" } }
      })
    );

    const result = await runDoctor({ cwd, env, runtimeVersion: "22.23.1" });

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain("config.ai_providers_invalid");
  });
});
