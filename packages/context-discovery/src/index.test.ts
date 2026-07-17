import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { discoverContextSources } from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-context-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("discoverContextSources", () => {
  it("discovers deterministic source records and excludes generated directories", () => {
    const root = tempRoot();
    writeFixture(root, "package.json", '{"name":"fixture"}\n');
    writeFixture(root, "README.md", "# Fixture\n");
    writeFixture(root, "packages/app/src/index.ts", "export const value = 1;\n");
    writeFixture(root, "packages/app/src/index.test.ts", "expect(true).toBe(true);\n");
    writeFixture(root, "node_modules/nope/index.ts", "export const nope = true;\n");
    writeFixture(root, "dist/generated.js", "console.log('nope');\n");

    const result = discoverContextSources({ rootPath: root });

    expect(result.freshness).toBe("fresh");
    expect(result.budgets.used_files).toBe(4);
    expect(result.sources.map((source) => source.uri)).toEqual([
      "package.json",
      "README.md",
      "packages/app/src/index.test.ts",
      "packages/app/src/index.ts"
    ]);
    expect(result.sources.find((source) => source.uri.endsWith(".test.ts"))).toMatchObject({
      kind: "test",
      reason: "Existing test coverage"
    });
  });

  it("marks overflow sources as excluded when budgets are exceeded", () => {
    const root = tempRoot();
    writeFixture(root, "package.json", '{"name":"fixture"}\n');
    writeFixture(root, "README.md", "# Fixture\n");
    writeFixture(root, "src/a.ts", "export const a = 1;\n");

    const result = discoverContextSources({ rootPath: root, budget: { maxFiles: 2, maxBytes: 1_000 } });

    expect(result.freshness).toBe("partial");
    expect(result.budgets.used_files).toBe(2);
    expect(result.sources.filter((source) => source.included).map((source) => source.uri)).toEqual([
      "package.json",
      "README.md"
    ]);
    expect(result.sources.find((source) => source.uri === "src/a.ts")).toMatchObject({
      included: false,
      exclusion_reason: "file budget exceeded"
    });
  });

  it("prioritizes recommended sources before applying budgets", () => {
    const root = tempRoot();
    writeFixture(root, "package.json", '{"name":"fixture"}\n');
    writeFixture(root, "README.md", "# Fixture\n");
    writeFixture(root, "src/target.ts", "export const target = true;\n");

    const result = discoverContextSources({
      rootPath: root,
      budget: { maxFiles: 1, maxBytes: 1_000 },
      recommendations: [{ uri: "src/target.ts", reason: "Task-specific implementation file", confidence: 0.95 }]
    });

    expect(result.sources.filter((source) => source.included).map((source) => source.uri)).toEqual(["src/target.ts"]);
    expect(result.sources.find((source) => source.uri === "src/target.ts")?.reason).toContain("AI recommended");
  });
});

function writeFixture(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, content);
}
