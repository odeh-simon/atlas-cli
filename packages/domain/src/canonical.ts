import { createHash } from "node:crypto";

import { PersistenceError } from "./errors.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function deriveId(prefix: string, parts: readonly string[]): string {
  assertSafePrefix(prefix);
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 20)}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalizeRepositoryRootPath(rootPath: string): string {
  let value = rootPath.trim().replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(value)) {
    value = `${value[0]?.toLowerCase() ?? value[0]}${value.slice(1)}`;
  }
  if (value.length > 1) {
    value = value.replace(/\/+$/, "");
  }
  return value;
}

function isAbsoluteRepositoryRootPath(canonicalRootPath: string): boolean {
  return canonicalRootPath.startsWith("/") || /^[A-Za-z]:\//.test(canonicalRootPath);
}

export interface EvidenceRepositoryIdentityInput {
  readonly displayName: string;
  readonly rootPath: string;
  readonly remoteUrl?: string | undefined;
}

export interface DerivedEvidenceRepositoryIdentity {
  readonly repositoryId: string;
  readonly displayName: string;
  readonly rootPathHash: string;
  readonly remoteUrlHash?: string | undefined;
}

export function deriveEvidenceRepositoryIdentity(
  input: EvidenceRepositoryIdentityInput
): DerivedEvidenceRepositoryIdentity {
  const displayName = input.displayName.trim();
  const canonicalRootPath = canonicalizeRepositoryRootPath(input.rootPath);
  if (displayName.length === 0 || canonicalRootPath.length === 0) {
    throw new PersistenceError("Evidence repository identity requires a display name and root path");
  }
  if (!isAbsoluteRepositoryRootPath(canonicalRootPath)) {
    throw new PersistenceError("Evidence repository root path must be absolute", {
      rootPath: input.rootPath,
      canonicalRootPath
    });
  }

  const rootPathHash = createHash("sha256").update(canonicalRootPath, "utf8").digest("hex");
  const remoteUrl = input.remoteUrl?.trim();
  const remoteUrlHash =
    remoteUrl === undefined || remoteUrl.length === 0
      ? undefined
      : createHash("sha256").update(remoteUrl, "utf8").digest("hex");

  return {
    repositoryId: deriveId("evrepo", [rootPathHash]),
    displayName,
    rootPathHash,
    ...(remoteUrlHash === undefined ? {} : { remoteUrlHash })
  };
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortCanonical(item)])
  );
}

function assertSafePrefix(prefix: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) {
    throw new TypeError("deriveId prefix must be alphanumeric");
  }
}
