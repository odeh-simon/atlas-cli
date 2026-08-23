import { PersistenceError } from "@atlas/domain";
import type { EvidenceIndexPayload } from "@atlas/schemas";

export interface IndexComparisonEntry {
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

export interface IndexComparisonResult {
  readonly repositoryIdA: string;
  readonly repositoryIdB: string;
  readonly truncated: boolean;
  readonly files: IndexComparisonEntry;
  readonly contents: IndexComparisonEntry;
  readonly classifications: IndexComparisonEntry;
  readonly symbols: IndexComparisonEntry;
  readonly edges: IndexComparisonEntry;
  readonly test_associations: IndexComparisonEntry;
  readonly config_evidence: IndexComparisonEntry;
  readonly api_evidence: IndexComparisonEntry;
}

export interface CompareIndexSnapshotsOptions {
  readonly maxDeltasPerKind?: number | undefined;
}

const codepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareKind(
  label: string,
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  maxDeltas: number,
  truncatedKinds: string[]
): IndexComparisonEntry {
  const entry: IndexComparisonEntry = { added: [], removed: [], changed: [] };
  let count = 0;

  const push = (bucket: "added" | "removed" | "changed", value: string): void => {
    if (count >= maxDeltas) {
      if (!truncatedKinds.includes(label)) truncatedKinds.push(label);
      return;
    }
    entry[bucket].push(value);
    count += 1;
  };

  for (const [key, sha] of previous) {
    const next = current.get(key);
    if (next === undefined) push("removed", key);
    else if (next !== sha) push("changed", key);
  }
  for (const key of current.keys()) {
    if (!previous.has(key)) push("added", key);
  }

  entry.added.sort(codepoint);
  entry.removed.sort(codepoint);
  entry.changed.sort(codepoint);
  return entry;
}

type KeyExtractor = (payload: EvidenceIndexPayload) => Map<string, string>;

function keyedFiles(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(payload.files.map((file) => [file.uri, file.content_sha256]));
}

function keyedContents(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(
    payload.contents.map((content) => [
      content.content_sha256,
      `${content.byte_length}:${content.media_type}:${content.binary}:${content.redacted}:${content.sensitivity}`
    ])
  );
}

function keyedClassifications(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(payload.classifications.map((c) => [c.uri, `${c.category}:${c.source_sha256}:${c.secret}`]));
}

function keyedSymbols(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(payload.symbols.map((symbol) => [symbol.symbol_id, `${symbol.name}:${symbol.source_sha256}`]));
}

function keyedEdges(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(payload.edges.map((edge) => [edge.edge_id, edge.rule]));
}

function keyedAssociations(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(payload.test_associations.map((association) => [association.association_id, association.rule]));
}

function keyedConfigEvidence(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(payload.config_evidence.map((config) => [config.config_evidence_id, config.source_sha256]));
}

function keyedApiEvidence(payload: EvidenceIndexPayload): Map<string, string> {
  return new Map(payload.api_evidence.map((api) => [api.api_evidence_id, api.source_sha256]));
}

export function compareIndexSnapshots(
  payloadA: EvidenceIndexPayload,
  payloadB: EvidenceIndexPayload,
  options: CompareIndexSnapshotsOptions = {}
): IndexComparisonResult {
  if (payloadA.repository.repository_id !== payloadB.repository.repository_id) {
    throw new PersistenceError("Cross-repository evidence comparison rejected", {
      repositoryIdA: payloadA.repository.repository_id,
      repositoryIdB: payloadB.repository.repository_id
    });
  }

  const maxDeltas = options.maxDeltasPerKind ?? Number.POSITIVE_INFINITY;
  const truncatedKinds: string[] = [];

  const kinds: Array<[string, KeyExtractor]> = [
    ["files", keyedFiles],
    ["contents", keyedContents],
    ["classifications", keyedClassifications],
    ["symbols", keyedSymbols],
    ["edges", keyedEdges],
    ["test_associations", keyedAssociations],
    ["config_evidence", keyedConfigEvidence],
    ["api_evidence", keyedApiEvidence]
  ];

  const entries = kinds.map(([label, extract]) =>
    compareKind(label, extract(payloadA), extract(payloadB), maxDeltas, truncatedKinds)
  );

  return {
    repositoryIdA: payloadA.repository.repository_id,
    repositoryIdB: payloadB.repository.repository_id,
    truncated: truncatedKinds.length > 0,
    files: entries[0] ?? { added: [], removed: [], changed: [] },
    contents: entries[1] ?? { added: [], removed: [], changed: [] },
    classifications: entries[2] ?? { added: [], removed: [], changed: [] },
    symbols: entries[3] ?? { added: [], removed: [], changed: [] },
    edges: entries[4] ?? { added: [], removed: [], changed: [] },
    test_associations: entries[5] ?? { added: [], removed: [], changed: [] },
    config_evidence: entries[6] ?? { added: [], removed: [], changed: [] },
    api_evidence: entries[7] ?? { added: [], removed: [], changed: [] }
  };
}
