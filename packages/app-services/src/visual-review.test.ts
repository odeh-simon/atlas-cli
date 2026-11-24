import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getArtifactRecord } from "@sigil/persistence";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureVisualPage,
  compareVisualEvidence,
  importFigmaVisualEvidence,
  openSigilRuntime,
  runAiVisualReview,
  startManualTask
} from "./index.js";
import { closeSigilRuntime } from "./runtime.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runAiVisualReview", () => {
  it("reviews immutable comparison evidence and stores structured findings", async () => {
    const fixture = await createComparisonFixture();
    const result = await runAiVisualReview({
      cwd: fixture.cwd,
      env: fixture.env,
      comparisonArtifactId: fixture.comparisonArtifactId,
      provider: {
        alias: "ollama.vision",
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "vision-model",
        capabilities: ["text", "vision"]
      },
      completionImpl: async ({ prompt, images }) => {
        expect(prompt).toContain("Deterministic comparison");
        expect(images.map((image) => image.label)).toEqual(["reference", "actual", "diff"]);
        expect(images.every((image) => image.dataUrl.startsWith("data:image/png;base64,"))).toBe(true);
        return {
          providerAlias: "ollama.vision",
          model: "vision-model",
          content: JSON.stringify({
            status: "findings",
            summary: "The implementation has one visible spacing regression.",
            findings: [
              {
                severity: "important",
                category: "spacing",
                title: "Header padding differs",
                detail: "The actual header has visibly less horizontal padding than the reference.",
                evidence: ["reference", "actual", "diff"],
                confidence: 0.91
              }
            ]
          })
        };
      }
    });
    const runtime = await openSigilRuntime({ cwd: fixture.cwd, env: fixture.env });
    const record = getArtifactRecord(runtime.db, result.reviewArtifactId);
    const artifact = JSON.parse(
      readFileSync(join(runtime.paths.artifactRoot, record?.storageUri ?? ""), "utf8")
    ) as Record<string, any>;
    closeSigilRuntime(runtime, false);

    expect(result).toMatchObject({ status: "findings", findingCount: 1, blockingCount: 0 });
    expect(artifact).toMatchObject({
      type: "ai_visual_review",
      comparison_artifact_id: fixture.comparisonArtifactId,
      prompt_version: "visual-review-v1",
      findings: [{ finding_id: "visual_1", category: "spacing", confidence: 0.91 }]
    });
  });

  it("rejects malformed model output without storing a review", async () => {
    const fixture = await createComparisonFixture();
    await expect(
      runAiVisualReview({
        cwd: fixture.cwd,
        env: fixture.env,
        comparisonArtifactId: fixture.comparisonArtifactId,
        provider: {
          alias: "ollama.vision",
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "vision-model",
          capabilities: ["vision"]
        },
        completionImpl: async () => ({ providerAlias: "ollama.vision", model: "vision-model", content: "not json" })
      })
    ).rejects.toThrow("not valid JSON");
  });
});

async function createComparisonFixture(): Promise<{
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly comparisonArtifactId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "sigil-visual-review-"));
  tempRoots.push(root);
  const cwd = join(root, "repo");
  const env = { SIGIL_HOME: join(root, "home") };
  const png = pngFixture();
  mkdirSync(cwd, { recursive: true });
  await startManualTask({ cwd, env, title: "Visual review", objective: "Review the dashboard against Figma" });
  const reference = await importFigmaVisualEvidence({
    cwd,
    env,
    bytes: png,
    figmaUrl: "https://www.figma.com/design/ABC123/Product?node-id=1-2",
    fileKey: "ABC123",
    nodeId: "1-2",
    source: "file"
  });
  const actual = await captureVisualPage({
    cwd,
    env,
    url: "http://127.0.0.1:3000",
    viewport: { width: 800, height: 600 },
    captureAdapter: {
      capture: async (input) => ({
        png,
        url: input.url,
        title: "Dashboard",
        viewport: input.viewport,
        fullPage: false,
        browserChannel: "msedge"
      })
    }
  });
  const comparison = await compareVisualEvidence({
    cwd,
    env,
    referenceArtifactId: reference.referenceArtifactId,
    actualArtifactId: actual.snapshotArtifactId
  });
  return { cwd, env, comparisonArtifactId: comparison.comparisonArtifactId };
}

function pngFixture(): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  return PNG.sync.write(image);
}
