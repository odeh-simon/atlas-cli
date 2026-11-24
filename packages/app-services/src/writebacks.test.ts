import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { recordAdapterWriteback } from "./index.js";
import { prepareApprovedContract } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-writebacks-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("recordAdapterWriteback", () => {
  it("stores audited dry-run writeback artifacts", async () => {
    const root = tempRoot();
    const prepared = await prepareApprovedContract(root);

    const result = await recordAdapterWriteback({
      ...prepared,
      provider: "linear",
      mode: "dry-run",
      status: "prepared",
      target: "CLI-103",
      summary: "Sigil would post completion evidence."
    });

    const artifact = readLatestJsonArtifact(root, result.sessionId, "adapter_writeback");
    expect(result.status).toBe("prepared");
    expect(artifact.artifact_id).toBe(result.writebackArtifactId);
    expect(artifact.mode).toBe("dry-run");
    expect(artifact.target).toBe("CLI-103");
  });
});

function readLatestJsonArtifact(root: string, sessionId: string, type: string): Record<string, any> {
  const artifactDir = join(root, "home", "artifacts", sessionId, type);
  const latest = readdirSync(artifactDir).sort().at(-1);
  if (latest === undefined) throw new Error(`No ${type} artifact found`);
  return JSON.parse(readFileSync(join(artifactDir, latest), "utf8")) as Record<string, any>;
}
