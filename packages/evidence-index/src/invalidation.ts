import { deriveId } from "@sigil/domain";
import type {
  EvidenceClassificationRow,
  EvidenceFileRow,
  EvidenceInvalidationRow
} from "@sigil/persistence";
import type {
  EvidenceApiEvidence,
  EvidenceConfigEvidence,
  EvidenceFileRecord,
  EvidenceSourceClassification,
  EvidenceContentRecord,
  EvidenceEdge,
  EvidenceIndexPayload,
  EvidenceInvalidationReason,
  EvidenceSensitivity,
  EvidenceSymbol,
  EvidenceTestAssociation
} from "@sigil/schemas";

import type { HashedFileEvidence } from "./scan.js";

export interface IncrementalBuildInput {
  readonly repositoryId: string;
  readonly referenceSnapshotId: string | undefined;
  readonly previous: EvidenceIndexPayload | undefined;
  readonly hashedFiles: readonly HashedFileEvidence[];
  readonly renamePairs: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly configChanged: boolean;
  readonly gitReset: boolean;
  readonly forceManualRebuild: boolean;
  readonly recordedAt: string;
}

export interface IncrementalTombstone {
  readonly repositoryId: string;
  readonly uri: string;
  readonly deletedAtSnapshotId: string;
}

export interface IncrementalBuildMetrics {
  readonly added: number;
  readonly changed: number;
  readonly deleted: number;
  readonly renamed: number;
  readonly rowsCarriedForward: number;
  readonly invalidationsByReason: Record<EvidenceInvalidationReason, number>;
}

export interface IncrementalBuildOutput {
  readonly files: EvidenceFileRow[];
  readonly contents: EvidenceContentRecord[];
  readonly classifications: EvidenceClassificationRow[];
  readonly symbols: EvidenceSymbol[];
  readonly edges: EvidenceEdge[];
  readonly testAssociations: EvidenceTestAssociation[];
  readonly configEvidence: EvidenceConfigEvidence[];
  readonly apiEvidence: EvidenceApiEvidence[];
  readonly invalidations: EvidenceInvalidationRow[];
  readonly tombstones: readonly IncrementalTombstone[];
  readonly metrics: IncrementalBuildMetrics;
}

const emptyReasonCounts = (): Record<EvidenceInvalidationReason, number> => ({
  "file-changed": 0,
  "file-deleted": 0,
  "git-reset": 0,
  "config-changed": 0,
  "manual-rebuild": 0
});

export function buildIncrementalPayload(input: IncrementalBuildInput): IncrementalBuildOutput {
  const repositoryId = input.repositoryId;
  const referenceId =
    input.referenceSnapshotId ?? deriveId("evboot", [repositoryId]);

  const previousLiveFiles = (input.previous?.files ?? []).filter(
    (file) => file.deleted_at_snapshot_id === undefined
  );
  const previousByUri = new Map(previousLiveFiles.map((file) => [file.uri, file]));
  const previousContents = new Map((input.previous?.contents ?? []).map((c) => [c.content_sha256, c]));
  const previousClasses = new Map((input.previous?.classifications ?? []).map((c) => [c.uri, c]));

  const renameSources = new Set(input.renamePairs.map((pair) => pair.from));
  const currentUris = new Set(input.hashedFiles.map((file) => file.uri));

  const files: EvidenceFileRow[] = [];
  const contents: EvidenceContentRecord[] = [];
  const classifications: EvidenceClassificationRow[] = [];
  const symbols: EvidenceSymbol[] = [];
  const edges: EvidenceEdge[] = [];
  const testAssociations: EvidenceTestAssociation[] = [];
  const configEvidence: EvidenceConfigEvidence[] = [];
  const apiEvidence: EvidenceApiEvidence[] = [];
  const invalidationRows: EvidenceInvalidationRow[] = [];
  const tombstones: IncrementalTombstone[] = [];

  let added = 0;
  let changed = 0;
  let rowsCarriedForward = 0;

  const seenContents = new Set<string>();

  const invalidate = (
    entityType: EvidenceInvalidationRow["entityType"],
    entityId: string,
    validFromSnapshotId: string,
    reason: EvidenceInvalidationReason
  ): void => {
    const row: EvidenceInvalidationRow = {
      invalidationId: deriveId("evinval", [repositoryId, entityType, entityId, reason]),
      repositoryId,
      entityType,
      entityId,
      validFromSnapshotId,
      reason,
      recordedAt: input.recordedAt
    };
    if (!invalidationRows.some((existing) => existing.invalidationId === row.invalidationId)) {
      invalidationRows.push(row);
    }
  };

  const invalidateDependentsOf = (
    uri: string,
    oldSha256: string | undefined,
    reason: EvidenceInvalidationReason
  ): void => {
    for (const symbol of input.previous?.symbols ?? []) {
      if (
        symbol.uri === uri &&
        (oldSha256 === undefined || symbol.source_sha256 === oldSha256) &&
        !symbols.some((kept) => kept.symbol_id === symbol.symbol_id)
      ) {
        invalidate("symbol", symbol.symbol_id, referenceId, reason);
      }
    }
    for (const edge of input.previous?.edges ?? []) {
      if ((edge.from_uri === uri || edge.to_uri === uri) && !edges.some((kept) => kept.edge_id === edge.edge_id)) {
        invalidate("edge", edge.edge_id, referenceId, reason);
      }
    }
    for (const association of input.previous?.test_associations ?? []) {
      if (
        (association.source_uri === uri || association.test_uri === uri) &&
        !testAssociations.some((kept) => kept.association_id === association.association_id)
      ) {
        invalidate("test_association", association.association_id, referenceId, reason);
      }
    }
    for (const config of input.previous?.config_evidence ?? []) {
      if (config.uri === uri && !configEvidence.some((kept) => kept.config_evidence_id === config.config_evidence_id)) {
        invalidate("config_evidence", config.config_evidence_id, referenceId, reason);
      }
    }
    for (const api of input.previous?.api_evidence ?? []) {
      if (api.uri === uri && !apiEvidence.some((kept) => kept.api_evidence_id === api.api_evidence_id)) {
        invalidate("api_evidence", api.api_evidence_id, referenceId, reason);
      }
    }
  };

  const pushContent = (content: EvidenceContentRecord): void => {
    if (!seenContents.has(content.content_sha256)) {
      seenContents.add(content.content_sha256);
      contents.push(content);
    }
  };

  const fileToRow = (file: EvidenceFileRecord): EvidenceFileRow => ({
    fileId: file.file_id,
    repositoryId,
    uri: file.uri,
    contentSha256: file.content_sha256,
    byteLength: file.byte_length,
    lastSeenSnapshotId: file.last_seen_snapshot_id,
    ...(file.deleted_at_snapshot_id === undefined ? {} : { deletedAtSnapshotId: file.deleted_at_snapshot_id })
  });

  const classToRow = (classification: EvidenceSourceClassification): EvidenceClassificationRow => ({
    classificationId: classification.classification_id,
    repositoryId,
    ...(classification.file_id === undefined ? {} : { fileId: classification.file_id }),
    uri: classification.uri,
    sourceSha256: classification.source_sha256,
    category: classification.category,
    sensitivity: classification.sensitivity,
    secret: classification.secret,
    binaryCheck: classification.binary,
    excluded: classification.excluded,
    ...(classification.excluded_reason === undefined ? {} : { excludedReason: classification.excluded_reason })
  });

  const contentToRecord = (content: EvidenceContentRecord): EvidenceContentRecord => content;

  const freshRowsFor = (hashed: HashedFileEvidence): void => {
    const fileId = deriveId("evfile", [repositoryId, hashed.uri]);
    files.push({
      fileId,
      repositoryId,
      uri: hashed.uri,
      contentSha256: hashed.contentSha256,
      byteLength: hashed.byteLength,
      lastSeenSnapshotId: referenceId
    });

    const sensitivity: EvidenceSensitivity = hashed.sensitivity;
    const contentRecord: EvidenceContentRecord = {
      content_sha256: hashed.contentSha256,
      byte_length: hashed.byteLength,
      media_type: hashed.mediaType,
      binary: hashed.binary,
      redacted: hashed.redacted,
      sensitivity
    };
    pushContent(contentRecord);

    classifications.push({
      classificationId: deriveId("evcls", [repositoryId, hashed.uri]),
      repositoryId,
      fileId,
      uri: hashed.uri,
      sourceSha256: hashed.contentSha256,
      category: hashed.category,
      sensitivity: hashed.sensitivity,
      secret: hashed.secret,
      binaryCheck: hashed.binary,
      excluded: hashed.excluded
    });
  };

  for (const hashed of input.hashedFiles) {
    const previousFile = previousByUri.get(hashed.uri);

    if (previousFile === undefined) {
      added += 1;
      freshRowsFor(hashed);
      continue;
    }

    if (previousFile.content_sha256 !== hashed.contentSha256) {
      changed += 1;
      const reason: EvidenceInvalidationReason = input.gitReset ? "git-reset" : "file-changed";
      invalidate("file", previousFile.file_id, previousFile.last_seen_snapshot_id, reason);
      invalidateDependentsOf(hashed.uri, previousFile.content_sha256, reason);
      freshRowsFor(hashed);
      continue;
    }

    const previousClass = previousClasses.get(hashed.uri);
    const previousContent = previousContents.get(hashed.contentSha256);
    if (previousFile !== undefined && previousContent !== undefined) {
      files.push(fileToRow(previousFile));
      contents.push(contentToRecord(previousContent));
      seenContents.add(previousContent.content_sha256);
      rowsCarriedForward += 2;
    }
    if (previousClass !== undefined) {
      classifications.push(classToRow(previousClass));
      rowsCarriedForward += 1;
    }
  }

  let deleted = 0;
  for (const previousFile of previousLiveFiles) {
    if (currentUris.has(previousFile.uri)) continue;

    deleted += 1;
    const wasRenamedAway = renameSources.has(previousFile.uri);
    const reason: EvidenceInvalidationReason = wasRenamedAway ? "file-changed" : "file-deleted";
    invalidate("file", previousFile.file_id, previousFile.last_seen_snapshot_id, reason);
    invalidateDependentsOf(previousFile.uri, previousFile.content_sha256, reason);
    tombstones.push({ repositoryId, uri: previousFile.uri, deletedAtSnapshotId: referenceId });

    const staleContent = previousContents.get(previousFile.content_sha256);
    if (staleContent !== undefined && !seenContents.has(staleContent.content_sha256)) {
      const stillReferenced = [...currentUris].some((uri) => {
        const live = previousByUri.get(uri);
        return live !== undefined && live.content_sha256 === staleContent.content_sha256;
      });
      if (!stillReferenced) {
        seenContents.add(staleContent.content_sha256);
      }
    }
  }

  const droppedEntityIds = new Set(invalidationRows.map((row) => `${row.entityType} ${row.entityId}`));

  for (const symbol of input.previous?.symbols ?? []) {
    if (!droppedEntityIds.has(`symbol\u0000${symbol.symbol_id}`)) {
      symbols.push(symbol);
      rowsCarriedForward += 1;
    }
  }
  for (const edge of input.previous?.edges ?? []) {
    if (!droppedEntityIds.has(`edge\u0000${edge.edge_id}`)) {
      edges.push(edge);
      rowsCarriedForward += 1;
    }
  }
  for (const association of input.previous?.test_associations ?? []) {
    if (!droppedEntityIds.has(`test_association\u0000${association.association_id}`)) {
      testAssociations.push(association);
      rowsCarriedForward += 1;
    }
  }
  for (const config of input.previous?.config_evidence ?? []) {
    if (!droppedEntityIds.has(`config_evidence\u0000${config.config_evidence_id}`)) {
      configEvidence.push(config);
      rowsCarriedForward += 1;
    }
  }
  for (const api of input.previous?.api_evidence ?? []) {
    if (!droppedEntityIds.has(`api_evidence\u0000${api.api_evidence_id}`)) {
      apiEvidence.push(api);
      rowsCarriedForward += 1;
    }
  }

  if (input.configChanged) {
    for (const classification of classifications) {
      invalidate("classification", classification.classificationId, referenceId, "config-changed");
    }
  }

  if (input.forceManualRebuild) {
    for (const previousFile of previousLiveFiles) {
      invalidate("file", previousFile.file_id, previousFile.last_seen_snapshot_id, "manual-rebuild");
    }
  }

  const invalidationsByReason = emptyReasonCounts();
  for (const row of invalidationRows) {
    const reason = asEvidenceInvalidationReason(row.reason);
    invalidationsByReason[reason] += 1;
  }

  const invalidations: EvidenceInvalidationRow[] = invalidationRows;

  return {
    files: sortBy(files, (file) => file.uri),
    contents: sortBy(contents, (content) => content.content_sha256),
    classifications: sortBy(classifications, (classification) => `${classification.uri}\u0000${classification.classificationId}`),
    symbols: sortBy(symbols, (symbol) => `${symbol.uri}\u0000${symbol.name}\u0000${symbol.symbol_id}`),
    edges: sortBy(edges, (edge) => `${edge.from_uri}\u0000${edge.to_uri}\u0000${edge.kind}\u0000${edge.edge_id}`),
    testAssociations: sortBy(
      testAssociations,
      (association) => `${association.test_uri}\u0000${association.source_uri}\u0000${association.association_id}`
    ),
    configEvidence: sortBy(configEvidence, (config) => `${config.uri}\u0000${config.config_evidence_id}`),
    apiEvidence: sortBy(apiEvidence, (api) => `${api.uri}\u0000${api.name}\u0000${api.api_evidence_id}`),
    invalidations: sortBy(invalidations, (row) => `${row.entityType} ${row.entityId} ${row.reason}`),
    tombstones,
    metrics: {
      added,
      changed,
      deleted,
      renamed: Math.min(input.renamePairs.length, deleted),
      rowsCarriedForward,
      invalidationsByReason
    }
  };
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function asEvidenceInvalidationReason(value: string): EvidenceInvalidationReason {
  const reasons: EvidenceInvalidationReason[] = ["file-changed", "file-deleted", "git-reset", "config-changed", "manual-rebuild"];
  if (!reasons.includes(value as EvidenceInvalidationReason)) {
    throw new Error(`Unknown evidence invalidation reason: ${value}`);
  }
  return value as EvidenceInvalidationReason;
}
