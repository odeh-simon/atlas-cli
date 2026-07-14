import { describe, expect, it } from "vitest";

import { runCheckSet } from "./index.js";

describe("runCheckSet", () => {
  it("runs required built-in and command checks in dependency order", async () => {
    const result = await runCheckSet({
      checks: [
        { name: "command", required: true, command: process.execPath, args: ["-e", "process.exit(0)"], dependsOn: ["basic"] },
        { name: "basic", required: true }
      ],
      builtIns: [{ name: "basic", run: () => ({ status: "passed", summary: "ok" }) }]
    });

    expect(result.status).toBe("passed");
    expect(result.results.map((check) => check.name)).toEqual(["basic", "command"]);
  });

  it("blocks dependent required checks when dependencies fail", async () => {
    const result = await runCheckSet({
      checks: [
        { name: "basic", required: true },
        { name: "dependent", required: true, command: process.execPath, args: ["-e", "process.exit(0)"], dependsOn: ["basic"] }
      ],
      builtIns: [{ name: "basic", run: () => ({ status: "failed", summary: "not ok" }) }]
    });

    expect(result.status).toBe("failed");
    expect(result.failedRequired).toEqual(["basic", "dependent"]);
    expect(result.results[1]?.status).toBe("blocked");
  });

  it("rejects dependency cycles", async () => {
    await expect(
      runCheckSet({
        checks: [
          { name: "a", required: true, dependsOn: ["b"] },
          { name: "b", required: true, dependsOn: ["a"] }
        ],
        builtIns: []
      })
    ).rejects.toThrow("Check dependency cycle");
  });
});
