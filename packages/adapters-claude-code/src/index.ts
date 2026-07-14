import { runProcess, type ProcessRunResult } from "@atlas/process-runner";

export const adaptersClaudeCodePackage = "@atlas/adapters-claude-code";

export interface ClaudeCodeAdapterHealth {
  readonly provider: "claude-code";
  readonly configured: boolean;
  readonly writable: false;
  readonly capabilities: readonly ["health", "formatPackage", "invoke"];
  readonly command: string | undefined;
}

export interface ClaudeCodeInvocationPackage {
  readonly mode: "implement" | "fix" | "review";
  readonly instructions: string;
  readonly artifactIds: readonly string[];
  readonly cwd?: string | undefined;
}

export interface InvokeClaudeCodeInput {
  readonly command?: string | undefined;
  readonly package: ClaudeCodeInvocationPackage;
  readonly timeoutMs?: number | undefined;
}

export interface ClaudeCodeInvocationResult {
  readonly provider: "claude-code";
  readonly process: ProcessRunResult;
}

export function getClaudeCodeAdapterHealth(
  input: { readonly command?: string | undefined } = {}
): ClaudeCodeAdapterHealth {
  return {
    provider: "claude-code",
    configured: typeof input.command === "string" && input.command.length > 0,
    writable: false,
    capabilities: ["health", "formatPackage", "invoke"],
    command: input.command
  };
}

export function formatClaudeCodePackage(input: ClaudeCodeInvocationPackage): string {
  return [
    "# Atlas Claude Code Handoff",
    "",
    `Mode: ${input.mode}`,
    `Artifacts: ${input.artifactIds.join(", ") || "(none)"}`,
    "",
    "## Instructions",
    input.instructions.trim()
  ].join("\n");
}

export async function invokeClaudeCode(input: InvokeClaudeCodeInput): Promise<ClaudeCodeInvocationResult> {
  const command = input.command ?? "claude";
  const payload = formatClaudeCodePackage(input.package);
  const process = await runProcess({
    command,
    args: ["--print", payload],
    cwd: input.package.cwd,
    timeoutMs: input.timeoutMs
  });
  return { provider: "claude-code", process };
}
