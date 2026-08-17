import { describe, expect, it } from "vitest";

import { allowedCommands, transition } from "./index.js";

describe("workflow transitions", () => {
  it("moves through the manual walking-skeleton happy path", () => {
    let state = transition({ state: "draft", command: "create_manual_session" }).to;
    state = transition({ state, command: "import_context" }).to;
    state = transition({ state, command: "export_plan" }).to;
    state = transition({ state, command: "import_contract" }).to;
    state = transition({ state, command: "approve_contract" }).to;
    state = transition({ state, command: "export_agent_package" }).to;

    expect(state).toBe("implementation_ready");
  });

  it("rejects invalid transitions", () => {
    expect(() => transition({ state: "planning_ready", command: "export_agent_package" })).toThrow(
      "Invalid workflow transition"
    );
  });

  it("blocks forward progress when paused", () => {
    expect(() =>
      transition({
        state: "contract_approved",
        command: "export_agent_package",
        overlay: { paused: true, archived: false, disposition: "active" }
      })
    ).toThrow("Session is paused");
  });

  it("reports allowed commands", () => {
    expect(allowedCommands("contract_draft")).toEqual(["import_contract", "approve_contract"]);
  });

  it("allows a clean imported review to proceed directly to completion evaluation", () => {
    expect(transition({ state: "review_imported", command: "evaluate_completion" }).to).toBe("completion_ready");
  });
});
