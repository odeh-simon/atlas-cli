import type { ApprovalId, ArtifactId, CommandId, Sha256, SessionId } from "./ids.js";
import type { ApprovalType } from "./state.js";

export interface ArtifactPointer {
  readonly artifactId: ArtifactId;
  readonly type: string;
  readonly schemaVersion: number;
  readonly contentVersion: number;
  readonly sha256: Sha256;
}

export interface ApprovalRecord {
  readonly approvalId: ApprovalId;
  readonly sessionId: SessionId;
  readonly approvalType: ApprovalType;
  readonly approvedArtifactId: ArtifactId;
  readonly approvedSha256: Sha256;
  readonly actorId: string;
  readonly approvedAt: string;
  readonly commandId: CommandId;
  readonly rationale?: string;
}

export interface CommandIdentity {
  readonly commandId: CommandId;
  readonly name: string;
  readonly startedAt: string;
}

export function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }

  return value;
}

export function createArtifactPointer(input: ArtifactPointer): ArtifactPointer {
  assertPositiveInteger(input.schemaVersion, "schemaVersion");
  assertPositiveInteger(input.contentVersion, "contentVersion");
  return input;
}
