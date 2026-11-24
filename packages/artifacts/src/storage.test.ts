import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactIntegrityError } from "@sigil/domain";

import { type ArtifactFilesystem, readVerifiedBlob, sha256Bytes, writeContentAddressedBlob, writeImmutableArtifactContent } from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-artifacts-"));
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

describe("content-addressed blob storage", () => {
  it("writes a blob under namespace/sha256 and returns a root-relative storage URI", () => {
    const root = tempRoot();
    const bytes = new TextEncoder().encode("evidence payload");
    const digest = sha256Bytes(bytes);

    const written = writeContentAddressedBlob(root, "evidence-blobs", bytes);

    expect(written.sha256).toBe(digest);
    expect(written.byteLength).toBe(bytes.byteLength);
    expect(written.storageUri).toBe(`evidence-blobs/${digest}`);
    expect(written.absolutePath).toBe(join(root, "evidence-blobs", digest));
    expect(readFileSync(written.absolutePath).equals(bytes)).toBe(true);
  });

  it("is idempotent when the same content is promoted twice", () => {
    const root = tempRoot();
    const bytes = new TextEncoder().encode("idempotent");

    const first = writeContentAddressedBlob(root, "blobs", bytes);
    const second = writeContentAddressedBlob(root, "blobs", bytes);

    expect(second.absolutePath).toBe(first.absolutePath);
    expect(existsSync(first.absolutePath)).toBe(true);
  });

  it("rejects promotion when an existing path holds different bytes after corruption", () => {
    const root = tempRoot();
    const bytes = new TextEncoder().encode("original");
    const written = writeContentAddressedBlob(root, "blobs", bytes);

    writeFileSync(join(root, "blobs", written.sha256), "corrupted-on-disk");

    expect(() => writeContentAddressedBlob(root, "blobs", bytes)).toThrowError(ArtifactIntegrityError);
    expect(readFileSync(join(root, "blobs", written.sha256), "utf8")).toBe("corrupted-on-disk");
  });

  it("re-verifies the hash when reading a blob back", async () => {
    const root = tempRoot();
    const written = writeContentAddressedBlob(root, "blobs", new TextEncoder().encode("verified"));

    expect(new TextDecoder().decode(readVerifiedBlob(root, written.storageUri))).toBe("verified");

    writeFileSync(join(root, "blobs", written.sha256), "corrupted");
    expect(() => readVerifiedBlob(root, written.storageUri)).toThrowError(
      ArtifactIntegrityError
    );
  });

  it("refuses unsafe namespaces and malformed storage URIs", () => {
    const root = tempRoot();

    expect(() => writeContentAddressedBlob(root, "../escape", new TextEncoder().encode("x"))).toThrow(
      "namespace must be a safe path segment"
    );
    expect(() => readVerifiedBlob(root, "only-namespace")).toThrow("<namespace>/<sha256>");
    expect(() => readVerifiedBlob(root, "blobs/../secret")).toThrow("<namespace>/<sha256>");
    expect(() => readVerifiedBlob(root, "blobs/not-a-digest")).toThrow("lowercase SHA-256 hex string");
    expect(() => readVerifiedBlob(root, `blobs/${"a".repeat(63)}`)).toThrow("lowercase SHA-256 hex string");
  });

  it("reports a missing blob as an integrity failure", () => {
    const root = tempRoot();

    expect(() => readVerifiedBlob(root, `blobs/${"a".repeat(64)}`)).toThrowError(
      ArtifactIntegrityError
    );
  });
});
