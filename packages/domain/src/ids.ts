type Brand<TValue, TBrand extends string> = TValue & { readonly __brand: TBrand };

export type NonEmptyString = Brand<string, "NonEmptyString">;
export type SessionId = Brand<string, "SessionId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type OverrideId = Brand<string, "OverrideId">;
export type EventId = Brand<string, "EventId">;
export type ExecutionRunId = Brand<string, "ExecutionRunId">;
export type CheckRunId = Brand<string, "CheckRunId">;
export type FindingId = Brand<string, "FindingId">;
export type FixBatchId = Brand<string, "FixBatchId">;
export type CommandId = Brand<string, "CommandId">;
export type GateId = Brand<string, "GateId">;
export type TaskKey = Brand<string, "TaskKey">;
export type Sha256 = Brand<string, "Sha256">;

const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const SIMPLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export function asNonEmptyString(value: string, label = "value"): NonEmptyString {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return trimmed as NonEmptyString;
}

export function asSimpleId<TId extends string>(value: string, label: string): Brand<string, TId> {
  const trimmed = asNonEmptyString(value, label);
  if (!SIMPLE_ID_PATTERN.test(trimmed)) {
    throw new TypeError(`${label} contains unsupported characters`);
  }

  return trimmed as Brand<string, TId>;
}

export function asSha256(value: string, label = "sha256"): Sha256 {
  const normalized = value.trim().toLowerCase();
  if (!SHA_256_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex digest`);
  }

  return normalized as Sha256;
}

export const ids = {
  session(value: string): SessionId {
    return asSimpleId<"SessionId">(value, "session id");
  },
  repository(value: string): RepositoryId {
    return asSimpleId<"RepositoryId">(value, "repository id");
  },
  artifact(value: string): ArtifactId {
    return asSimpleId<"ArtifactId">(value, "artifact id");
  },
  approval(value: string): ApprovalId {
    return asSimpleId<"ApprovalId">(value, "approval id");
  },
  override(value: string): OverrideId {
    return asSimpleId<"OverrideId">(value, "override id");
  },
  event(value: string): EventId {
    return asSimpleId<"EventId">(value, "event id");
  },
  executionRun(value: string): ExecutionRunId {
    return asSimpleId<"ExecutionRunId">(value, "execution run id");
  },
  checkRun(value: string): CheckRunId {
    return asSimpleId<"CheckRunId">(value, "check run id");
  },
  finding(value: string): FindingId {
    return asSimpleId<"FindingId">(value, "finding id");
  },
  fixBatch(value: string): FixBatchId {
    return asSimpleId<"FixBatchId">(value, "fix batch id");
  },
  command(value: string): CommandId {
    return asSimpleId<"CommandId">(value, "command id");
  },
  gate(value: string): GateId {
    return asSimpleId<"GateId">(value, "gate id");
  },
  taskKey(value: string): TaskKey {
    return asSimpleId<"TaskKey">(value, "task key");
  },
  sha256: asSha256
} as const;
