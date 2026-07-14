import { runProcess, type ProcessRunResult } from "@atlas/process-runner";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const checksPackage = "@atlas/checks";

export type CheckStatus = "passed" | "failed" | "skipped" | "blocked" | "cancelled" | "timeout";

export interface CheckDefinition {
  readonly name: string;
  readonly required: boolean;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface BuiltInCheck {
  readonly name: string;
  readonly run: () => Promise<CheckExecutionResult> | CheckExecutionResult;
}

export interface CheckExecutionResult {
  readonly status: CheckStatus;
  readonly summary: string;
  readonly process?: ProcessRunResult | undefined;
}

export interface CheckResult extends CheckExecutionResult {
  readonly name: string;
  readonly required: boolean;
  readonly dependencies: readonly string[];
}

export interface RunCheckSetInput {
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly checks: readonly CheckDefinition[];
  readonly builtIns?: readonly BuiltInCheck[] | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface CheckSetResult {
  readonly status: "passed" | "failed";
  readonly results: readonly CheckResult[];
  readonly failedRequired: readonly string[];
}

export interface DesignPolicyRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly fileExtensions?: readonly string[] | undefined;
}

export interface DesignPolicyViolation {
  readonly ruleId: string;
  readonly description: string;
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}

export interface DesignPolicyScanInput {
  readonly rootDir: string;
  readonly rules?: readonly DesignPolicyRule[] | undefined;
  readonly maxFiles?: number | undefined;
}

export interface DesignPolicyScanResult {
  readonly status: "passed" | "failed";
  readonly scannedFiles: number;
  readonly violations: readonly DesignPolicyViolation[];
}

const defaultDesignPolicyRules: readonly DesignPolicyRule[] = [
  {
    id: "atlas/no-tailwind-arbitrary-colors",
    description: "Avoid arbitrary Tailwind color literals; use design tokens or named palette entries.",
    pattern: /\b(?:bg|text|border|ring|from|via|to)-\[#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\]/g,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".html"]
  },
  {
    id: "atlas/no-negative-letter-spacing",
    description: "Letter spacing must not be negative.",
    pattern: /(?:letter-spacing\s*:\s*-[0-9.]+|tracking-\[-)/g,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".html"]
  }
];

export async function runCheckSet(input: RunCheckSetInput): Promise<CheckSetResult> {
  const definitions = orderChecks(input.checks);
  const builtIns = new Map((input.builtIns ?? []).map((check) => [check.name, check]));
  const results: CheckResult[] = [];
  const byName = new Map<string, CheckResult>();

  for (const definition of definitions) {
    const dependencies = definition.dependsOn ?? [];
    const blockedBy = dependencies.filter((name) => {
      const dependency = byName.get(name);
      return dependency === undefined || (dependency.required && dependency.status !== "passed");
    });
    if (blockedBy.length > 0) {
      const result: CheckResult = {
        name: definition.name,
        required: definition.required,
        dependencies,
        status: "blocked",
        summary: `Blocked by failed or missing dependency: ${blockedBy.join(", ")}`
      };
      results.push(result);
      byName.set(result.name, result);
      continue;
    }

    const execution =
      definition.command === undefined
        ? await runBuiltInCheck(definition, builtIns)
        : await runCommandCheck(definition, input);
    const result: CheckResult = {
      name: definition.name,
      required: definition.required,
      dependencies,
      ...execution
    };
    results.push(result);
    byName.set(result.name, result);
  }

  const failedRequired = results
    .filter((result) => result.required && result.status !== "passed" && result.status !== "skipped")
    .map((result) => result.name);
  return {
    status: failedRequired.length === 0 ? "passed" : "failed",
    results,
    failedRequired
  };
}

export function scanDesignPolicies(input: DesignPolicyScanInput): DesignPolicyScanResult {
  const rules = input.rules ?? defaultDesignPolicyRules;
  const files = listScannableFiles(input.rootDir, input.maxFiles ?? 500);
  const violations: DesignPolicyViolation[] = [];

  for (const filePath of files) {
    const text = readFileSync(join(input.rootDir, filePath), "utf8");
    for (const rule of rules) {
      if (rule.fileExtensions !== undefined && !rule.fileExtensions.some((extension) => filePath.endsWith(extension))) {
        continue;
      }
      for (const match of text.matchAll(rule.pattern)) {
        const index = match.index ?? 0;
        const position = lineColumnAt(text, index);
        violations.push({
          ruleId: rule.id,
          description: rule.description,
          filePath,
          line: position.line,
          column: position.column,
          excerpt: lineAt(text, position.line).trim()
        });
      }
    }
  }

  violations.sort((a, b) =>
    `${a.filePath}:${a.line}:${a.column}:${a.ruleId}`.localeCompare(`${b.filePath}:${b.line}:${b.column}:${b.ruleId}`)
  );

  return {
    status: violations.length === 0 ? "passed" : "failed",
    scannedFiles: files.length,
    violations
  };
}

async function runBuiltInCheck(
  definition: CheckDefinition,
  builtIns: ReadonlyMap<string, BuiltInCheck>
): Promise<CheckExecutionResult> {
  const builtIn = builtIns.get(definition.name);
  if (builtIn === undefined) {
    return { status: "blocked", summary: `Built-in check is not registered: ${definition.name}` };
  }
  return await builtIn.run();
}

async function runCommandCheck(
  definition: CheckDefinition,
  input: RunCheckSetInput
): Promise<CheckExecutionResult> {
  const process = await runProcess({
    command: definition.command ?? "",
    args: definition.args,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: definition.timeoutMs,
    maxOutputBytes: input.maxOutputBytes
  });
  const status: CheckStatus =
    process.status === "succeeded"
      ? "passed"
      : process.status === "timeout"
        ? "timeout"
        : process.status === "cancelled"
          ? "cancelled"
          : "failed";
  return {
    status,
    summary: status === "passed" ? "Command check passed" : process.stderr || process.stdout || "Command check failed",
    process
  };
}

function orderChecks(checks: readonly CheckDefinition[]): readonly CheckDefinition[] {
  const byName = new Map<string, CheckDefinition>();
  for (const check of checks) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(check.name)) {
      throw new TypeError(`Invalid check name: ${check.name}`);
    }
    if (byName.has(check.name)) {
      throw new TypeError(`Duplicate check name: ${check.name}`);
    }
    byName.set(check.name, check);
  }

  const ordered: CheckDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new TypeError(`Check dependency cycle includes ${name}`);
    }
    const check = byName.get(name);
    if (check === undefined) {
      throw new TypeError(`Unknown check dependency: ${name}`);
    }
    visiting.add(name);
    for (const dependency of check.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(check);
  };

  for (const check of checks) visit(check.name);
  return ordered;
}

function listScannableFiles(rootDir: string, maxFiles: number): string[] {
  const results: string[] = [];
  const ignored = new Set([".git", "node_modules", "dist", "coverage", ".atlas"]);
  const visit = (relativeDir: string): void => {
    if (results.length >= maxFiles) return;
    const absoluteDir = join(rootDir, relativeDir);
    for (const entry of readdirSync(absoluteDir).sort()) {
      if (ignored.has(entry)) continue;
      const absolutePath = join(absoluteDir, entry);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(join(relativeDir, entry));
        continue;
      }
      if (stat.isFile() && isDesignFile(entry)) {
        results.push(relative(rootDir, absolutePath).replaceAll("\\", "/"));
        if (results.length >= maxFiles) return;
      }
    }
  };
  visit("");
  return results;
}

function isDesignFile(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".html"].some((extension) => path.endsWith(extension));
}

function lineColumnAt(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

function lineAt(text: string, line: number): string {
  return text.split(/\r?\n/)[line - 1] ?? "";
}
