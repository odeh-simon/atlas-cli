import {
  StateTransitionError,
  activeLifecycle,
  assertCanProgress,
  type LifecycleOverlay,
  type WorkflowState
} from "@atlas/domain";

export const transitionCommands = [
  "create_manual_session",
  "import_context",
  "export_plan",
  "import_contract",
  "approve_contract",
  "export_agent_package",
  "import_execution_result",
  "run_basic_check",
  "prepare_review",
  "import_review",
  "dispose_findings",
  "evaluate_completion",
  "approve_completion",
  "pause",
  "resume_pause",
  "archive",
  "unarchive",
  "cancel"
] as const;

export type TransitionCommand = (typeof transitionCommands)[number];

export interface TransitionInput {
  readonly state: WorkflowState;
  readonly command: TransitionCommand;
  readonly overlay?: LifecycleOverlay;
}

export interface TransitionResult {
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly command: TransitionCommand;
  readonly changed: boolean;
}

const table: Partial<Record<WorkflowState, Partial<Record<TransitionCommand, WorkflowState>>>> = {
  draft: {
    create_manual_session: "intake_ready"
  },
  intake_ready: {
    import_context: "context_ready"
  },
  context_ready: {
    export_plan: "planning_ready"
  },
  planning_ready: {
    import_contract: "contract_draft",
    export_plan: "planning_ready"
  },
  contract_draft: {
    import_contract: "contract_draft",
    approve_contract: "contract_approved"
  },
  contract_approved: {
    export_agent_package: "implementation_ready"
  },
  implementation_ready: {
    import_execution_result: "implementation_reconciled"
  },
  implementation_reconciled: {
    run_basic_check: "checks_completed"
  },
  checks_completed: {
    prepare_review: "review_ready",
    evaluate_completion: "completion_ready",
    run_basic_check: "checks_completed"
  },
  review_ready: {
    import_review: "review_imported"
  },
  review_imported: {
    dispose_findings: "findings_dispositioned"
  },
  findings_dispositioned: {
    evaluate_completion: "completion_ready",
    dispose_findings: "findings_dispositioned"
  },
  completion_ready: {
    approve_completion: "completed",
    evaluate_completion: "completion_ready"
  },
  completed: {}
};

const overlayCommands = new Set<TransitionCommand>(["pause", "resume_pause", "archive", "unarchive", "cancel"]);

export function transition(input: TransitionInput): TransitionResult {
  const overlay = input.overlay ?? activeLifecycle;

  if (overlayCommands.has(input.command)) {
    return {
      from: input.state,
      to: input.state,
      command: input.command,
      changed: false
    };
  }

  assertCanProgress(overlay);

  const next = table[input.state]?.[input.command];
  if (next === undefined) {
    throw new StateTransitionError("Invalid workflow transition", {
      state: input.state,
      command: input.command
    });
  }

  return {
    from: input.state,
    to: next,
    command: input.command,
    changed: next !== input.state
  };
}

export function allowedCommands(state: WorkflowState): readonly TransitionCommand[] {
  return Object.keys(table[state] ?? {}) as TransitionCommand[];
}
