import { runProcess, type ProcessRunResult } from "@atlas/process-runner";

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
