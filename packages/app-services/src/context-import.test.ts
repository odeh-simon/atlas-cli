import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getStatus, importContextManifest, openAtlasRuntime, startManualTask } from "./index.js";
import { closeAtlasRuntime } from "./runtime.js";
import { listArtifactsForSession } from "@atlas/persistence";

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
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
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
    expect(status.artifactCount).toBe(3);
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

  it("rejects a regular file reached through a repository-escaping symlink or junction", async (context) => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const outside = join(root, "outside");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "escape.md"), "outside repository\n");
    try {
      symlinkSync(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        context.skip();
        return;
      }
      throw error;
    }
    await startManualTask({ cwd, env, title: "Escape", objective: "Reject escaped evidence", taskKey: "manual-escape" });
    const manifestPath = join(root, "escape-context.json");
    writeFileSync(manifestPath, JSON.stringify({ sources: [{ uri: "linked/escape.md", kind: "file", reason: "Untrusted", byte_length: 1, included: true }] }));

    await expect(importContextManifest({ cwd, env, filePath: manifestPath })).rejects.toThrow("escapes the repository root");
  });

  it("replaces a spoofed imported manifest envelope with trusted session identity", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Fixture\n");
    await startManualTask({ cwd, env, title: "Envelope", objective: "Normalize envelope", taskKey: "manual-envelope" });
    const manifestPath = join(root, "spoofed-context.json");
    writeFileSync(manifestPath, JSON.stringify({
      artifact_id: "art_foreign",
      session_id: "ses_foreign",
      type: "context_manifest",
      schema_version: 99,
      content_version: 99,
      created_at: "2020-01-01T00:00:00.000Z",
      producer: { type: "agent", id: "forged" },
      sensitivity: "public",
      parents: ["art_foreign_parent"],
      content_sha256: "f".repeat(64),
      metadata: { forged: true },
      sources: [{ uri: "README.md", kind: "file", reason: "Context", byte_length: 1, included: true }],
      budgets: { max_files: 1, max_bytes: 1000, used_files: 1, used_bytes: 1 },
      gaps: [],
      freshness: "fresh"
    }));

    const result = await importContextManifest({ cwd, env, filePath: manifestPath });
    const runtime = await openAtlasRuntime({ cwd, env });
    try {
      const record = listArtifactsForSession(runtime.db, result.sessionId).find((artifact) => artifact.artifactId === result.contextArtifactId);
      const manifest = JSON.parse(readFileSync(join(runtime.paths.artifactRoot, record?.storageUri ?? ""), "utf8")) as Record<string, any>;
      expect(manifest).toMatchObject({
        artifact_id: result.contextArtifactId,
        session_id: result.sessionId,
        schema_version: 1,
        content_version: 1,
        producer: { type: "user" },
        sensitivity: "confidential",
        parents: [],
        metadata: {}
      });
      expect(manifest.artifact_id).not.toBe("art_foreign");
    } finally {
      closeAtlasRuntime(runtime, false);
    }
  });

  it.each([
    ["secret-sensitive", ".env", "TOKEN=do-not-import\n", "secret-sensitive"],
    ["binary", "asset.bin", Buffer.from([0, 1, 2, 3]), "Binary context source"]
  ] as const)("rejects %s imported context sources", async (_label, sourceName, content, message) => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const env = { ATLAS_HOME: join(root, "home") };
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, sourceName), content);
    await startManualTask({ cwd, env, title: "Unsafe", objective: "Reject unsafe source", taskKey: `manual-${_label}` });
    const manifestPath = join(root, `${_label}-context.json`);
    writeFileSync(manifestPath, JSON.stringify({ sources: [{ uri: sourceName, kind: "file", reason: "Unsafe", byte_length: 1, included: true }] }));

    await expect(importContextManifest({ cwd, env, filePath: manifestPath })).rejects.toThrow(message);
  });
});
