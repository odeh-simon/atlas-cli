import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { listArtifactsForSession } from "@atlas/persistence";

import {
  captureVisualPage,
  compareVisualEvidence,
  importFigmaVisualEvidence,
  openAtlasRuntime,
  startManualTask
} from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("visual QA evidence", () => {
  it("captures a stable snapshot and compares it with a PNG reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-visual-qa-"));
    tempRoots.push(root);
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    const referencePath = join(root, "reference.png");
    const png = pngFixture();
    mkdirSync(cwd, { recursive: true });
    writeFileSync(referencePath, png);
    const started = await startManualTask({ cwd, env, title: "Visual QA", objective: "Compare the dashboard" });

    const captured = await captureVisualPage({
      cwd,
      env,
      url: "http://127.0.0.1:3000/dashboard",
      viewport: { width: 1440, height: 900 },
      captureAdapter: {
        capture: async (input) => ({
          png,
          url: input.url,
          title: "Dashboard",
          viewport: input.viewport,
          fullPage: input.fullPage ?? false,
          browserChannel: "msedge"
        })
      }
    });
    const compared = await compareVisualEvidence({
      cwd,
      env,
      referencePath,
      actualArtifactId: captured.snapshotArtifactId,
      allowedDiffRatio: 0
    });
    const runtime = await openAtlasRuntime({ cwd, env });
    const types = listArtifactsForSession(runtime.db, started.session.sessionId).map((artifact) => artifact.type);
    closeAtlasRuntime(runtime, false);

    expect(captured.captureArtifactId).toMatch(/^art_/);
    expect(captured.snapshotPath).toMatch(/\.png$/);
    expect(compared).toMatchObject({ status: "passed", mismatchedPixels: 0, diffRatio: 0 });
    expect(compared.diffArtifactId).toMatch(/^art_/);
    expect(types).toEqual(
      expect.arrayContaining(["visual_snapshot", "visual_capture", "visual_reference", "visual_diff", "visual_comparison"])
    );
  });

  it("requires exactly one actual image source", async () => {
    await expect(compareVisualEvidence({ referencePath: "reference.png" })).rejects.toThrow(
      "exactly one of actualPath or actualArtifactId"
    );
  });

  it("imports Figma PNG evidence and compares its reference artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-figma-visual-"));
    tempRoots.push(root);
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    const png = pngFixture();
    mkdirSync(cwd, { recursive: true });
    await startManualTask({ cwd, env, title: "Figma evidence", objective: "Compare implementation with design" });
    const imported = await importFigmaVisualEvidence({
      cwd,
      env,
      bytes: png,
      figmaUrl: "https://www.figma.com/design/ABC123/Product?node-id=1-2",
      fileKey: "ABC123",
      nodeId: "1-2",
      source: "file"
    });
    const actualPath = join(root, "actual.png");
    writeFileSync(actualPath, png);
    const compared = await compareVisualEvidence({
      cwd,
      env,
      referenceArtifactId: imported.referenceArtifactId,
      actualPath,
      allowedDiffRatio: 0
    });

    expect(imported.evidenceArtifactId).toMatch(/^art_/);
    expect(imported.referencePath).toMatch(/visual_reference/);
    expect(compared).toMatchObject({ referenceArtifactId: imported.referenceArtifactId, status: "passed" });
  });
});

function pngFixture(): Buffer {
  const image = new PNG({ width: 1, height: 1 });
  image.data.set([255, 255, 255, 255]);
  return PNG.sync.write(image);
}
