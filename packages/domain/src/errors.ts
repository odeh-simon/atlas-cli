export enum ExitCode {
  Success = 0,
  GeneralFailure = 1,
  Usage = 2,
  InvalidConfiguration = 3,
  InvalidTransitionOrApprovalRequired = 4,
  GateFailed = 5,
  AdapterUnavailable = 6,
  GitSafetyBlock = 7,
  ValidationOrImport = 8,
  Cancelled = 9,
  RecoveryRequired = 10,
  Internal = 70
}

export type AtlasErrorCategory =
  | "usage"
  | "config"
  | "validation"
  | "state_transition"
  | "approval_required"
  | "gate_failed"
  | "adapter_unavailable"
  | "provider"
  | "git_safety"
  | "process"
  | "timeout"
  | "cancelled"
  | "security_policy"
  | "persistence"
  | "artifact_integrity"
  | "migration"
  | "recovery_required"
  | "internal";

export interface AtlasErrorOptions {
  readonly code: string;
  readonly category: AtlasErrorCategory;
  readonly exitCode: ExitCode;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly cause?: unknown | undefined;
}

export class AtlasError extends Error {
  readonly code: string;
  readonly category: AtlasErrorCategory;
  readonly exitCode: ExitCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, options: AtlasErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.category = options.category;
    this.exitCode = options.exitCode;
    this.details = options.details;
  }
}

function createErrorClass(
  className: string,
  category: AtlasErrorCategory,
  exitCode: ExitCode,
  defaultCode: string
) {
  return class extends AtlasError {
    constructor(message: string, details?: Readonly<Record<string, unknown>>, cause?: unknown) {
      super(message, { code: defaultCode, category, exitCode, details, cause });
      this.name = className;
    }
  };
}

export const UsageError = createErrorClass("UsageError", "usage", ExitCode.Usage, "ATLAS_USAGE_ERROR");
export const ConfigError = createErrorClass(
  "ConfigError",
  "config",
  ExitCode.InvalidConfiguration,
  "ATLAS_CONFIG_ERROR"
);
export const ValidationError = createErrorClass(
  "ValidationError",
  "validation",
  ExitCode.ValidationOrImport,
  "ATLAS_VALIDATION_ERROR"
);
export const StateTransitionError = createErrorClass(
  "StateTransitionError",
  "state_transition",
  ExitCode.InvalidTransitionOrApprovalRequired,
  "ATLAS_STATE_TRANSITION_ERROR"
);
export const ApprovalRequiredError = createErrorClass(
  "ApprovalRequiredError",
  "approval_required",
  ExitCode.InvalidTransitionOrApprovalRequired,
  "ATLAS_APPROVAL_REQUIRED"
);
export const GateFailedError = createErrorClass(
  "GateFailedError",
  "gate_failed",
  ExitCode.GateFailed,
  "ATLAS_GATE_FAILED"
);
export const AdapterUnavailableError = createErrorClass(
  "AdapterUnavailableError",
  "adapter_unavailable",
  ExitCode.AdapterUnavailable,
  "ATLAS_ADAPTER_UNAVAILABLE"
);
export const GitSafetyError = createErrorClass(
  "GitSafetyError",
  "git_safety",
  ExitCode.GitSafetyBlock,
  "ATLAS_GIT_SAFETY_ERROR"
);
export const ProcessError = createErrorClass("ProcessError", "process", ExitCode.GeneralFailure, "ATLAS_PROCESS_ERROR");
export const TimeoutError = createErrorClass("TimeoutError", "timeout", ExitCode.GeneralFailure, "ATLAS_TIMEOUT");
export const CancellationError = createErrorClass(
  "CancellationError",
  "cancelled",
  ExitCode.Cancelled,
  "ATLAS_CANCELLED"
);
export const SecurityPolicyError = createErrorClass(
  "SecurityPolicyError",
  "security_policy",
  ExitCode.GeneralFailure,
  "ATLAS_SECURITY_POLICY_ERROR"
);
export const PersistenceError = createErrorClass(
  "PersistenceError",
  "persistence",
  ExitCode.GeneralFailure,
  "ATLAS_PERSISTENCE_ERROR"
);
export const ArtifactIntegrityError = createErrorClass(
  "ArtifactIntegrityError",
  "artifact_integrity",
  ExitCode.RecoveryRequired,
  "ATLAS_ARTIFACT_INTEGRITY_ERROR"
);
export const MigrationError = createErrorClass(
  "MigrationError",
  "migration",
  ExitCode.RecoveryRequired,
  "ATLAS_MIGRATION_ERROR"
);
export const RecoveryRequiredError = createErrorClass(
  "RecoveryRequiredError",
  "recovery_required",
  ExitCode.RecoveryRequired,
  "ATLAS_RECOVERY_REQUIRED"
);
