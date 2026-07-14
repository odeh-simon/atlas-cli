import { describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { runCheckSet, scanDesignPolicies } from "./index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-design-scan-"));
  tempRoots.push(root);
  return root;
}

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

  it("scans design policy violations deterministically", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "view.tsx"), '<div className="bg-[#123456] tracking-[-0.02em]" />\n');

    const result = scanDesignPolicies({ rootDir: root });

    expect(result.status).toBe("failed");
    expect(result.scannedFiles).toBe(1);
    expect(result.violations.map((violation) => violation.ruleId)).toEqual([
      "atlas/no-tailwind-arbitrary-colors",
      "atlas/no-negative-letter-spacing"
    ]);
  });
});
