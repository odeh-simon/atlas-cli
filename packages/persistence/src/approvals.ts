import { PersistenceError, type ApprovalType } from "@sigil/domain";
import type initSqlJs from "sql.js";

import { optionalString, queryAll, queryOne, requiredString } from "./sql.js";

type SqlDatabase = initSqlJs.Database;

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly approvalType: ApprovalType;
  readonly artifactSha256: string;
  readonly actorId: string;
  readonly rationale?: string | undefined;
  readonly createdAt: string;
  readonly revokedById?: string | undefined;
}

export interface CreateApprovalInput {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly artifactId: string;
  readonly approvalType: ApprovalType;
  readonly artifactSha256: string;
  readonly actorId: string;
  readonly rationale?: string | undefined;
  readonly createdAt: string;
}

export function createApproval(db: SqlDatabase, input: CreateApprovalInput): ApprovalRecord {
  db.run(
    `INSERT INTO approvals
      (approval_id, session_id, artifact_id, approval_type, artifact_sha256, actor_id, rationale, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.approvalId,
      input.sessionId,
      input.artifactId,
      input.approvalType,
      input.artifactSha256,
      input.actorId,
      input.rationale ?? null,
      input.createdAt
    ]
  );

  const approval = getApproval(db, input.approvalId);
  if (approval === undefined) {
    throw new PersistenceError("Approval was not created", { approvalId: input.approvalId });
  }

  return approval;
}

export function getApproval(db: SqlDatabase, approvalId: string): ApprovalRecord | undefined {
  const row = queryOne(db, "SELECT * FROM approvals WHERE approval_id = ?", [approvalId]);
  return row === undefined ? undefined : mapApproval(row);
}

export function listApprovalsForSession(db: SqlDatabase, sessionId: string): ApprovalRecord[] {
  return queryAll(db, "SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at, approval_id", [sessionId]).map(
    mapApproval
  );
}

function mapApproval(row: Record<string, initSqlJs.SqlValue>): ApprovalRecord {
  return {
    approvalId: requiredString(row, "approval_id"),
    sessionId: requiredString(row, "session_id"),
    artifactId: requiredString(row, "artifact_id"),
    approvalType: requiredString(row, "approval_type") as ApprovalType,
    artifactSha256: requiredString(row, "artifact_sha256"),
    actorId: requiredString(row, "actor_id"),
    rationale: optionalString(row, "rationale"),
    createdAt: requiredString(row, "created_at"),
    revokedById: optionalString(row, "revoked_by_id")
  };
}
