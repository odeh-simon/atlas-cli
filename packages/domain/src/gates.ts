import type { GateId } from "./ids.js";

export type GateStatus = "passed" | "failed" | "blocked" | "overridden" | "not_applicable";
export type GateSeverity = "required" | "optional" | "non_overrideable";

export interface GateResult {
  readonly gateId: GateId;
  readonly status: GateStatus;
  readonly severity: GateSeverity;
  readonly message: string;
  readonly evidenceArtifactIds: readonly string[];
}

export interface GateEvaluation {
  readonly passed: boolean;
  readonly results: readonly GateResult[];
}

export function evaluateGates(results: readonly GateResult[]): GateEvaluation {
  return {
    passed: results.every((result) => {
      if (result.status === "passed" || result.status === "not_applicable") {
        return true;
      }

      if (result.status === "overridden") {
        return result.severity !== "non_overrideable";
      }

      return result.severity === "optional";
    }),
    results
  };
}
