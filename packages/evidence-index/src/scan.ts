import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

import { CancellationError } from "@atlas/domain";
import { SAFE_SEGMENT_PATTERN, isSafeUriSegments, type EvidenceSensitivity } from "@atlas/schemas";

import type { EvidenceIndexEngineLimits } from "./types.js";

export const excludedDirectories = new Set([
  ".atlas",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target"
]);
export const excludedFileNames = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);
export const includedExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);
export const secretPathPattern =
  /(^|[/\\])(\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_(?:rsa|dsa|ed25519)(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/i;

export interface ScannedFileCandidate {
  readonly uri: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface RepositoryScanResult {
  readonly candidates: readonly ScannedFileCandidate[];
  readonly skippedSymlinks: number;
  readonly skippedUnsafeUris: number;
  readonly truncatedByLimits: boolean;
}

export interface WalkRepositoryOptions {
  readonly rootPath: string;
  readonly limits?: EvidenceIndexEngineLimits | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((filesProcessed: number) => void) | undefined;
}

export function walkRepositoryCandidates(options: WalkRepositoryOptions): RepositoryScanResult {
  const root = resolveRealRoot(options.rootPath);
  const maxDepth = options.limits?.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxFiles = options.limits?.maxFiles ?? Number.POSITIVE_INFINITY;
  const maxBytes = options.limits?.maxBytes ?? Number.POSITIVE_INFINITY;

  const candidates: ScannedFileCandidate[] = [];
  let skippedSymlinks = 0;
  let skippedUnsafeUris = 0;
  let truncatedByLimits = false;
  let totalBytes = 0;

  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    throwIfAborted(options.signal);
    const directory = queue.shift();
    if (directory === undefined) continue;

    const entries = readdirSync(directory.path, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      throwIfAborted(options.signal);
      const entryPath = join(directory.path, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name) && directory.depth + 1 <= maxDepth) {
          queue.push({ path: entryPath, depth: directory.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || excludedFileNames.has(entry.name)) continue;
      if (!includedExtensions.has(extname(entry.name).toLowerCase())) continue;
      if (candidates.length >= maxFiles) {
        truncatedByLimits = true;
        return { candidates, skippedSymlinks, skippedUnsafeUris, truncatedByLimits };
      }

      let stat;
      try {
        stat = statSync(entryPath);
      } catch {
        skippedUnsafeUris += 1;
        continue;
      }
      if (!stat.isFile()) continue;
      if (totalBytes + stat.size > maxBytes) {
        truncatedByLimits = true;
        return { candidates, skippedSymlinks, skippedUnsafeUris, truncatedByLimits };
      }
      totalBytes += stat.size;

      const real = safeContainedRealPath(root, entryPath);
      if (real === undefined) {
        skippedUnsafeUris += 1;
        continue;
      }
      const uri = toPosixUri(relative(root, real));
      if (uri.length === 0 || !isSafeUriSegments(uri)) {
        skippedUnsafeUris += 1;
        continue;
      }

      candidates.push({ uri, absolutePath: real, size: stat.size, mtimeMs: stat.mtimeMs });
      options.onProgress?.(candidates.length);
    }
  }

  return { candidates, skippedSymlinks, skippedUnsafeUris, truncatedByLimits };
}

export interface HashedFileEvidence {
  readonly uri: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly binary: boolean;
  readonly secret: boolean;
  readonly redacted: boolean;
  readonly sensitivity: EvidenceSensitivity;
  readonly category: string;
  readonly excluded: boolean;
  readonly excludedReason?: string | undefined;
}

export function hashAndClassifyFile(rootPath: string, candidate: ScannedFileCandidate): HashedFileEvidence {
  const root = resolveRealRoot(rootPath);
  const lexical = resolve(candidate.absolutePath);
  assertContained(root, lexical);
  const lstat = lstatSync(lexical);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Unsafe symlink source: ${candidate.uri}`);
  }
  const real = realpathSync(lexical);
  assertContained(root, real);
  if (!statSync(real).isFile()) {
    throw new Error(`Evidence source is not a regular file: ${candidate.uri}`);
  }

  const bytes = readFileSync(real);
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const binary = bytes.subarray(0, 8_192).includes(0);
  const secret = secretPathPattern.test(candidate.uri);
  const category = classifyUri(candidate.uri, binary ? undefined : bytes.subarray(0, 2_000));

  return {
    uri: candidate.uri,
    contentSha256,
    byteLength: bytes.byteLength,
    mediaType: binary ? "application/octet-stream" : mediaTypeForExtension(candidate.uri),
    binary,
    secret,
    redacted: secret,
    sensitivity: secret ? "confidential" : "internal",
    category,
    excluded: false
  };
}

function classifyUri(uri: string, contentHead: Buffer | undefined): string {
  const lower = uri.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  if (/^agents\.(override\.)?md$/.test(name)) return "instruction";
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(lower)) return "test";
  if (
    /(^|\/)(adr|adrs|architecture|docs)(\/|$)|(^|\/)readme(?:\.|$)/.test(lower) ||
    (contentHead !== undefined && /^#\s+(architecture|adr|decision)/im.test(contentHead.toString("utf8")))
  ) {
    return "architecture";
  }
  if (/openapi|asyncapi|contract|proto|graphql|\.d\.ts$/.test(lower)) return "contract";
  if (/(^|\/)(schema|schemas)(\/|$)|schema\.[^.]+$/.test(lower)) return "schema";
  if (/(^|\/)(migration|migrations)(\/|$)/.test(lower)) return "migration";
  if (/(^|\/)(runbook|runbooks|ops|operations)(\/|$)|dockerfile|compose\.ya?ml$/.test(lower)) return "operation";
  if (/(^|\/)(package\.json|tsconfig[^/]*\.json|atlas\.config\.json|vite\.config\.|vitest\.config\.|eslint)/.test(lower)) {
    return "config";
  }
  return "source";
}

function mediaTypeForExtension(uri: string): string {
  switch (extname(uri.toLowerCase())) {
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

function safeContainedRealPath(root: string, path: string): string | undefined {
  try {
    const lexical = resolve(path);
    assertContained(root, lexical);
    const real = realpathSync(lexical);
    assertContained(root, real);
    if (!statSync(real).isFile()) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

// Containment checks compare real paths, so the root must be real too. On macOS, temporary and
// some user folders sit behind symlinks (for example /var -> /private/var); comparing a lexical
// root with real file paths would treat every file as escaping the repository.
function resolveRealRoot(rootPath: string): string {
  const lexical = resolve(rootPath);
  try {
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Context path escapes repository root: ${path}`);
  }
}

function toPosixUri(value: string): string {
  return value.replaceAll("\\", "/");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CancellationError("Evidence index build cancelled");
  }
}

export function isSafeEvidenceSegment(segment: string): boolean {
  return SAFE_SEGMENT_PATTERN.test(segment);
}
