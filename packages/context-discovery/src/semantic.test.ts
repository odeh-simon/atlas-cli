import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ContextConfigurationError, discoverContextSources, readContextDiscoveryConfig } from "./semantic.js";

const tempRoots: string[] = [];

function tempRoot(prefix = "sigil-semantic-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("semantic context discovery", () => {
  it("applies one instruction per directory with override replacement and nested accumulation", () => {
    const root = tempRoot();
    fixture(root, "AGENTS.md", "root instructions\n");
    fixture(root, "packages/app/AGENTS.md", "shadowed scoped instructions\n");
    fixture(root, "packages/app/AGENTS.override.md", "active scoped instructions\n");
    fixture(root, "packages/app/src/target.ts", "export const target = true;\n");

    const result = discoverContextSources({ rootPath: root, taskText: "change target" });

    expect(result.instructionChain.map((item) => item.uri)).toEqual([
      "AGENTS.md",
      "packages/app/AGENTS.override.md"
    ]);
    expect(result.instructionChain[0]?.applies_to).toContain("packages/app/src/target.ts");
    expect(result.instructionChain[1]?.applies_to).toContain("packages/app/src/target.ts");
    expect(result.sources.some((item) => item.uri === "packages/app/AGENTS.md" && item.included)).toBe(false);
  });

  it("does not lose instructions at the scan bound and only enables fallback names explicitly", () => {
    const root = tempRoot();
    fixture(root, "000.ts", "export const zero = 0;\n");
    fixture(root, "nested/AGENTS.md", "active instructions\n");
    fixture(root, "nested/Agent.md", "inactive fallback\n");
    fixture(root, "nested/target.ts", "export const target = true;\n");

    const defaultResult = discoverContextSources({
      rootPath: root,
      taskText: "target",
      config: { maxScannedFiles: 1, pinnedSources: ["nested/target.ts"] }
    });
    expect(defaultResult.instructionChain.map((item) => item.uri)).toContain("nested/AGENTS.md");
    expect(defaultResult.instructionChain.map((item) => item.uri)).not.toContain("nested/Agent.md");

    const fallbackResult = discoverContextSources({
      rootPath: root,
      taskText: "target",
      config: { maxScannedFiles: 1, pinnedSources: ["nested/target.ts"], instructionFallbackFilenames: ["Agent.md"] }
    });
    expect(fallbackResult.instructionChain.map((item) => item.uri)).toContain("nested/AGENTS.md");
    expect(fallbackResult.instructionChain.map((item) => item.uri)).not.toContain("nested/Agent.md");

    rmSync(join(root, "nested", "AGENTS.md"));
    const fallbackOnly = discoverContextSources({
      rootPath: root,
      taskText: "target",
      config: { maxScannedFiles: 1, pinnedSources: ["nested/target.ts"], instructionFallbackFilenames: ["Agent.md"] }
    });
    expect(fallbackOnly.instructionChain.map((item) => item.uri)).toContain("nested/Agent.md");
  });

  it("blocks when applicable instructions cannot fit the instruction budget", () => {
    const root = tempRoot();
    fixture(root, "AGENTS.md", "long instruction evidence");
    fixture(root, "target.ts", "export const target = true;\n");

    const result = discoverContextSources({ rootPath: root, taskText: "target", config: { instructionMaxBytes: 4 } });

    expect(result.instructionChain[0]).toMatchObject({ uri: "AGENTS.md", included_bytes: 4, truncated: true });
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "instruction-budget-exceeded", severity: "blocking" }));
  });

  it("records the exact applicable instruction chain for more than eight pinned nested scopes", () => {
    const root = tempRoot();
    fixture(root, "AGENTS.md", "root instructions\n");
    const pins: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const directory = `packages/p${index}`;
      const source = `${directory}/src/target.ts`;
      pins.push(source);
      fixture(root, `${directory}/AGENTS.md`, `scope ${index}\n`);
      fixture(root, source, `export const target${index} = ${index};\n`);
    }

    const result = discoverContextSources({ rootPath: root, config: { pinnedSources: pins, maxFiles: 30 } });

    for (const [index, source] of pins.entries()) {
      expect(result.includedSources.find((item) => item.uri === source)?.required).toBe(true);
      expect(result.instructionChain.filter((instruction) => instruction.applies_to.includes(source)).map((instruction) => instruction.uri)).toEqual([
        "AGENTS.md",
        `packages/p${index}/AGENTS.md`
      ]);
    }
  });

  it("indexes imports, re-exports, symbols, reverse dependents, and nearest tests", () => {
    const root = tempRoot();
    fixture(root, "src/value.ts", "export function calculateValue(): number {\n  return 42;\n}\n");
    fixture(root, "src/public.ts", "export { calculateValue } from './value.js';\n");
    fixture(root, "src/consumer.ts", "import { calculateValue } from './public.js';\nexport const answer = calculateValue();\n");
    fixture(root, "src/value.test.ts", "import { calculateValue } from './value.js';\nvoid calculateValue();\n");

    const result = discoverContextSources({ rootPath: root, taskText: "calculate value consumer", config: { graphDepth: 3 } });

    expect(result.symbols).toContainEqual(expect.objectContaining({
      source_uri: "src/value.ts", name: "calculateValue", kind: "function", exported: true, line_start: 1, line_end: 3
    }));
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "re-export", from_uri: "src/public.ts", to_uri: "src/value.ts" }),
      expect.objectContaining({ kind: "import", from_uri: "src/consumer.ts", to_uri: "src/public.ts" }),
      expect.objectContaining({ kind: "test-association", from_uri: "src/value.ts", to_uri: "src/value.test.ts" })
    ]));
    expect(result.includedSources.find((item) => item.uri === "src/public.ts")?.relation_to_seeds.length).toBeGreaterThan(0);
  });

  it("uses the nearest package tsconfig for path aliases and surfaces malformed package configs", () => {
    const root = tempRoot();
    fixture(root, "packages/app/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@core/*": ["src/*"] } } }));
    fixture(root, "packages/app/src/value.ts", "export const value = 1;\n");
    fixture(root, "packages/app/src/use.ts", "import { value } from '@core/value';\nexport const used = value;\n");

    const result = discoverContextSources({ rootPath: root, taskText: "used value" });
    expect(result.relations).toContainEqual(expect.objectContaining({
      kind: "import", from_uri: "packages/app/src/use.ts", to_uri: "packages/app/src/value.ts"
    }));

    fixture(root, "packages/app/tsconfig.json", "{ malformed");
    const malformed = discoverContextSources({ rootPath: root, taskText: "used value" });
    expect(malformed.gaps).toContainEqual(expect.objectContaining({ code: "typescript-config-warning", uri: "packages/app/src/use.ts" }));

    fixture(root, "packages/app/tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "not-a-real-mode" } }));
    const semanticallyInvalid = discoverContextSources({ rootPath: root, taskText: "used value" });
    expect(semanticallyInvalid.gaps).toContainEqual(expect.objectContaining({
      code: "typescript-config-warning",
      uri: "packages/app/src/use.ts",
      description: expect.stringContaining("invalid compiler configuration")
    }));

    fixture(root, "packages/app/tsconfig.json", JSON.stringify({ references: [{ path: "../shared" }], compilerOptions: { baseUrl: "." } }));
    const referenced = discoverContextSources({ rootPath: root, taskText: "used value" });
    expect(referenced.gaps).toContainEqual(expect.objectContaining({
      code: "typescript-config-warning",
      uri: "packages/app/src/use.ts",
      description: expect.stringContaining("project references")
    }));
  });

  it("reports unresolved local imports and can make them blocking", () => {
    const root = tempRoot();
    fixture(root, "src/use.ts", "import { absent } from './absent.js';\nexport { absent };\n");

    const warning = discoverContextSources({ rootPath: root, taskText: "absent" });
    expect(warning.gaps).toContainEqual(expect.objectContaining({ code: "unresolved-local-import", severity: "warning" }));
    const blocking = discoverContextSources({ rootPath: root, taskText: "absent", config: { requireResolvedImports: true } });
    expect(blocking.gaps).toContainEqual(expect.objectContaining({ code: "unresolved-local-import", severity: "blocking" }));
  });

  it("blocks missing, excluded, and over-budget required sources", () => {
    const root = tempRoot();
    fixture(root, "src/required.ts", "export const required = 'content too large';\n");

    const missing = discoverContextSources({ rootPath: root, config: { pinnedSources: ["src/absent.ts"] } });
    expect(missing.gaps).toContainEqual(expect.objectContaining({ code: "required-pin-missing", severity: "blocking" }));
    const excluded = discoverContextSources({ rootPath: root, config: { pinnedSources: ["src/required.ts"], exclusions: ["src/required.ts"] } });
    expect(excluded.gaps).toContainEqual(expect.objectContaining({ code: "required-source-omitted", severity: "blocking" }));
    const overBudget = discoverContextSources({ rootPath: root, config: { pinnedSources: ["src/required.ts"], maxBytes: 3 } });
    expect(overBudget.gaps).toContainEqual(expect.objectContaining({ code: "required-source-omitted", severity: "blocking" }));
  });

  it("produces explainable deterministic task seeds and rejects unknown AI candidates", () => {
    const root = tempRoot();
    fixture(root, "src/payment-service.ts", "export function processPayment() { return true; }\n");
    fixture(root, "src/generic.ts", "export const generic = true;\n");
    const options = {
      rootPath: root,
      taskText: "process payment service",
      recommendations: [{ uri: "outside.ts", reason: "invented", confidence: 1 }]
    } as const;

    const first = discoverContextSources(options);
    const second = discoverContextSources(options);

    expect(second).toEqual(first);
    expect(first.seeds[0]?.uri).toBe("src/payment-service.ts");
    expect(first.sources.find((item) => item.uri === "src/payment-service.ts")?.score_features).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "task-path-term" }),
      expect.objectContaining({ feature: "task-symbol-term" })
    ]));
    expect(first.gaps).toContainEqual(expect.objectContaining({ code: "unknown-ai-candidate" }));
    expect(first.sources.some((item) => item.uri === "outside.ts")).toBe(false);
  });

  it("truncates excerpts on UTF-8 boundaries and reports actual emitted budget usage", () => {
    const root = tempRoot();
    fixture(root, "target.md", "😀😀😀 evidence\nsecond line\n");
    fixture(root, "other.md", "other\n");

    const result = discoverContextSources({
      rootPath: root,
      taskText: "target",
      config: { maxFiles: 1, maxExcerptBytes: 5, maxEvidenceFragments: 1, maxGraphNodes: 10, maxGraphEdges: 10 }
    });
    const fragment = result.evidenceFragments.find((item) => item.source_uri === "target.md");

    expect(fragment).toMatchObject({ line_start: 1, line_end: 3, excerpt: "😀", excerpt_truncated: true });
    expect(fragment?.excerpt).not.toContain("�");
    expect(result.budgets.used_graph_nodes).toBe(result.includedSources.length);
    expect(result.budgets.used_graph_edges).toBe(result.relations.length);
    expect(result.budgets.used_evidence_fragments).toBe(result.evidenceFragments.length);
  });

  it("redacts inline secret-like values from evidence fragments", () => {
    const root = tempRoot();
    fixture(root, "token.ts", "export const token = 'ghp_abcdefghijklmnop';\n");

    const result = discoverContextSources({ rootPath: root, taskText: "token" });
    const excerpts = result.evidenceFragments.filter((fragment) => fragment.source_uri === "token.ts").map((fragment) => fragment.excerpt).join("\n");

    expect(excerpts).toContain("[REDACTED]");
    expect(excerpts).not.toContain("ghp_abcdefghijklmnop");
  });

  it("does not traverse a symlink or junction escape", (context) => {
    const root = tempRoot();
    const outside = tempRoot("sigil-outside-");
    fixture(outside, "secret.ts", "export const secret = 'outside';\n");
    try {
      symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        context.skip();
        return;
      }
      throw error;
    }

    const result = discoverContextSources({ rootPath: root, taskText: "secret" });

    expect(result.sources.some((item) => item.uri.includes("secret"))).toBe(false);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "unsafe-symlink-entry", uri: "linked" }));
  });

  it("bounds large scans and never silently omits a required source", () => {
    const root = tempRoot();
    for (let index = 0; index < 30; index += 1) fixture(root, `src/${String(index).padStart(2, "0")}.ts`, `export const v${index} = ${index};\n`);

    const result = discoverContextSources({
      rootPath: root,
      config: { maxScannedFiles: 5, maxFiles: 2, maxGraphNodes: 4, pinnedSources: ["src/29.ts"] }
    });

    expect(result.scannedFileCount).toBeLessThanOrEqual(5);
    expect(result.omittedScanCount).toBeGreaterThan(0);
    expect(result.gaps).toContainEqual(expect.objectContaining({ code: "required-pin-missing", severity: "blocking", uri: "src/29.ts" }));
  });

  it("fails closed on malformed or unknown project context configuration", () => {
    const root = tempRoot();
    fixture(root, "sigil.config.json", JSON.stringify({ context: { unknownSetting: true } }));
    expect(() => readContextDiscoveryConfig(root)).toThrow(ContextConfigurationError);
  });
});

function fixture(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}
