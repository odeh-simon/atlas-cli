import { readFileSync } from "node:fs";

export const adaptersLinearPackage = "@atlas/adapters-linear";

export interface LinearAdapterHealth {
  readonly provider: "linear";
  readonly configured: boolean;
  readonly writable: false;
  readonly capabilities: readonly ["health", "getIssue"];
  readonly mode: "fixture" | "api-token-present";
}

export interface LinearIssueComment {
  readonly id?: string | undefined;
  readonly author?: string | undefined;
  readonly body: string;
  readonly createdAt?: string | undefined;
}

export interface LinearIssueLink {
  readonly title?: string | undefined;
  readonly url: string;
}

export interface LinearIssueSnapshot {
  readonly provider: "linear";
  readonly issueKey: string;
  readonly issueId?: string | undefined;
  readonly title: string;
  readonly description: string;
  readonly url?: string | undefined;
  readonly state?: string | undefined;
  readonly priority?: string | undefined;
  readonly labels: readonly string[];
  readonly assignee?: string | undefined;
  readonly comments: readonly LinearIssueComment[];
  readonly links: readonly LinearIssueLink[];
  readonly fetchedAt?: string | undefined;
}

export interface FetchLinearIssueInput {
  readonly apiKey: string;
  readonly issueKey: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export function getLinearAdapterHealth(input: { readonly apiKey?: string | undefined } = {}): LinearAdapterHealth {
  return {
    provider: "linear",
    configured: typeof input.apiKey === "string" && input.apiKey.length > 0,
    writable: false,
    capabilities: ["health", "getIssue"],
    mode: typeof input.apiKey === "string" && input.apiKey.length > 0 ? "api-token-present" : "fixture"
  };
}

export async function fetchLinearIssue(input: FetchLinearIssueInput): Promise<LinearIssueSnapshot> {
  if (!isLinearIssueKey(input.issueKey)) {
    throw new TypeError("Linear issue key must look like TEAM-123");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: input.apiKey
    },
    body: JSON.stringify({
      query: `query AtlasIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priorityLabel
          state { name }
          assignee { displayName name }
          labels { nodes { name } }
          comments { nodes { id body createdAt user { name displayName } } }
          attachments { nodes { title url } }
        }
      }`,
      variables: { id: input.issueKey }
    })
  });
  if (!response.ok) {
    throw new Error(`Linear API request failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    data?: { issue?: unknown };
    errors?: readonly { message?: string }[];
  };
  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new Error(`Linear API error: ${payload.errors.map((error) => error.message ?? "unknown").join("; ")}`);
  }
  if (payload.data?.issue === undefined || payload.data.issue === null) {
    throw new Error(`Linear issue not found: ${input.issueKey}`);
  }
  return normalizeLinearIssue({ ...(payload.data.issue as Record<string, unknown>), fetchedAt: new Date().toISOString() });
}

export function readLinearIssueFixture(filePath: string): LinearIssueSnapshot {
  return normalizeLinearIssue(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

export function normalizeLinearIssue(raw: unknown): LinearIssueSnapshot {
  const value = asRecord(raw, "Linear issue fixture must be an object");
  const issueKey = stringValue(value.identifier) ?? stringValue(value.issueKey) ?? stringValue(value.key);
  if (issueKey === undefined || !isLinearIssueKey(issueKey)) {
    throw new TypeError("Linear issue key must look like TEAM-123");
  }

  const title = stringValue(value.title);
  if (title === undefined || title.length === 0) {
    throw new TypeError("Linear issue title is required");
  }

  return {
    provider: "linear",
    issueKey,
    issueId: stringValue(value.id),
    title,
    description: stringValue(value.description) ?? "",
    url: stringValue(value.url),
    state: normalizeName(value.state),
    priority: normalizeName(value.priority) ?? stringValue(value.priorityLabel),
    labels: normalizeLabels(nodesOrArray(value.labels)),
    assignee: normalizeName(value.assignee),
    comments: normalizeComments(nodesOrArray(value.comments)),
    links: normalizeLinks(nodesOrArray(value.links ?? value.attachments)),
    fetchedAt: stringValue(value.fetchedAt)
  };
}

export function isLinearIssueKey(value: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(value);
}

function normalizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((label) => (typeof label === "string" ? label : normalizeName(label)))
    .filter((label): label is string => label !== undefined && label.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

function normalizeComments(raw: unknown): LinearIssueComment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((comment) => {
    const value = asRecord(comment, "Linear comment must be an object");
    const body = stringValue(value.body) ?? stringValue(value.description) ?? "";
    return {
      id: stringValue(value.id),
      author: normalizeName(value.user) ?? normalizeName(value.author) ?? stringValue(value.authorName),
      body,
      createdAt: stringValue(value.createdAt)
    };
  }).filter((comment) => comment.body.length > 0);
}

function normalizeLinks(raw: unknown): LinearIssueLink[] {
  if (!Array.isArray(raw)) return [];
  const links: LinearIssueLink[] = [];
  for (const link of raw) {
    const value = asRecord(link, "Linear link must be an object");
    const url = stringValue(value.url);
    if (url === undefined) continue;
    const title = stringValue(value.title);
    links.push({ url, ...(title === undefined ? {} : { title }) });
  }
  return links;
}

function normalizeName(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  return stringValue(value.name) ?? stringValue(value.label) ?? stringValue(value.displayName);
}

function nodesOrArray(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return raw;
  const nodes = (raw as Record<string, unknown>).nodes;
  return Array.isArray(nodes) ? nodes : raw;
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
