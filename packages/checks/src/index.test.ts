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
  const root = mkdtempSync(join(tmpdir(), "sigil-design-scan-"));
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

  it("does not fail the set for optional command failures", async () => {
    const result = await runCheckSet({
      checks: [{ name: "optional", required: false, command: process.execPath, args: ["-e", "process.exit(2)"] }]
    });

    expect(result.status).toBe("passed");
    expect(result.failedRequired).toEqual([]);
    expect(result.results[0]?.status).toBe("failed");
  });

  it("skips affected checks when changed files do not match", async () => {
    const result = await runCheckSet({
      changedFiles: ["src/app.ts"],
      checks: [
        {
          name: "docs-only",
          required: true,
          command: process.execPath,
          args: ["-e", "process.exit(1)"],
          affected: ["docs/**"]
        }
      ]
    });

    expect(result.status).toBe("failed");
    expect(result.results[0]?.status).toBe("skipped");
    expect(result.results[0]?.skippedReason).toContain("affected patterns");
    expect(result.failedRequired).toContain("sigil/required-validation-executed");
  });

  it("runs design scan as a configured check", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "view.tsx"), '<div className="bg-[#123456]" />\n');

    const result = await runCheckSet({
      cwd: root,
      checks: [{ name: "design", kind: "design-scan", required: true }]
    });

    expect(result.status).toBe("failed");
    expect(result.failedRequired).toEqual(["design"]);
    expect(result.results[0]?.summary).toContain("Design scan found");
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
      "sigil/no-tailwind-arbitrary-colors",
      "sigil/no-negative-letter-spacing"
    ]);
  });
});
