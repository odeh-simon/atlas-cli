import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { exportManualAgentPackage, getStatus, openSigilRuntime } from "./index.js";
import { closeSigilRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@sigil/persistence";
import { prepareApprovedContract } from "./test-support.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-agent-package-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("exportManualAgentPackage", () => {
  it("exports a package from an approved contract and advances state", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);

    const result = await exportManualAgentPackage({ cwd, env });
    const status = await getStatus({ cwd, env });
    const runtime = await openSigilRuntime({ cwd, env });
    const artifact = listArtifactsForSession(runtime.db, result.sessionId).find(
      (candidate) => candidate.artifactId === result.packageArtifactId
    );
    const packageContent = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, artifact?.storageUri ?? ""), "utf8")) as Record<string, any>;
    const content = packageContent.instructions_markdown as string;
    closeSigilRuntime(runtime, false);

    expect(result.state).toBe("implementation_ready");
    expect(status.session?.primaryState).toBe("implementation_ready");
    expect(status.nextCommands[0]).toBe("sigil execution import <file>");
    expect(content).toContain("# Sigil Manual Agent Package");
    expect(content).toContain("## Approved Contract (authoritative)");
    expect(content).toContain("Ship walking skeleton.");
    expect(content).toContain("## Resolved Context Evidence");
    expect(content).toContain("# Sigil test fixture");
    expect(content).toContain("## Required Validation");
    expect(content).toContain("pnpm test");
    expect(packageContent).toMatchObject({
      schema_version: 2,
      contract_artifact_id: expect.stringMatching(/^art_/),
      contract_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      context_content_pack_artifact_id: expect.stringMatching(/^art_/),
      context_content_pack_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      git_snapshot_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      git_base_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      git_root_path_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("does not package pre-existing worktree changes as implementation-owned work", async () => {
    const root = tempRoot();
    const { cwd, env } = await prepareApprovedContract(root);
    writeFileSync(join(cwd, "pre-existing.ts"), "export const preExisting = true;\n");

    await expect(exportManualAgentPackage({ cwd, env })).rejects.toThrow("requires a clean Git worktree");
  });
});
