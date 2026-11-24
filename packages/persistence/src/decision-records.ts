import { PersistenceError, type DecisionRecordKind, type MaterialChangeCategory } from "@sigil/domain";
import type initSqlJs from "sql.js";

import { optionalString, queryAll, queryOne, requiredString } from "./sql.js";

type SqlDatabase = initSqlJs.Database;

export interface DecisionRecord {
  readonly decisionId: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly kind: DecisionRecordKind;
  readonly title: string;
  readonly rationale: string;
  readonly category: MaterialChangeCategory;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly supersedesDecisionId?: string | undefined;
}

export function createDecisionRecord(db: SqlDatabase, input: DecisionRecord): DecisionRecord {
  db.run(
    `INSERT INTO decision_records
      (decision_id, session_id, artifact_id, kind, title, rationale, category, approved_by, approved_at, supersedes_decision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.decisionId,
      input.sessionId,
      input.artifactId,
      input.kind,
      input.title,
      input.rationale,
      input.category,
      input.approvedBy,
      input.approvedAt,
      input.supersedesDecisionId ?? null
    ]
  );

  const record = getDecisionRecord(db, input.decisionId);
  if (record === undefined) {
    throw new PersistenceError("Decision record was not created", { decisionId: input.decisionId });
  }

  return record;
}

export function getDecisionRecord(db: SqlDatabase, decisionId: string): DecisionRecord | undefined {
  const row = queryOne(db, "SELECT * FROM decision_records WHERE decision_id = ?", [decisionId]);
  return row === undefined ? undefined : mapDecisionRecord(row);
}

export function listDecisionRecordsForSession(db: SqlDatabase, sessionId: string): DecisionRecord[] {
  return queryAll(db, "SELECT * FROM decision_records WHERE session_id = ? ORDER BY approved_at, decision_id", [
    sessionId
  ]).map(mapDecisionRecord);
}

function mapDecisionRecord(row: Record<string, initSqlJs.SqlValue>): DecisionRecord {
  return {
    decisionId: requiredString(row, "decision_id"),
    sessionId: requiredString(row, "session_id"),
    artifactId: requiredString(row, "artifact_id"),
    kind: requiredString(row, "kind") as DecisionRecordKind,
    title: requiredString(row, "title"),
    rationale: requiredString(row, "rationale"),
    category: requiredString(row, "category") as MaterialChangeCategory,
    approvedBy: requiredString(row, "approved_by"),
    approvedAt: requiredString(row, "approved_at"),
    supersedesDecisionId: optionalString(row, "supersedes_decision_id")
  };
}
