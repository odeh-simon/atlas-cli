import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Bytes } from "@atlas/artifacts";
import {
  getActiveLock,
  listArtifactsForSession,
  listSessionsForRepository,
  type ArtifactRecord,
  type LockRecord
} from "@atlas/persistence";
import { hasCredential, type CredentialProvider } from "@atlas/security";

import { closeAtlasRuntime, openAtlasRuntime, repoIdForPath, type RuntimeOptions } from "./runtime.js";

export interface DoctorIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly summary: string;
  readonly recovery: string;
}

export interface DoctorResult {
  readonly status: "passed" | "failed";
  readonly sessionId: string | undefined;
  readonly artifactCount: number;
  readonly issues: readonly DoctorIssue[];
}

export async function runDoctor(options: RuntimeOptions = {}): Promise<DoctorResult> {
  const runtime = await openAtlasRuntime(options);
  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      return { status: "passed", sessionId: undefined, artifactCount: 0, issues: [] };
    }

    const issues: DoctorIssue[] = [];
    const artifacts = listArtifactsForSession(runtime.db, session.sessionId);
    for (const artifact of artifacts) {
      issues.push(...inspectArtifact(runtime.paths.artifactRoot, artifact));
    }
    for (const lock of [
      getActiveLock(runtime.db, "project", repoId),
      getActiveLock(runtime.db, "session", session.sessionId)
    ]) {
      if (lock !== undefined) issues.push(...inspectLock(lock, new Date()));
    }
    issues.push(...inspectConfiguredCredentialAliases(runtime.paths.cwd, options.env));

    return {
      status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
      sessionId: session.sessionId,
      artifactCount: artifacts.length,
      issues
    };
  } finally {
    closeAtlasRuntime(runtime, false);
  }
}

function inspectConfiguredCredentialAliases(cwd: string, env: NodeJS.ProcessEnv | undefined): DoctorIssue[] {
  const configPath = join(cwd, "atlas.config.json");
  if (!existsSync(configPath)) return [];
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    adapters?: Partial<Record<CredentialProvider, { tokenAlias?: unknown }>>;
  };
  const issues: DoctorIssue[] = [];
  for (const provider of ["figma", "github", "linear"] as const) {
    const tokenAlias = config.adapters?.[provider]?.tokenAlias;
    if (typeof tokenAlias !== "string" || tokenAlias.length === 0) continue;
    if (!hasCredential({ env, alias: tokenAlias, provider })) {
      issues.push({
        severity: "warning",
        code: "credential.missing",
        summary: `Configured ${provider} credential alias is missing: ${tokenAlias}`,
        recovery: `Run atlas auth add --provider ${provider} --alias ${tokenAlias} --value-env <ENV_VAR>.`
      });
    }
  }
  return issues;
}

function inspectArtifact(artifactRoot: string, artifact: ArtifactRecord): DoctorIssue[] {
  const path = join(artifactRoot, artifact.storageUri);
  if (!existsSync(path)) {
    return [
      {
        severity: "error",
        code: "artifact.missing",
        summary: `Artifact file is missing: ${artifact.artifactId}`,
        recovery: "Restore the artifact from backup or rerun the transition that produced it."
      }
    ];
  }

  const bytes = readFileSync(path);
  const issues: DoctorIssue[] = [];
  if (bytes.byteLength !== artifact.byteLength) {
    issues.push({
      severity: "error",
      code: "artifact.byte_length_mismatch",
      summary: `Artifact byte length mismatch: ${artifact.artifactId}`,
      recovery: "Treat dependent workflow state as stale and restore the recorded artifact bytes from backup."
    });
  }
  if (sha256Bytes(bytes) !== artifact.sha256) {
    issues.push({
      severity: "error",
      code: "artifact.hash_mismatch",
      summary: `Artifact hash mismatch: ${artifact.artifactId}`,
      recovery: "Do not approve completion from this state; restore the artifact or regenerate downstream artifacts."
    });
  }
  return issues;
}

function inspectLock(lock: LockRecord, now: Date): DoctorIssue[] {
  if (Date.parse(lock.expiresAt) > now.getTime()) return [];
  return [
    {
      severity: "warning",
      code: "lock.stale",
      summary: `Active ${lock.scope} lock is expired: ${lock.lockId}`,
      recovery: "If no Atlas process is running, release the stale lock before continuing."
    }
  ];
}
