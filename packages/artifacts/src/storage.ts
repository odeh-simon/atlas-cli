import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";

import { ArtifactIntegrityError } from "@sigil/domain";

export interface ArtifactFilesystem {
  readonly exists: (path: string) => boolean;
  readonly mkdirp: (path: string) => void;
  readonly readFile: (path: string) => Uint8Array;
  readonly writeFile: (path: string, bytes: Uint8Array) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

export const nodeArtifactFilesystem: ArtifactFilesystem = {
  exists: existsSync,
  mkdirp(path) {
    mkdirSync(path, { recursive: true });
  },
  readFile: readFileSync,
  writeFile: writeFileSync,
  rename: renameSync,
  remove(path) {
    rmSync(path, { force: true });
  }
};

export interface WriteArtifactContentInput {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly type: string;
  readonly contentVersion: number;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
  readonly extension?: string | undefined;
  readonly fs?: ArtifactFilesystem | undefined;
}

export interface WrittenArtifactContent {
  readonly storageUri: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly stagedPath: string;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function writeImmutableArtifactContent(input: WriteArtifactContentInput): WrittenArtifactContent {
  assertSafeSegment(input.sessionId, "sessionId");
  assertSafeSegment(input.artifactId, "artifactId");
  assertSafeSegment(input.type, "type");
  assertPositiveInteger(input.contentVersion, "contentVersion");

  const fs = input.fs ?? nodeArtifactFilesystem;
  const rootDir = resolve(input.rootDir);
  const bytes = artifactBytes(input.content);
  const sha256 = sha256Bytes(bytes);
  const extension = normalizeExtension(input.extension ?? extensionForMediaType(input.mediaType));
  const finalPath = resolve(
    rootDir,
    input.sessionId,
    input.type,
    `${input.contentVersion}-${sha256.slice(0, 16)}${extension}`
  );
  const stagedPath = resolve(rootDir, ".staging", input.sessionId, `${input.artifactId}-${sha256.slice(0, 16)}.tmp`);

  assertInsideRoot(rootDir, finalPath);
  assertInsideRoot(rootDir, stagedPath);

  fs.mkdirp(dirname(stagedPath));
  fs.mkdirp(dirname(finalPath));
  fs.writeFile(stagedPath, bytes);

  if (fs.exists(finalPath)) {
    const existingHash = sha256Bytes(fs.readFile(finalPath));
    fs.remove(stagedPath);
    if (existingHash !== sha256) {
      throw new ArtifactIntegrityError("Artifact final path exists with different content", {
        finalPath,
        expectedSha256: sha256,
        actualSha256: existingHash
      });
    }

    return {
      storageUri: toStorageUri(rootDir, finalPath),
      absolutePath: finalPath,
      sha256,
      byteLength: bytes.byteLength,
      stagedPath
    };
  }

  fs.rename(stagedPath, finalPath);

  return {
    storageUri: toStorageUri(rootDir, finalPath),
    absolutePath: finalPath,
    sha256,
    byteLength: bytes.byteLength,
    stagedPath
  };
}

export interface WrittenContentAddressedBlob {
  readonly namespace: string;
  readonly storageUri: string;
  readonly absolutePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export function writeContentAddressedBlob(
  rootDir: string,
  namespace: string,
  bytes: Uint8Array,
  fs: ArtifactFilesystem = nodeArtifactFilesystem
): WrittenContentAddressedBlob {
  assertSafeSegment(namespace, "namespace");

  const root = resolve(rootDir);
  const sha256 = sha256Bytes(bytes);
  const finalPath = resolve(root, namespace, sha256);
  const stagedPath = resolve(root, ".staging", namespace, `${sha256.slice(0, 16)}.tmp`);

  assertInsideRoot(root, finalPath);
  assertInsideRoot(root, stagedPath);

  fs.mkdirp(dirname(finalPath));
  fs.mkdirp(dirname(stagedPath));
  fs.writeFile(stagedPath, bytes);

  if (fs.exists(finalPath)) {
    const existingHash = sha256Bytes(fs.readFile(finalPath));
    fs.remove(stagedPath);
    if (existingHash !== sha256) {
      throw new ArtifactIntegrityError("Content-addressed blob path exists with different content", {
        finalPath,
        expectedSha256: sha256,
        actualSha256: existingHash
      });
    }
  } else {
    fs.rename(stagedPath, finalPath);
  }

  return {
    namespace,
    storageUri: `${namespace}/${sha256}`,
    absolutePath: finalPath,
    sha256,
    byteLength: bytes.byteLength
  };
}

export function readVerifiedBlob(
  rootDir: string,
  storageUri: string,
  fs: ArtifactFilesystem = nodeArtifactFilesystem
): Uint8Array {
  const segments = storageUri.split("/");
  if (segments.length !== 2) {
    throw new TypeError("Blob storage URI must be <namespace>/<sha256>");
  }

  const [namespace, digest] = segments;
  if (namespace === undefined || digest === undefined) {
    throw new TypeError("Blob storage URI must be <namespace>/<sha256>");
  }
  assertSafeSegment(namespace, "namespace");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError("Blob digest must be a lowercase SHA-256 hex string");
  }

  const root = resolve(rootDir);
  const path = resolve(root, namespace, digest);
  assertInsideRoot(root, path);

  if (!fs.exists(path)) {
    throw new ArtifactIntegrityError("Content-addressed blob does not exist", { path });
  }

  const bytes = fs.readFile(path);
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== digest) {
    throw new ArtifactIntegrityError("Content-addressed blob failed integrity verification", {
      path,
      expectedSha256: digest,
      actualSha256
    });
  }

  return bytes;
}

function extensionForMediaType(mediaType: string): string {
  if (mediaType === "application/json") {
    return ".json";
  }

  if (mediaType === "text/markdown") {
    return ".md";
  }

  if (mediaType.startsWith("text/")) {
    return ".txt";
  }

  return ".bin";
}

function normalizeExtension(extension: string): string {
  const value = extension.trim();
  if (value.length === 0) {
    return ".bin";
  }

  const normalized = value.startsWith(".") ? value : `.${value}`;
  if (extname(`file${normalized}`) !== normalized || normalized.includes("/") || normalized.includes("\\")) {
    throw new TypeError("Artifact extension must be a simple file extension");
  }

  return normalized;
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) {
    throw new TypeError(`${label} must be a safe path segment`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

function assertInsideRoot(rootDir: string, path: string): void {
  if (path !== rootDir && !path.startsWith(`${rootDir}${sep}`)) {
    throw new ArtifactIntegrityError("Artifact path escaped storage root", { rootDir, path });
  }
}

function toStorageUri(rootDir: string, path: string): string {
  return path.slice(rootDir.length + 1).replaceAll("\\", "/");
}
