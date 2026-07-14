# Deliverable F: Adapter Contracts

## Shared Adapter Types

```ts
export type AdapterKind =
  | "linear" | "github" | "figma" | "git" | "coding-agent"
  | "clipboard" | "opener" | "credentials" | "process-runner"
  | "notification" | "filesystem" | "clock";

export type CapabilityStatus = "available" | "unavailable" | "degraded" | "unsupported";

export interface AdapterCapability {
  name: string;
  status: CapabilityStatus;
  version?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface AdapterHealth {
  kind: AdapterKind;
  provider: string;
  status: CapabilityStatus;
  capabilities: AdapterCapability[];
  checkedAt: string;
}

export interface AdapterError {
  kind: "auth" | "rate_limit" | "network" | "not_found" | "validation" | "timeout" | "cancelled" | "unsupported" | "security" | "provider" | "unknown";
  message: string;
  retryable: boolean;
  redactedProviderCode?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface CancellationToken {
  readonly aborted: boolean;
  onAbort(callback: () => void): void;
}
```

All adapters implement `health(): Promise<AdapterHealth>` and must redact secrets from errors. Provider-specific metadata is namespaced under `providerMetadata` and never controls workflow state.

## Linear Adapter

```ts
export interface LinearAdapter {
  health(): Promise<AdapterHealth>;
  getIssue(input: { issueKey: string; includeComments: boolean; timeoutMs: number; signal: CancellationToken }): Promise<LinearIssueSnapshot>;
}
export interface LinearIssueSnapshot {
  provider: "linear";
  issueId: string;
  key: string;
  url: string;
  title: string;
  description?: string;
  status?: string;
  labels: string[];
  comments: Array<{ id: string; body: string; author?: string; createdAt: string }>;
  links: string[];
  fetchedAt: string;
  fieldsAvailable: Record<string, boolean>;
  providerMetadata?: Record<string, unknown>;
}
```

Auth: keychain/env token alias. Retry: safe reads use bounded exponential backoff honoring rate limits. Mocking: fixture JSON snapshots. Example: health checks token identity/scopes, `getIssue` normalizes missing fields explicitly.

## GitHub Adapter

```ts
export interface GitHubAdapter {
  health(): Promise<AdapterHealth>;
  getRepository(input: { owner: string; repo: string; timeoutMs: number; signal: CancellationToken }): Promise<GitHubRepositorySnapshot>;
  getPullRequest(input: { owner: string; repo: string; number: number; timeoutMs: number; signal: CancellationToken }): Promise<GitHubPullRequestSnapshot>;
}
```

Auth: optional token. V1 is read-only. Availability failure degrades remote metadata only. Mocking: recorded API fixtures with secrets stripped.

## Figma Adapter

```ts
export interface FigmaAdapter {
  health(): Promise<AdapterHealth>;
  parseUrl(url: string): FigmaReference;
  getFileMetadata(input: { fileKey: string; nodeIds?: string[]; timeoutMs: number; signal: CancellationToken }): Promise<FigmaMetadataSnapshot>;
}
export interface FigmaReference {
  fileKey: string;
  nodeId?: string;
  canonicalUrl: string;
}
```

Auth: optional token. Timeout: short default with explicit stale/inaccessible result. Security: Figma text is untrusted and treated as content, not instructions.

## Git Adapter

```ts
export interface GitAdapter {
  health(): Promise<AdapterHealth>;
  resolveRepository(path: string): Promise<GitRepositoryFacts>;
  status(repoRoot: string): Promise<GitStatus>;
  revParse(repoRoot: string, ref: string): Promise<string>;
  listBranches(repoRoot: string): Promise<GitBranch[]>;
  createBranch(input: { repoRoot: string; branchName: string; startPoint: string; checkout: boolean }): Promise<GitBranchResult>;
  diffSummary(input: GitDiffInput): Promise<GitDiffSummary>;
  boundedPatch(input: GitDiffInput & { maxBytes: number }): Promise<GitPatchResult>;
}
```

Blocked methods are intentionally absent: reset, force checkout, force push, merge, rebase, delete branch, stash, discard. Implementation uses direct `git` executable with args. Mocking: temp repos with fixture states.

## Coding-Agent Adapter

```ts
export type AgentKind = "claude" | "codex" | "manual";

export interface CodingAgentAdapter {
  kind: AgentKind;
  health(): Promise<AdapterHealth>;
  detectVersion(): Promise<{ executable: string; version: string; supported: boolean; reason?: string }>;
  formatPackage(input: AgentPackageInput): Promise<FormattedAgentPackage>;
  invoke(input: AgentInvokeInput): Promise<AgentInvokeResult>;
}

export interface AgentInvokeInput {
  runId: string;
  repoRoot: string;
  packagePath: string;
  mode: "implement" | "fix";
  timeoutMs?: number;
  environment: Record<string, string>;
  signal: CancellationToken;
}

export interface AgentInvokeResult {
  processStatus: "succeeded" | "failed" | "cancelled" | "timeout" | "interrupted" | "unknown";
  exitCode?: number;
  startedAt: string;
  endedAt: string;
  stdoutLogArtifactId?: string;
  stderrLogArtifactId?: string;
  completionReportArtifactId?: string;
  providerMetadata?: Record<string, unknown>;
}
```

Cancellation: cooperative adapter-specific signal first, then owned process termination. Security: receives bounded approved package only. Idempotency: each invocation is a distinct run; manual export is idempotent for same inputs.

## Claude Code Adapter

Implements `CodingAgentAdapter` with `kind: "claude"`. Version detection runs documented CLI version command. Invocation mode must be selected from tested capability matrix. If version unsupported, Atlas blocks direct invocation and offers manual export.

## Codex Adapter

Implements `CodingAgentAdapter` with `kind: "codex"`. Uses same normalized package. Provider session IDs, if available, are stored only in `providerMetadata`. Unsupported or missing Codex CLI degrades to manual export.

## Clipboard Adapter

```ts
export interface ClipboardAdapter {
  health(): Promise<AdapterHealth>;
  writeText(input: { text: string; timeoutMs: number }): Promise<{ copied: boolean; error?: AdapterError }>;
  readText?(input: { timeoutMs: number }): Promise<{ text: string }>;
}
```

Read is optional and must never be required for V1. Clipboard failures never fail artifact generation.

## Application Opener

```ts
export interface ApplicationOpener {
  health(): Promise<AdapterHealth>;
  open(input: { target: string; kind: "url" | "file" | "application"; timeoutMs: number }): Promise<{ opened: boolean }>;
}
```

Security: validates URL scheme allowlist (`https`, configured app protocols). Unsafe URL opening is blocked.

## Secure Credential Store

```ts
export interface SecureCredentialStore {
  health(): Promise<AdapterHealth>;
  set(alias: string, secret: string): Promise<void>;
  get(alias: string): Promise<string | undefined>;
  delete(alias: string): Promise<{ deleted: boolean }>;
  describe(alias: string): Promise<{ exists: boolean; backend: string }>;
}
```

Secrets never returned to output layers. Environment variable references are resolved at use time and never persisted as values.

## Local Process Runner

```ts
export interface LocalProcessRunner {
  run(input: ProcessRunInput): Promise<ProcessRunResult>;
}
export interface ProcessRunInput {
  commandId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  pty: boolean;
  redact: RedactionRule[];
  signal: CancellationToken;
}
```

No shell by default. Shell-mode requires explicit config and audit event.

## Notification Adapter

```ts
export interface NotificationAdapter {
  health(): Promise<AdapterHealth>;
  notify(input: { title: string; body: string; sensitivity: "generic"; timeoutMs: number }): Promise<{ delivered: boolean }>;
}
```

Notifications never include issue content, code, secrets, sensitive filenames, or diffs by default. Failure is non-blocking.

## Filesystem Adapter

```ts
export interface FilesystemAdapter {
  readFile(path: string, maxBytes?: number): Promise<Uint8Array>;
  writeFileAtomic(path: string, bytes: Uint8Array): Promise<void>;
  renameAtomic(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  realpath(path: string): Promise<string>;
  mkdirp(path: string): Promise<void>;
}
```

Security: canonicalizes paths, checks root containment, detects symlinks for sensitive writes, and applies user-only permissions where supported.

## Clock Provider

```ts
export interface Clock {
  now(): Date;
  isoNow(): string;
  monotonicMs(): number;
}
```

Used for deterministic tests, lock expiry, TTLs, duration recording, and migration fixtures.

## Adapter Operational Matrix

| Adapter | Auth | Timeout | Retry | Cancellation | Idempotency | Security boundary | Mocking strategy | Example flow |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Linear | Keychain/env token alias | Per read, default 15s | Safe GET retries with rate-limit backoff | Abort HTTP request | Reads are idempotent by issue key/fetched_at | Issue text untrusted | Fixture snapshots and fake server | health -> getIssue -> normalize -> snapshot artifact |
| GitHub | Optional keychain/env token alias | Default 15s | Safe GET retries | Abort HTTP request | Reads idempotent by owner/repo/ref | Remote facts supplemental | Fixture snapshots | health -> get PR/repo -> label fetched_at -> artifact |
| Figma | Optional keychain/env token alias | Default 15s | Safe metadata retries | Abort HTTP request | Reads idempotent by file/node/fetched_at | Design text untrusted | Fixture files/nodes | parseUrl -> fetch metadata -> record limitations |
| Git | No network auth for local facts | Short command timeouts | No automatic retry for mutations | Terminate owned git process | Reads idempotent by repo/ref; branch create not retried without verification | Repo hooks/files untrusted | Temp repos | resolve repo -> status/ref/diff -> safety facts |
| Coding agent | Local executable; optional env secrets | Configured, long-running | No auto retry after launch | Cooperative then owned process terminate | New run per invocation | Agent output untrusted | Fake adapter/process | health -> format package -> invoke -> report result |
| Claude Code | Local CLI | Adapter-configured | Availability retry only | Adapter-specific | New run per invocation | Provider metadata namespaced | Fake CLI fixture | detect version -> supported mode -> process runner |
| Codex | Local CLI | Adapter-configured | Availability retry only | Adapter-specific | New run per invocation | Provider metadata namespaced | Fake CLI fixture | detect version -> supported mode -> process runner |
| Clipboard | OS clipboard | 2s | No | Best effort | Same text can be copied repeatedly | Clipboard may be observed by OS/user apps | In-memory clipboard | write text -> report copied/failure |
| Opener | None | 5s | No | Best effort | Re-opening target has external side effects; not used for gates | URL scheme allowlist | Fake opener | validate target -> open -> non-blocking result |
| Credential store | OS user auth/keychain | 5s | No blind retry | Abort where backend allows | set/delete explicit; get read-only | Secret values never logged | Memory keychain | set alias -> describe -> get for adapter use |
| Process runner | None; env constructed by caller | Required | No auto retry | Graceful then terminate owned tree | Each command result unique | Child process untrusted | Fake runner | spawn -> redact stream -> logs -> normalized result |
| Notification | OS notification permission | 2s | No | Best effort | Non-blocking duplicate allowed | Generic content only | Fake notifier | notify generic status -> ignore failure |
| Filesystem | OS user permissions | Operation-specific | No unsafe retry | n/a | Atomic write by temp+rename | Paths canonicalized; symlink checks | Temp FS | realpath -> containment -> write atomic |
| Clock | None | n/a | n/a | n/a | Deterministic in tests | Time is injected, not global | Fake clock | now/monotonic used by locks/events |
