import { PersistenceError } from "@sigil/domain";
import type initSqlJs from "sql.js";

import { optionalString, queryAll, queryOne, requiredNumber, requiredString } from "./sql.js";

type SqlDatabase = initSqlJs.Database;

export type ArtifactSensitivity = "public" | "internal" | "confidential" | "secret-redacted";
export type ArtifactStatus = "draft" | "valid" | "rejected" | "approved" | "superseded" | "stale";
export type ArtifactProducerType = "sigil" | "user" | "adapter" | "agent" | "import";
export type ArtifactDependencyKind = "input" | "parent" | "replaces" | "evidence";

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly contentVersion: number;
  readonly storageUri: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly status: ArtifactStatus;
  readonly producerType: ArtifactProducerType;
  readonly producerId?: string | undefined;
  readonly createdAt: string;
  readonly approvedAt?: string | undefined;
}

export interface CreateArtifactRecordInput {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly contentVersion: number;
  readonly storageUri: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sensitivity: ArtifactSensitivity;
  readonly status: ArtifactStatus;
  readonly producerType: ArtifactProducerType;
  readonly producerId?: string | undefined;
  readonly createdAt: string;
  readonly approvedAt?: string | undefined;
}

export interface ArtifactDependencyRecord {
  readonly artifactId: string;
  readonly dependsOnArtifactId: string;
  readonly dependencyKind: ArtifactDependencyKind;
}

export function createArtifactRecord(db: SqlDatabase, input: CreateArtifactRecordInput): ArtifactRecord {
  db.run(
    `INSERT INTO artifacts
      (artifact_id, session_id, type, schema_version, content_version, storage_uri, sha256, byte_length,
       media_type, sensitivity, status, producer_type, producer_id, created_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.artifactId,
      input.sessionId,
      input.type,
      input.schemaVersion,
      input.contentVersion,
      input.storageUri,
      input.sha256,
      input.byteLength,
      input.mediaType,
      input.sensitivity,
      input.status,
      input.producerType,
      input.producerId ?? null,
      input.createdAt,
      input.approvedAt ?? null
    ]
  );

  const artifact = getArtifactRecord(db, input.artifactId);
  if (artifact === undefined) {
    throw new PersistenceError("Artifact was not created", { artifactId: input.artifactId });
  }

  return artifact;
}

export function getArtifactRecord(db: SqlDatabase, artifactId: string): ArtifactRecord | undefined {
  const row = queryOne(db, "SELECT * FROM artifacts WHERE artifact_id = ?", [artifactId]);
  return row === undefined ? undefined : mapArtifact(row);
}

export function listArtifactsForSession(db: SqlDatabase, sessionId: string): ArtifactRecord[] {
  return queryAll(db, "SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at, artifact_id", [sessionId]).map(
    mapArtifact
  );
}

export function updateArtifactStatus(
  db: SqlDatabase,
  input: { readonly artifactId: string; readonly status: ArtifactStatus; readonly approvedAt?: string | undefined }
): ArtifactRecord {
  db.run("UPDATE artifacts SET status = ?, approved_at = ? WHERE artifact_id = ?", [
    input.status,
    input.approvedAt ?? null,
    input.artifactId
  ]);

  const artifact = getArtifactRecord(db, input.artifactId);
  if (artifact === undefined) {
    throw new PersistenceError("Artifact not found for status update", { artifactId: input.artifactId });
  }

  return artifact;
}

export function addArtifactDependency(
  db: SqlDatabase,
  input: ArtifactDependencyRecord
): ArtifactDependencyRecord {
  db.run(
    `INSERT INTO artifact_dependencies (artifact_id, depends_on_artifact_id, dependency_kind)
     VALUES (?, ?, ?)`,
    [input.artifactId, input.dependsOnArtifactId, input.dependencyKind]
  );

  return input;
}

export function listArtifactDependencies(db: SqlDatabase, artifactId: string): ArtifactDependencyRecord[] {
  return queryAll(db, "SELECT * FROM artifact_dependencies WHERE artifact_id = ? ORDER BY dependency_kind", [
    artifactId
  ]).map(mapArtifactDependency);
}

function mapArtifact(row: Record<string, initSqlJs.SqlValue>): ArtifactRecord {
  return {
    artifactId: requiredString(row, "artifact_id"),
    sessionId: requiredString(row, "session_id"),
    type: requiredString(row, "type"),
    schemaVersion: requiredNumber(row, "schema_version"),
    contentVersion: requiredNumber(row, "content_version"),
    storageUri: requiredString(row, "storage_uri"),
    sha256: requiredString(row, "sha256"),
    byteLength: requiredNumber(row, "byte_length"),
    mediaType: requiredString(row, "media_type"),
    sensitivity: requiredString(row, "sensitivity") as ArtifactSensitivity,
    status: requiredString(row, "status") as ArtifactStatus,
    producerType: requiredString(row, "producer_type") as ArtifactProducerType,
    producerId: optionalString(row, "producer_id"),
    createdAt: requiredString(row, "created_at"),
    approvedAt: optionalString(row, "approved_at")
  };
}

function mapArtifactDependency(row: Record<string, initSqlJs.SqlValue>): ArtifactDependencyRecord {
  return {
    artifactId: requiredString(row, "artifact_id"),
    dependsOnArtifactId: requiredString(row, "depends_on_artifact_id"),
    dependencyKind: requiredString(row, "dependency_kind") as ArtifactDependencyKind
  };
}
