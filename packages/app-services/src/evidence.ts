import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { sha256Bytes } from "@atlas/artifacts";
import { GateFailedError, ValidationError } from "@atlas/domain";
import type { ArtifactRecord } from "@atlas/persistence";
import { redactSecretText } from "@atlas/security";

export function readVerifiedArtifactText(artifactRoot: string, record: ArtifactRecord): string {
  const bytes = readFileSync(resolve(artifactRoot, record.storageUri));
  if (sha256Bytes(bytes) !== record.sha256) {
    throw new ValidationError(`Artifact hash mismatch: ${record.artifactId}`);
  }
  return bytes.toString("utf8");
}

export function readBoundedRepositorySource(input: {
  readonly rootPath: string;
  readonly uri: string;
  readonly expectedSha256: string;
  readonly maxBytes: number;
}): { readonly content: string; readonly byteLength: number; readonly includedBytes: number; readonly truncated: boolean; readonly redacted: boolean } {
  const source = readSafeRepositorySource({ rootPath: input.rootPath, uri: input.uri });
  const actualSha256 = createHash("sha256").update(source.bytes).digest("hex");
  if (actualSha256 !== input.expectedSha256) {
    throw new GateFailedError("Context source changed after discovery; rebuild context", { uri: input.uri });
  }
  const decoded = source.bytes.toString("utf8");
  const redactedContent = redactSecretText(decoded);
  const redacted = redactedContent !== decoded;
  const boundedBytes = Buffer.from(redactedContent, "utf8").subarray(0, input.maxBytes);
  return {
    content: boundedBytes.toString("utf8"),
    byteLength: source.bytes.byteLength,
    includedBytes: boundedBytes.byteLength,
    truncated: boundedBytes.byteLength < Buffer.byteLength(redactedContent, "utf8"),
    redacted
  };
}

export function readSafeRepositorySource(input: {
  readonly rootPath: string;
  readonly uri: string;
}): { readonly absolutePath: string; readonly bytes: Buffer; readonly sha256: string } {
  if (isSecretRiskPath(input.uri)) {
    throw new GateFailedError("Context source path is secret-sensitive and cannot enter evidence", { uri: input.uri });
  }
  try {
    const lexicalRoot = resolve(input.rootPath);
    const lexicalSource = resolve(lexicalRoot, input.uri);
    assertContained(lexicalRoot, lexicalSource, input.uri);
    const finalEntry = lstatSync(lexicalSource);
    if (finalEntry.isSymbolicLink()) {
      throw new GateFailedError("Context source must not be a symbolic link or reparse-point file", { uri: input.uri });
    }
    const realRoot = realpathSync(lexicalRoot);
    const realSource = realpathSync(lexicalSource);
    assertContained(realRoot, realSource, input.uri);
    if (isSecretRiskPath(relative(realRoot, realSource))) {
      throw new GateFailedError("Context source resolves to a secret-sensitive repository path", { uri: input.uri });
    }
    if (!statSync(realSource).isFile()) {
      throw new GateFailedError("Context source must be a regular file", { uri: input.uri });
    }
    const bytes = readFileSync(realSource);
    if (bytes.includes(0)) {
      throw new GateFailedError("Binary context source cannot enter text evidence", { uri: input.uri });
    }
    return {
      absolutePath: realSource,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } catch (error) {
    if (error instanceof GateFailedError) throw error;
    throw new GateFailedError("Context source cannot be read safely from the repository", { uri: input.uri }, error);
  }
}

function assertContained(root: string, candidate: string, uri: string): void {
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new GateFailedError("Context source escapes the repository root", { uri });
  }
}

export function isSecretRiskPath(path: string): boolean {
  return /(^|[/\\])(\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_(?:rsa|dsa|ed25519)(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/i.test(path);
}
