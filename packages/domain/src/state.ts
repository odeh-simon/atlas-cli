export const workflowStates = [
  "draft",
  "intake_ready",
  "context_ready",
  "planning_ready",
  "contract_draft",
  "contract_approved",
  "implementation_ready",
  "implementation_running",
  "implementation_reconciled",
  "checks_ready",
  "checks_completed",
  "review_ready",
  "review_imported",
  "findings_dispositioned",
  "fix_ready",
  "completion_ready",
  "completed",
  "recovery_required"
] as const;

export type WorkflowState = (typeof workflowStates)[number];

export const terminalWorkflowStates = ["completed"] as const satisfies readonly WorkflowState[];
export type TerminalWorkflowState = (typeof terminalWorkflowStates)[number];

export type SessionDisposition = "active" | "cancelled" | "completed";

export interface LifecycleOverlay {
  readonly paused: boolean;
  readonly archived: boolean;
  readonly disposition: SessionDisposition;
}

export const activeLifecycle: LifecycleOverlay = {
  paused: false,
  archived: false,
  disposition: "active"
};

export type ExecutionRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type FindingSeverity = "blocking" | "important" | "suggestion" | "question" | "accepted_deviation";

export type FindingStatus =
  | "open"
  | "resolved"
  | "accepted_deviation"
  | "rejected"
  | "deferred"
  | "duplicate"
  | "cannot_reproduce"
  | "reopened";

export type ApprovalType = "contract" | "completion" | "override_disposition";

export type DecisionRecordKind = "decision" | "deviation";

export type MaterialChangeCategory =
  | "scope"
  | "architecture"
  | "data_security"
  | "design_constraints"
  | "acceptance"
  | "tests"
  | "prohibitions";

export function isWorkflowState(value: string): value is WorkflowState {
  return workflowStates.includes(value as WorkflowState);
}

export function isTerminalWorkflowState(state: WorkflowState): state is TerminalWorkflowState {
  return terminalWorkflowStates.includes(state as TerminalWorkflowState);
}

export function canProgress(overlay: LifecycleOverlay): boolean {
  return !overlay.paused && !overlay.archived && overlay.disposition === "active";
}

export function assertCanProgress(overlay: LifecycleOverlay): void {
  if (overlay.paused) {
    throw new Error("Session is paused");
  }

  if (overlay.archived) {
    throw new Error("Session is archived");
  }

  if (overlay.disposition !== "active") {
    throw new Error(`Session disposition blocks progression: ${overlay.disposition}`);
  }
}
