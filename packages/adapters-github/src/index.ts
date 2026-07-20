import { readFileSync } from "node:fs";

export const adaptersGithubPackage = "@atlas/adapters-github";

export interface GitHubAdapterHealth {
  readonly provider: "github";
  readonly configured: boolean;
  readonly writable: boolean;
  readonly capabilities: readonly ["health", "parseReference", "readFixture", "commentPullRequest"];
  readonly mode: "fixture" | "api-token-present";
}

export type GitHubReferenceKind = "repository" | "pull_request" | "issue";

export interface GitHubReference {
  readonly kind: GitHubReferenceKind;
  readonly owner: string;
  readonly repo: string;
  readonly number?: number | undefined;
  readonly url: string;
}

export interface GitHubPullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly state?: string | undefined;
  readonly headRef?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly url?: string | undefined;
}

export interface GitHubRepositorySnapshot {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch?: string | undefined;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly pullRequests: readonly GitHubPullRequestSnapshot[];
}

export interface FetchGitHubRepositoryInput {
  readonly token: string;
  readonly reference: GitHubReference;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface CommentGitHubPullRequestInput {
  readonly token: string;
  readonly reference: GitHubReference;
  readonly body: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface GitHubWritebackResult {
  readonly provider: "github";
  readonly target: string;
  readonly status: "written";
  readonly remoteUrl?: string | undefined;
}

export function getGitHubAdapterHealth(input: { readonly token?: string | undefined } = {}): GitHubAdapterHealth {
  return {
    provider: "github",
    configured: typeof input.token === "string" && input.token.length > 0,
    writable: typeof input.token === "string" && input.token.length > 0,
    capabilities: ["health", "parseReference", "readFixture", "commentPullRequest"],
    mode: typeof input.token === "string" && input.token.length > 0 ? "api-token-present" : "fixture"
  };
}

export async function commentGitHubPullRequest(input: CommentGitHubPullRequestInput): Promise<GitHubWritebackResult> {
  if (input.reference.kind !== "pull_request" || input.reference.number === undefined) {
    throw new TypeError("GitHub writeback requires a pull request reference");
  }
  if (input.body.trim().length === 0) {
    throw new TypeError("GitHub comment body is required");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://api.github.com/repos/${input.reference.owner}/${input.reference.repo}/issues/${input.reference.number}/comments`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: JSON.stringify({ body: input.body })
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub writeback failed: ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return {
    provider: "github",
    target: input.reference.url,
    status: "written",
    remoteUrl: stringValue(payload.html_url)
  };
}

export function parseGitHubReference(input: string): GitHubReference {
  const url = new URL(input);
  if (!/^(.+\.)?github\.com$/i.test(url.hostname)) {
    throw new TypeError("GitHub URL must use github.com");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1];
  if (owner === undefined || repo === undefined) {
    throw new TypeError("GitHub URL must include owner and repository");
  }

  const resource = segments[2];
  const number = numberValue(segments[3]);
  if (resource === "pull" && number !== undefined) {
    return { kind: "pull_request", owner, repo, number, url: url.toString() };
  }
  if (resource === "issues" && number !== undefined) {
    return { kind: "issue", owner, repo, number, url: url.toString() };
  }
  return { kind: "repository", owner, repo, url: url.toString() };
}

export async function fetchGitHubRepositorySnapshot(
  input: FetchGitHubRepositoryInput
): Promise<GitHubRepositorySnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.token}`,
    "x-github-api-version": "2022-11-28"
  };
  const repoResponse = await fetchImpl(`https://api.github.com/repos/${input.reference.owner}/${input.reference.repo}`, {
    headers
  });
  if (!repoResponse.ok) {
    throw new Error(`GitHub repository request failed: ${repoResponse.status}`);
  }
  const repo = (await repoResponse.json()) as Record<string, unknown>;
  const pullRequests: GitHubPullRequestSnapshot[] = [];
  if (input.reference.kind === "pull_request" && input.reference.number !== undefined) {
    const pullResponse = await fetchImpl(
      `https://api.github.com/repos/${input.reference.owner}/${input.reference.repo}/pulls/${input.reference.number}`,
      { headers }
    );
    if (!pullResponse.ok) {
      throw new Error(`GitHub pull request failed: ${pullResponse.status}`);
    }
    pullRequests.push(normalizePullRequest(await pullResponse.json()));
  }

  return normalizeGitHubRepository({
    owner: input.reference.owner,
    repo: input.reference.repo,
    defaultBranch: stringValue(repo.default_branch),
    url: stringValue(repo.html_url),
    description: stringValue(repo.description),
    pullRequests
  });
}

export function readGitHubFixture(filePath: string): GitHubRepositorySnapshot {
  return normalizeGitHubRepository(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

export function normalizeGitHubRepository(raw: unknown): GitHubRepositorySnapshot {
  const value = asRecord(raw, "GitHub fixture must be an object");
  const owner = stringValue(value.owner);
  const repo = stringValue(value.repo) ?? stringValue(value.name);
  if (owner === undefined || repo === undefined) {
    throw new TypeError("GitHub fixture owner and repo are required");
  }

  return {
    provider: "github",
    owner,
    repo,
    defaultBranch: stringValue(value.defaultBranch),
    url: stringValue(value.url),
    description: stringValue(value.description),
    pullRequests: normalizePullRequests(value.pullRequests)
  };
}

function normalizePullRequests(raw: unknown): GitHubPullRequestSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const pullRequests: GitHubPullRequestSnapshot[] = [];
  for (const item of raw) {
    const value = asRecord(item, "GitHub pull request must be an object");
    const number = typeof value.number === "number" && Number.isInteger(value.number) ? value.number : undefined;
    const title = stringValue(value.title);
    if (number === undefined || title === undefined) continue;
    pullRequests.push({
      number,
      title,
      state: stringValue(value.state),
      headRef: stringValue(value.headRef),
      baseRef: stringValue(value.baseRef),
      url: stringValue(value.url)
    });
  }
  return pullRequests.sort((a, b) => a.number - b.number);
}

function normalizePullRequest(raw: unknown): GitHubPullRequestSnapshot {
  const value = asRecord(raw, "GitHub pull request must be an object");
  const number = typeof value.number === "number" && Number.isInteger(value.number) ? value.number : undefined;
  const title = stringValue(value.title);
  if (number === undefined || title === undefined) {
    throw new TypeError("GitHub pull request number and title are required");
  }
  return {
    number,
    title,
    state: stringValue(value.state),
    headRef: normalizeRef(value.head),
    baseRef: normalizeRef(value.base),
    url: stringValue(value.html_url) ?? stringValue(value.url)
  };
}

function normalizeRef(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  return stringValue((raw as Record<string, unknown>).ref);
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }
  return value as Record<string, unknown>;
}
