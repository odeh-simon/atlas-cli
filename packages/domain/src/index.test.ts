import { describe, expect, it } from "vitest";

import {
  ApprovalRequiredError,
  ExitCode,
  activeLifecycle,
  assertCanProgress,
  createArtifactPointer,
  evaluateGates,
  ids,
  isTerminalWorkflowState,
  isWorkflowState
} from "./index.js";

describe("domain IDs", () => {
  it("brands and normalizes SHA-256 values", () => {
    const digest = ids.sha256("ABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD");

    expect(digest).toBe("abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  });

  it("rejects empty and unsafe simple IDs", () => {
    expect(() => ids.session("")).toThrow("session id must be a non-empty string");
    expect(() => ids.session("../session")).toThrow("session id contains unsupported characters");
  });
});

describe("workflow state and lifecycle overlays", () => {
  it("recognizes workflow states", () => {
    expect(isWorkflowState("contract_approved")).toBe(true);
    expect(isWorkflowState("not_a_state")).toBe(false);
    expect(isTerminalWorkflowState("completed")).toBe(true);
  });

  it("blocks progression for paused sessions", () => {
    expect(() => assertCanProgress({ ...activeLifecycle, paused: true })).toThrow("Session is paused");
  });
});

describe("error taxonomy", () => {
  it("maps approval-required errors to the stable exit code", () => {
    const error = new ApprovalRequiredError("Contract approval is required", { state: "contract_draft" });

    expect(error.code).toBe("ATLAS_APPROVAL_REQUIRED");
    expect(error.exitCode).toBe(ExitCode.InvalidTransitionOrApprovalRequired);
    expect(error.details).toEqual({ state: "contract_draft" });
  });
});

describe("gate and value objects", () => {
  it("fails an evaluation with a non-overrideable overridden gate", () => {
    const evaluation = evaluateGates([
      {
        gateId: ids.gate("artifact-integrity"),
        status: "overridden",
        severity: "non_overrideable",
        message: "Approved contract bytes are missing",
        evidenceArtifactIds: []
      }
    ]);

    expect(evaluation.passed).toBe(false);
  });

  it("validates artifact pointer versions", () => {
    expect(() =>
      createArtifactPointer({
        artifactId: ids.artifact("art_1"),
        type: "implementation_contract",
        schemaVersion: 0,
        contentVersion: 1,
        sha256: ids.sha256("a".repeat(64))
      })
    ).toThrow("schemaVersion must be a positive integer");
  });
});
