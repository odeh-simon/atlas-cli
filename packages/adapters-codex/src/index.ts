import { runProcess, type ProcessRunResult } from "@sigil/process-runner";

export const adaptersCodexPackage = "@sigil/adapters-codex";

export interface CodexAdapterHealth {
  readonly provider: "codex";
  readonly configured: boolean;
  readonly writable: false;
  readonly capabilities: readonly ["health", "formatPackage", "invoke"];
  readonly command: string | undefined;
}

export interface CodexInvocationPackage {
  readonly mode: "implement" | "fix" | "review";
  readonly instructions: string;
  readonly artifactIds: readonly string[];
  readonly cwd?: string | undefined;
}

export interface InvokeCodexInput {
  readonly command?: string | undefined;
  readonly package: CodexInvocationPackage;
  readonly timeoutMs?: number | undefined;
}

export interface CodexInvocationResult {
  readonly provider: "codex";
  readonly process: ProcessRunResult;
}

export function getCodexAdapterHealth(input: { readonly command?: string | undefined } = {}): CodexAdapterHealth {
  return {
    provider: "codex",
    configured: typeof input.command === "string" && input.command.length > 0,
    writable: false,
    capabilities: ["health", "formatPackage", "invoke"],
    command: input.command
  };
}

export function formatCodexPackage(input: CodexInvocationPackage): string {
  return [
    "# Sigil Codex Handoff",
    "",
    `Mode: ${input.mode}`,
    `Artifacts: ${input.artifactIds.join(", ") || "(none)"}`,
    "",
    "## Instructions",
    input.instructions.trim()
  ].join("\n");
}

export async function invokeCodex(input: InvokeCodexInput): Promise<CodexInvocationResult> {
  const command = input.command ?? "codex";
  const payload = formatCodexPackage(input.package);
  const process = await runProcess({
    command,
    args: ["--prompt", payload],
    cwd: input.package.cwd,
    allowedCwdRoot: input.package.cwd,
    timeoutMs: input.timeoutMs
  });
  return { provider: "codex", process };
}
