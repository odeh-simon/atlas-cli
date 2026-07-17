import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const securityPackage = "@atlas/security";

export type CredentialProvider = "figma" | "github" | "linear" | "ai";

export interface CredentialStoreOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface CredentialRecord {
  readonly alias: string;
  readonly provider: CredentialProvider;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredCredentialRecord extends CredentialRecord {
  readonly tokenBase64: string;
}

interface CredentialStoreFile {
  readonly version: 1;
  readonly credentials: readonly StoredCredentialRecord[];
}

export interface StoreCredentialInput extends CredentialStoreOptions {
  readonly alias: string;
  readonly provider: CredentialProvider;
  readonly token: string;
  readonly now?: Date | undefined;
}

export function storeCredential(input: StoreCredentialInput): CredentialRecord {
  assertAlias(input.alias);
  assertToken(input.token);
  const now = (input.now ?? new Date()).toISOString();
  const store = readStore(input);
  const prior = store.credentials.find((credential) => credential.alias === input.alias);
  const record: StoredCredentialRecord = {
    alias: input.alias,
    provider: input.provider,
    tokenHash: hashToken(input.token),
    tokenBase64: Buffer.from(input.token, "utf8").toString("base64"),
    createdAt: prior?.createdAt ?? now,
    updatedAt: now
  };
  writeStore(input, {
    version: 1,
    credentials: [...store.credentials.filter((credential) => credential.alias !== input.alias), record].sort((a, b) =>
      a.alias.localeCompare(b.alias)
    )
  });
  return publicRecord(record);
}

export function removeCredential(options: CredentialStoreOptions & { readonly alias: string }): boolean {
  assertAlias(options.alias);
  const store = readStore(options);
  const next = store.credentials.filter((credential) => credential.alias !== options.alias);
  if (next.length === store.credentials.length) return false;
  writeStore(options, { version: 1, credentials: next });
  return true;
}

export function listCredentials(options: CredentialStoreOptions = {}): CredentialRecord[] {
  return readStore(options).credentials.map(publicRecord);
}

export function getCredentialToken(
  options: CredentialStoreOptions & { readonly alias: string; readonly provider?: CredentialProvider | undefined }
): string | undefined {
  assertAlias(options.alias);
  const record = readStore(options).credentials.find((credential) => credential.alias === options.alias);
  if (record === undefined) return undefined;
  if (options.provider !== undefined && record.provider !== options.provider) return undefined;
  return Buffer.from(record.tokenBase64, "base64").toString("utf8");
}

export function hasCredential(
  options: CredentialStoreOptions & { readonly alias: string; readonly provider?: CredentialProvider | undefined }
): boolean {
  return getCredentialToken(options) !== undefined;
}

export function redactSecretText(value: string): string {
  return value.replace(/(?:pat|ghp|gho|figd|lin|sk)_[A-Za-z0-9_=-]{8,}|[A-Za-z0-9_=-]{24,}/g, "[REDACTED]");
}

export function credentialStorePath(options: CredentialStoreOptions = {}): string {
  const env = options.env ?? process.env;
  return join(resolve(env.ATLAS_HOME ?? defaultDataRoot()), "credentials.json");
}

function readStore(options: CredentialStoreOptions): CredentialStoreFile {
  const path = credentialStorePath(options);
  if (!existsSync(path)) return { version: 1, credentials: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialStoreFile>;
  return {
    version: 1,
    credentials: Array.isArray(raw.credentials) ? raw.credentials.filter(isStoredCredentialRecord) : []
  };
}

function writeStore(options: CredentialStoreOptions, store: CredentialStoreFile): void {
  const path = credentialStorePath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function publicRecord(record: StoredCredentialRecord): CredentialRecord {
  return {
    alias: record.alias,
    provider: record.provider,
    tokenHash: record.tokenHash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function assertAlias(alias: string): void {
  if (!/^[A-Za-z0-9_.:-]+$/.test(alias)) {
    throw new TypeError("Credential alias must contain only letters, numbers, dot, underscore, colon, or dash");
  }
}

function assertToken(token: string): void {
  if (token.trim().length < 8) {
    throw new TypeError("Credential token must be at least 8 characters");
  }
}

function isStoredCredentialRecord(value: unknown): value is StoredCredentialRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.alias === "string" &&
    (record.provider === "figma" || record.provider === "github" || record.provider === "linear" || record.provider === "ai") &&
    typeof record.tokenHash === "string" &&
    typeof record.tokenBase64 === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function defaultDataRoot(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Atlas");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Atlas");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "atlas");
}
