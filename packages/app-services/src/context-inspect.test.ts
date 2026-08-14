import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildContextManifest, inspectContextManifest, startManualTask } from "./index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("inspectContextManifest", () => {
  it("summarizes the latest context manifest without listing omitted scan files", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-context-inspect-"));
    tempRoots.push(root);
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(join(cwd, "src"), { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(cwd, "src", `file-${index}.ts`), `export const value${index} = ${index};\n`);
    }
    await startManualTask({ cwd, env, title: "Value", objective: "Update value source" });
    const built = await buildContextManifest({ cwd, env, maxFiles: 5, maxBytes: 10_000 });

    const result = await inspectContextManifest({ cwd, env });

    expect(result).toMatchObject({
      artifactId: built.contextArtifactId,
      scannedFileCount: 30,
      candidateFileCount: 10,
      omittedScanCount: 20
    });
    expect(result?.includedSources).toHaveLength(5);
    expect(result?.excludedCandidates).toHaveLength(5);
    expect(result?.includedSources[0]?.rank).toBe(1);
  });
});
