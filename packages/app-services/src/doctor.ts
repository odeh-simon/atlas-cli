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

import {
  closeAtlasRuntime,
  openAtlasRuntime,
  repoIdForPath,
  resolveAtlasPaths,
  type RuntimeOptions
} from "./runtime.js";

export interface DoctorIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly summary: string;
  readonly recovery: string;
}

export interface DoctorResult {
  readonly status: "passed" | "failed";
  readonly runtimeVersion: string;
  readonly dataRoot: string;
  readonly sessionId: string | undefined;
  readonly artifactCount: number;
  readonly issues: readonly DoctorIssue[];
}

export interface DoctorOptions extends RuntimeOptions {
  readonly runtimeVersion?: string | undefined;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const paths = resolveAtlasPaths(options);
  const runtimeVersion = options.runtimeVersion ?? process.versions.node;
  const issues: DoctorIssue[] = [
    ...inspectRuntimeVersion(runtimeVersion),
    ...inspectRecoveryFiles(paths.dbPath),
    ...inspectConfiguredCredentialAliases(paths.cwd, options.env)
  ];
  if (issues.some((issue) => issue.code === "storage.interrupted_write")) {
    return doctorResult({ runtimeVersion, dataRoot: paths.dataRoot, issues });
  }

  let runtime;
  try {
    runtime = await openAtlasRuntime(options);
  } catch {
    issues.push({
      severity: "error",
      code: "storage.open_failed",
      summary: "Atlas could not open or migrate its local data store",
      recovery: `Keep the current files intact, inspect backups under ${paths.backupDirectory}, and restore the newest known-good database before retrying.`
    });
    return doctorResult({ runtimeVersion, dataRoot: paths.dataRoot, issues });
  }

  try {
    const repoId = repoIdForPath(runtime.paths.cwd);
    const session = listSessionsForRepository(runtime.db, repoId)[0];
    if (session === undefined) {
      return doctorResult({ runtimeVersion, dataRoot: paths.dataRoot, issues });
    }

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
    return doctorResult({
      runtimeVersion,
      dataRoot: paths.dataRoot,
      sessionId: session.sessionId,
      artifactCount: artifacts.length,
      issues
    });
  } finally {
    closeAtlasRuntime(runtime, false);
  }
}

function doctorResult(input: {
  readonly runtimeVersion: string;
  readonly dataRoot: string;
  readonly sessionId?: string | undefined;
  readonly artifactCount?: number | undefined;
  readonly issues: readonly DoctorIssue[];
}): DoctorResult {
  return {
    status: input.issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    runtimeVersion: input.runtimeVersion,
    dataRoot: input.dataRoot,
    sessionId: input.sessionId,
    artifactCount: input.artifactCount ?? 0,
    issues: input.issues
  };
}

function inspectRuntimeVersion(version: string): DoctorIssue[] {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isInteger(major) && major >= 22) return [];
  return [
    {
      severity: "error",
      code: "runtime.unsupported_node",
      summary: `Node.js ${version} is unsupported; Atlas requires Node.js 22 or newer`,
      recovery: "Install or activate Node.js 22+, rebuild Atlas, and rerun atlas doctor."
    }
  ];
}

function inspectRecoveryFiles(dbPath: string): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  if (existsSync(`${dbPath}.tmp`)) {
    issues.push({
      severity: "error",
      code: "storage.interrupted_write",
      summary: "An interrupted database write file is present",
      recovery: "Confirm no Atlas process is running, preserve the .tmp file, and rerun doctor before deciding whether recovery is required."
    });
  }
  if (existsSync(`${dbPath}.failed`)) {
    issues.push({
      severity: "warning",
      code: "storage.failed_migration_preserved",
      summary: "A failed pre-restore database image is preserved",
      recovery: "Keep the .failed file for diagnosis and verify the restored database and latest backup before removing it."
    });
  }
  return issues;
}

function inspectConfiguredCredentialAliases(cwd: string, env: NodeJS.ProcessEnv | undefined): DoctorIssue[] {
  const configPath = join(cwd, "atlas.config.json");
  if (!existsSync(configPath)) return [];
  let config: DoctorConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as DoctorConfig;
  } catch {
    return [
      {
        severity: "error",
        code: "config.invalid_json",
        summary: "atlas.config.json is not valid JSON",
        recovery: "Fix the JSON syntax or restore atlas.config.json from version control."
      }
    ];
  }
  const issues: DoctorIssue[] = [];
  const aiProviders = Array.isArray(config.ai?.providers) ? config.ai.providers : [];
  if (config.ai?.providers !== undefined && !Array.isArray(config.ai.providers)) {
    issues.push({
      severity: "error",
      code: "config.ai_providers_invalid",
      summary: "ai.providers must be an array",
      recovery: "Replace ai.providers with an array of provider configuration objects."
    });
  }
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
  for (const aiProvider of aiProviders) {
    const tokenAlias = aiProvider.tokenAlias;
    if (typeof tokenAlias !== "string" || tokenAlias.length === 0) continue;
    if (!hasCredential({ env, alias: tokenAlias, provider: "ai" })) {
      issues.push({
        severity: "warning",
        code: "credential.missing",
        summary: `Configured AI credential alias is missing: ${tokenAlias}`,
        recovery: `Run atlas auth add --provider ai --alias ${tokenAlias} --value-env <ENV_VAR>.`
      });
    }
  }
  const providerAliases = aiProviders.flatMap((provider) =>
    typeof provider.alias === "string" && provider.alias.length > 0 ? [provider.alias] : []
  );
  const duplicateAliases = providerAliases.filter((alias, index) => providerAliases.indexOf(alias) !== index);
  for (const alias of [...new Set(duplicateAliases)]) {
    issues.push({
      severity: "error",
      code: "config.duplicate_ai_provider",
      summary: `AI provider alias is configured more than once: ${alias}`,
      recovery: "Keep exactly one provider entry for each AI alias."
    });
  }
  if (
    typeof config.ai?.defaultProviderAlias === "string" &&
    !providerAliases.includes(config.ai.defaultProviderAlias)
  ) {
    issues.push({
      severity: "error",
      code: "config.ai_default_missing",
      summary: `Default AI provider is not configured: ${config.ai.defaultProviderAlias}`,
      recovery: "Add the matching provider entry or change ai.defaultProviderAlias to an existing alias."
    });
  }
  if (
    aiProviders.some((provider) => provider.provider === "openai-compatible") &&
    config.ai?.allowCloudCodeContext !== true
  ) {
    issues.push({
      severity: "warning",
      code: "cloud.code_context_disabled",
      summary: "Cloud AI is configured, but repository context transmission is disabled",
      recovery: "Leave this disabled for local-only operation, or explicitly set ai.allowCloudCodeContext to true after reviewing the provider policy."
    });
  }
  if (
    aiProviders.some(
      (provider) => Array.isArray(provider.capabilities) && provider.capabilities.includes("vision")
    ) &&
    config.ai?.allowCloudImages !== true
  ) {
    issues.push({
      severity: "warning",
      code: "cloud.images_disabled",
      summary: "A vision-capable cloud AI provider is configured, but image transmission is disabled",
      recovery: "Leave this disabled when visual evidence must remain local, or explicitly set ai.allowCloudImages to true after reviewing the provider policy."
    });
  }
  return issues;
}

interface DoctorConfig {
  readonly adapters?: Partial<Record<CredentialProvider, { readonly tokenAlias?: unknown }>>;
  readonly ai?: {
    readonly defaultProviderAlias?: unknown;
    readonly allowCloudCodeContext?: unknown;
    readonly allowCloudImages?: unknown;
    readonly providers?: readonly {
      readonly alias?: unknown;
      readonly provider?: unknown;
      readonly tokenAlias?: unknown;
      readonly capabilities?: unknown;
    }[];
  };
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
