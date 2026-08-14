import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listArtifactsForSession } from "@atlas/persistence";

import { openAtlasRuntime, runAiVisionTest, startManualTask } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runAiVisionTest", () => {
  it("sends a validated image and stores an auditable result for an active session", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-ai-vision-"));
    tempRoots.push(root);
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    const imagePath = join(root, "screen.png");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(imagePath, pngFixture());
    const session = await startManualTask({ cwd, env, title: "Visual QA", objective: "Review the interface" });

    const result = await runAiVisionTest({
      cwd,
      env,
      imagePath,
      prompt: "Review this interface",
      cloudImageConsent: true,
      provider: {
        alias: "hetzner.default",
        provider: "openai-compatible",
        baseUrl: "https://inference.hetzner.com/api/v1",
        model: "Qwen/Qwen3.6-35B-A3B-FP8",
        capabilities: ["text", "vision"]
      },
      completionImpl: async ({ dataUrl, prompt }) => {
        expect(dataUrl).toMatch(/^data:image\/png;base64,/);
        expect(prompt).toBe("Review this interface");
        return { providerAlias: "hetzner.default", model: "Qwen/Qwen3.6-35B-A3B-FP8", content: "No overlap found." };
      }
    });
    const runtime = await openAtlasRuntime({ cwd, env });
    const artifact = listArtifactsForSession(runtime.db, session.session.sessionId).find(
      (candidate) => candidate.artifactId === result.artifactId
    );
    closeAtlasRuntime(runtime, false);

    expect(result).toMatchObject({ mediaType: "image/png", analysis: "No overlap found." });
    expect(result.artifactId).toMatch(/^art_/);
    expect(artifact).toMatchObject({ type: "ai_vision_result", status: "valid", sensitivity: "confidential" });
  });

  it("rejects unsupported image content before invoking AI", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-ai-vision-invalid-"));
    tempRoots.push(root);
    const imagePath = join(root, "fake.png");
    writeFileSync(imagePath, "not an image");

    await expect(
      runAiVisionTest({
        imagePath,
        prompt: "Review",
        provider: {
          alias: "ollama.vision",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "vision-model",
          capabilities: ["text", "vision"]
        }
      })
    ).rejects.toThrow("PNG, JPEG, WebP, or GIF");
  });
});

function pngFixture(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXcAAAAASUVORK5CYII=", "base64");
}
