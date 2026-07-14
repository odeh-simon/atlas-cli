import { readFileSync } from "node:fs";

export const adaptersFigmaPackage = "@atlas/adapters-figma";

export interface FigmaAdapterHealth {
  readonly provider: "figma";
  readonly configured: boolean;
  readonly writable: false;
  readonly capabilities: readonly ["health", "parseReference", "readFixture"];
  readonly mode: "fixture" | "api-token-present";
}

export type FigmaReferenceKind = "file" | "design" | "proto";

export interface FigmaReference {
  readonly kind: FigmaReferenceKind;
  readonly fileKey: string;
  readonly nodeId?: string | undefined;
  readonly url: string;
}

export interface FigmaEvidence {
  readonly kind: "metadata" | "screenshot" | "note";
  readonly title: string;
  readonly value: string;
}

export interface FigmaFileSnapshot {
  readonly provider: "figma";
  readonly fileKey: string;
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly evidence: readonly FigmaEvidence[];
}

export interface FetchFigmaFileInput {
  readonly apiKey: string;
  readonly reference: FigmaReference;
  readonly fetchImpl?: typeof fetch | undefined;
}

export function getFigmaAdapterHealth(input: { readonly apiKey?: string | undefined } = {}): FigmaAdapterHealth {
  return {
    provider: "figma",
    configured: typeof input.apiKey === "string" && input.apiKey.length > 0,
    writable: false,
    capabilities: ["health", "parseReference", "readFixture"],
    mode: typeof input.apiKey === "string" && input.apiKey.length > 0 ? "api-token-present" : "fixture"
  };
}

export function parseFigmaReference(input: string): FigmaReference {
  const url = new URL(input);
  if (!/^(.+\.)?figma\.com$/i.test(url.hostname)) {
    throw new TypeError("Figma URL must use figma.com");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const kind = parseReferenceKind(segments[0]);
  const fileKey = segments[1];
  if (kind === undefined || fileKey === undefined || fileKey.length === 0) {
    throw new TypeError("Figma URL must include a file/design/proto key");
  }

  const nodeId = url.searchParams.get("node-id") ?? undefined;
  return { kind, fileKey, nodeId, url: url.toString() };
}

export async function fetchFigmaFileSnapshot(input: FetchFigmaFileInput): Promise<FigmaFileSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(`https://api.figma.com/v1/files/${encodeURIComponent(input.reference.fileKey)}`);
  if (input.reference.nodeId !== undefined) {
    url.searchParams.set("ids", input.reference.nodeId);
  }
  const response = await fetchImpl(url, {
    headers: { "x-figma-token": input.apiKey }
  });
  if (!response.ok) {
    throw new Error(`Figma API request failed: ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return normalizeFigmaSnapshot({
    fileKey: input.reference.fileKey,
    name: stringValue(payload.name),
    url: input.reference.url,
    nodeId: input.reference.nodeId,
    lastModified: stringValue(payload.lastModified),
    evidence: [
      { kind: "metadata", title: "Figma file key", value: input.reference.fileKey },
      ...(input.reference.nodeId === undefined
        ? []
        : [{ kind: "metadata", title: "Figma node id", value: input.reference.nodeId }]),
      ...(typeof payload.version === "string"
        ? [{ kind: "metadata", title: "Figma version", value: payload.version }]
        : [])
    ]
  });
}

export function readFigmaFixture(filePath: string): FigmaFileSnapshot {
  return normalizeFigmaSnapshot(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

export function normalizeFigmaSnapshot(raw: unknown): FigmaFileSnapshot {
  const value = asRecord(raw, "Figma fixture must be an object");
  const fileKey = stringValue(value.fileKey) ?? stringValue(value.key);
  if (fileKey === undefined) {
    throw new TypeError("Figma fixture fileKey is required");
  }

  return {
    provider: "figma",
    fileKey,
    name: stringValue(value.name),
    url: stringValue(value.url),
    nodeId: stringValue(value.nodeId),
    lastModified: stringValue(value.lastModified),
    evidence: normalizeEvidence(value.evidence)
  };
}

function parseReferenceKind(value: string | undefined): FigmaReferenceKind | undefined {
  if (value === "file" || value === "design" || value === "proto") return value;
  return undefined;
}

function normalizeEvidence(raw: unknown): FigmaEvidence[] {
  if (!Array.isArray(raw)) return [];
  const evidence: FigmaEvidence[] = [];
  for (const item of raw) {
    const value = asRecord(item, "Figma evidence must be an object");
    const kind = value.kind === "screenshot" || value.kind === "note" ? value.kind : "metadata";
    const title = stringValue(value.title);
    const evidenceValue = stringValue(value.value) ?? stringValue(value.url) ?? stringValue(value.text);
    if (title === undefined || evidenceValue === undefined) continue;
    evidence.push({ kind, title, value: evidenceValue });
  }
  return evidence;
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
