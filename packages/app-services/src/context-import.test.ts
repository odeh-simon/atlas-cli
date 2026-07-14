import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, importContextManifest, startManualTask } from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-context-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("importContextManifest", () => {
  it("imports a minimal context manifest and advances to context_ready", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
    const manifestPath = join(root, "context.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        sources: [
          {
            uri: "README.md",
            kind: "file",
            reason: "User supplied context",
            byte_length: 120,
            included: true
          }
        ]
      })
    );

    const result = await importContextManifest({ cwd, env, filePath: manifestPath });
    const status = await getStatus({ cwd, env });

    expect(result.state).toBe("context_ready");
    expect(status.session?.primaryState).toBe("context_ready");
    expect(status.artifactCount).toBe(2);
    expect(status.nextCommands).toEqual(["atlas plan"]);
  });

  it("rejects invalid JSON without advancing state", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    await startManualTask({ cwd, env, title: "Usage", objective: "Show usage", taskKey: "manual-usage" });
    const manifestPath = join(root, "context.json");
    writeFileSync(manifestPath, "{");

    await expect(importContextManifest({ cwd, env, filePath: manifestPath })).rejects.toThrow(
      "Context manifest must be valid JSON"
    );
    await expect(getStatus({ cwd, env })).resolves.toMatchObject({
      session: expect.objectContaining({ primaryState: "intake_ready" })
    });
  });
});
