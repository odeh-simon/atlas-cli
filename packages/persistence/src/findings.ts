import { PersistenceError, type FindingSeverity, type FindingStatus } from "@sigil/domain";
import type initSqlJs from "sql.js";

import { optionalString, queryAll, queryOne, requiredNumber, requiredString } from "./sql.js";

type SqlDatabase = initSqlJs.Database;

export interface FindingRecord {
  readonly findingId: string;
  readonly sessionId: string;
  readonly reviewReportArtifactId: string;
  readonly reviewIteration: number;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly description: string;
  readonly evidence: readonly string[];
  readonly affectedFiles: readonly string[];
  readonly requirementIds: readonly string[];
  readonly proposedAction?: string | undefined;
  readonly status: FindingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateFindingInput extends Omit<FindingRecord, "createdAt" | "updatedAt"> {
  readonly now: string;
}

export function createFinding(db: SqlDatabase, input: CreateFindingInput): FindingRecord {
  db.run(
    `INSERT INTO findings
      (finding_id, session_id, review_report_artifact_id, review_iteration, severity, title, description,
       evidence_json, affected_files_json, requirement_ids_json, proposed_action, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.findingId,
      input.sessionId,
      input.reviewReportArtifactId,
      input.reviewIteration,
      input.severity,
      input.title,
      input.description,
      JSON.stringify(input.evidence),
      JSON.stringify(input.affectedFiles),
      JSON.stringify(input.requirementIds),
      input.proposedAction ?? null,
      input.status,
      input.now,
      input.now
    ]
  );

  const finding = getFinding(db, input.findingId);
  if (finding === undefined) {
    throw new PersistenceError("Finding was not created", { findingId: input.findingId });
  }

  return finding;
}

export function getFinding(db: SqlDatabase, findingId: string): FindingRecord | undefined {
  const row = queryOne(db, "SELECT * FROM findings WHERE finding_id = ?", [findingId]);
  return row === undefined ? undefined : mapFinding(row);
}

export function listFindingsForSession(db: SqlDatabase, sessionId: string): FindingRecord[] {
  return queryAll(db, "SELECT * FROM findings WHERE session_id = ? ORDER BY review_iteration, finding_id", [
    sessionId
  ]).map(mapFinding);
}

export function updateFindingStatus(
  db: SqlDatabase,
  input: { readonly findingId: string; readonly status: FindingStatus; readonly now: string }
): FindingRecord {
  db.run("UPDATE findings SET status = ?, updated_at = ? WHERE finding_id = ?", [
    input.status,
    input.now,
    input.findingId
  ]);

  const finding = getFinding(db, input.findingId);
  if (finding === undefined) {
    throw new PersistenceError("Finding not found for status update", { findingId: input.findingId });
  }

  return finding;
}

export type FindingDispositionAction =
  | "resolve"
  | "accept_deviation"
  | "reject"
  | "defer"
  | "duplicate"
  | "cannot_reproduce"
  | "reopen";

export interface FindingDispositionRecord {
  readonly dispositionId: string;
  readonly findingId: string;
  readonly sessionId: string;
  readonly disposition: FindingDispositionAction;
  readonly actorId: string;
  readonly reason: string;
  readonly resolutionEvidence: readonly string[];
  readonly createdAt: string;
}

export function createFindingDisposition(
  db: SqlDatabase,
  input: FindingDispositionRecord
): FindingDispositionRecord {
  db.run(
    `INSERT INTO finding_dispositions
      (disposition_id, finding_id, session_id, disposition, actor_id, reason, resolution_evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.dispositionId,
      input.findingId,
      input.sessionId,
      input.disposition,
      input.actorId,
      input.reason,
      JSON.stringify(input.resolutionEvidence),
      input.createdAt
    ]
  );

  return input;
}

function mapFinding(row: Record<string, initSqlJs.SqlValue>): FindingRecord {
  return {
    findingId: requiredString(row, "finding_id"),
    sessionId: requiredString(row, "session_id"),
    reviewReportArtifactId: requiredString(row, "review_report_artifact_id"),
    reviewIteration: requiredNumber(row, "review_iteration"),
    severity: requiredString(row, "severity") as FindingSeverity,
    title: requiredString(row, "title"),
    description: requiredString(row, "description"),
    evidence: JSON.parse(requiredString(row, "evidence_json")) as string[],
    affectedFiles: JSON.parse(requiredString(row, "affected_files_json")) as string[],
    requirementIds: JSON.parse(requiredString(row, "requirement_ids_json")) as string[],
    proposedAction: optionalString(row, "proposed_action"),
    status: requiredString(row, "status") as FindingStatus,
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at")
  };
}
