import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type ArtifactFilesystem, sha256Bytes, writeImmutableArtifactContent } from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-artifacts-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("artifact storage", () => {
  it("writes content through a staged path and promotes to an immutable hash path", () => {
    const root = tempRoot();
    const written = writeImmutableArtifactContent({
      rootDir: root,
      sessionId: "ses_1",
      artifactId: "art_1",
      type: "implementation_contract",
      contentVersion: 1,
      mediaType: "text/markdown",
      content: "# Contract\n"
    });

    expect(written.sha256).toBe(sha256Bytes(new TextEncoder().encode("# Contract\n")));
    expect(written.byteLength).toBe(11);
    expect(written.storageUri).toMatch(/^ses_1\/implementation_contract\/1-[a-f0-9]{16}\.md$/);
    expect(readFileSync(written.absolutePath, "utf8")).toBe("# Contract\n");
    expect(existsSync(written.stagedPath)).toBe(false);
  });

  it("is idempotent for the same final content", () => {
    const root = tempRoot();
    const input = {
      rootDir: root,
      sessionId: "ses_1",
      artifactId: "art_1",
      type: "context_manifest",
      contentVersion: 1,
      mediaType: "application/json",
      content: "{}"
    };

    const first = writeImmutableArtifactContent(input);
    const second = writeImmutableArtifactContent({ ...input, artifactId: "art_2" });

    expect(second.absolutePath).toBe(first.absolutePath);
    expect(readFileSync(second.absolutePath, "utf8")).toBe("{}");
  });

  it("rejects unsafe path segments", () => {
    expect(() =>
      writeImmutableArtifactContent({
        rootDir: tempRoot(),
        sessionId: "../escape",
        artifactId: "art_1",
        type: "task_brief",
        contentVersion: 1,
        mediaType: "text/markdown",
        content: "bad"
      })
    ).toThrow("sessionId must be a safe path segment");
  });

  it("leaves staged content available when promotion fails", () => {
    const root = tempRoot();
    const memory = new Map<string, Uint8Array>();
    const failingFs: ArtifactFilesystem = {
      exists: (path) => memory.has(path),
      mkdirp: () => undefined,
      readFile: (path) => {
        const bytes = memory.get(path);
        if (bytes === undefined) throw new Error("missing");
        return bytes;
      },
      writeFile: (path, bytes) => {
        memory.set(path, bytes);
      },
      rename: () => {
        throw new Error("rename failed");
      },
      remove: (path) => {
        memory.delete(path);
      }
    };

    expect(() =>
      writeImmutableArtifactContent({
        rootDir: root,
        sessionId: "ses_1",
        artifactId: "art_1",
        type: "task_brief",
        contentVersion: 1,
        mediaType: "text/markdown",
        content: "staged",
        fs: failingFs
      })
    ).toThrow("rename failed");
    expect([...memory.keys()].some((path) => path.endsWith(".tmp"))).toBe(true);
  });
});
