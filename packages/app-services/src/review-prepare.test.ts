import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { getStatus, openAtlasRuntime, prepareReviewPackage, runBasicCheck } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";
import { prepareCheckedImplementation, prepareExecution } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-review-prepare-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("prepareReviewPackage", () => {
  it("creates a review package after checks pass", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareCheckedImplementation(root);

    const result = await prepareReviewPackage({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openAtlasRuntime({ cwd, env });
    const reviewPackages = listArtifactsForSession(runtime.db, result.sessionId).filter(
      (artifact) => artifact.type === "review_package"
    );
    closeAtlasRuntime(runtime, false);

    expect(result.state).toBe("review_ready");
    expect(status.session?.primaryState).toBe("review_ready");
    expect(status.nextCommands[0]).toBe("atlas review import <file>");
    expect(reviewPackages).toHaveLength(1);
  });

  it("blocks review preparation before checks pass", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);

    await expect(prepareReviewPackage({ cwd, env })).rejects.toThrow(
      "Review package requires approved contract, execution report, and passing check result"
    );
  });

  it("includes visual check evidence in the review package", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareExecution(root);
    const png = pngFixture();
    writeFileSync(join(cwd, "baseline.png"), png);
    writeFileSync(
      join(cwd, "atlas.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { name: "fixture", baseBranch: "main" },
        checks: [
          {
            name: "visual",
            kind: "visual",
            required: true,
            url: "http://127.0.0.1:3000",
            referencePath: "baseline.png"
          }
        ]
      })
    );
    await runBasicCheck({
      cwd,
      env,
      visualRuntime: {
        captureAdapter: {
          capture: async (input) => ({
            png,
            url: input.url,
            title: "App",
            viewport: input.viewport,
            fullPage: false,
            browserChannel: "msedge"
          })
        }
      }
    });

    const result = await prepareReviewPackage({ cwd, env });
    const review = readLatestJsonArtifact(root, result.sessionId, "review_package") as {
      visual_evidence_artifact_ids?: unknown[];
      parents?: unknown[];
    };

    expect(review.visual_evidence_artifact_ids?.length).toBeGreaterThanOrEqual(5);
    expect(review.parents).toEqual(expect.arrayContaining(review.visual_evidence_artifact_ids ?? []));
  });
});

function readLatestJsonArtifact(root: string, sessionId: string, type: string): unknown {
  const directory = join(root, "home", "artifacts", sessionId, type);
  const latest = readdirSync(directory).sort().at(-1);
  if (latest === undefined) throw new Error(`No ${type} artifact found`);
  return JSON.parse(readFileSync(join(directory, latest), "utf8")) as unknown;
}

function pngFixture(): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  return PNG.sync.write(image);
}
