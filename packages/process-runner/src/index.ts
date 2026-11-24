import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";

export const processRunnerPackage = "@sigil/process-runner";

export type ProcessRunStatus = "succeeded" | "failed" | "timeout" | "cancelled";

export interface RunProcessInput {
  readonly runId?: string | undefined;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly allowedCwdRoot?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly envAllowlist?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  readonly timeoutGraceMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly redactSecrets?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessRunResult {
  readonly runId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly status: ProcessRunStatus;
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly redacted: boolean;
}

export async function runProcess(input: RunProcessInput): Promise<ProcessRunResult> {
  assertSafeCommand(input.command);
  assertContainedCwd(input.cwd, input.allowedCwdRoot);
  const runId = input.runId ?? `run_${randomUUID()}`;
  const args = input.args ?? [];
  const maxOutputBytes = input.maxOutputBytes ?? 1_000_000;

  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  let timedOut = false;
  let cancelled = input.signal?.aborted === true;
  const onAbort = (): void => {
    cancelled = true;
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await new Promise<ProcessRunResult>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimeout: NodeJS.Timeout | undefined;
      const child = spawn(input.command, args, {
        cwd: input.cwd,
        env: buildProcessEnv(input),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout = newOutputCollector();
      const stderr = newOutputCollector();
      const finish = (partial: Omit<ProcessRunResult, "runId" | "cwd" | "startedAt" | "endedAt" | "durationMs" | "stdoutTruncated" | "stderrTruncated" | "redacted">): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout);
        const endedAtDate = new Date();
        const stdoutText = redactSecretText(partial.stdout, input.redactSecrets);
        const stderrText = redactSecretText(partial.stderr, input.redactSecrets);
        resolve({
          ...partial,
          runId,
          cwd: input.cwd,
          stdout: stdoutText.value,
          stderr: stderrText.value,
          startedAt,
          endedAt: endedAtDate.toISOString(),
          durationMs: endedAtDate.getTime() - startedAtDate.getTime(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          redacted: stdoutText.redacted || stderrText.redacted
        });
      };
      const terminate = (): void => {
        if (settled || child.killed) return;
        child.kill();
        forceKillTimeout = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, input.timeoutGraceMs ?? 1_000);
      };

      if (cancelled) terminate();
      input.signal?.addEventListener("abort", terminate, { once: true });
      timeout =
        input.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              terminate();
            }, input.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, maxOutputBytes));
      child.stderr?.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, maxOutputBytes));

      child.on("error", (error: NodeJS.ErrnoException) => {
        finish({
          command: input.command,
          args,
          status: timedOut ? "timeout" : cancelled ? "cancelled" : "failed",
          exitCode: undefined,
          signal: undefined,
          stdout: decode(stdout),
          stderr: decode(stderr) || error.message,
          timedOut
        });
      });
      child.on("close", (exitCode, signal) => {
        finish({
          command: input.command,
          args,
          status: timedOut ? "timeout" : cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
          exitCode: exitCode ?? undefined,
          signal: signal ?? undefined,
          stdout: decode(stdout),
          stderr: decode(stderr),
          timedOut
        });
      });
    });
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function assertSafeCommand(command: string): void {
  if (command.trim().length === 0) {
    throw new TypeError("Process command is required");
  }
  if (/[;&|<>]/.test(command)) {
    throw new TypeError("Process command must be an executable path/name, not a shell command");
  }
}

interface OutputCollector {
  readonly buffers: Buffer[];
  bytes: number;
  truncated: boolean;
}

function newOutputCollector(): OutputCollector {
  return { buffers: [], bytes: 0, truncated: false };
}

function appendBounded(output: OutputCollector, chunk: Buffer, maxOutputBytes: number): void {
  const used = output.bytes;
  if (used >= maxOutputBytes) return;
  const remaining = Math.max(0, maxOutputBytes - used);
  const next = chunk.subarray(0, remaining);
  output.buffers.push(next);
  output.bytes += next.byteLength;
  if (next.byteLength < chunk.byteLength || output.bytes >= maxOutputBytes) {
    output.truncated = true;
  }
}

function decode(output: OutputCollector): string {
  return Buffer.concat(output.buffers).toString("utf8");
}

function redactSecretText(value: string, redactSecrets: boolean | undefined): { readonly value: string; readonly redacted: boolean } {
  if (redactSecrets === false) return { value, redacted: false };
  const redactedValue = value.replace(/(?:pat|ghp|gho|figd|lin|sk)_[A-Za-z0-9_=-]{8,}|[A-Za-z0-9_=-]{32,}/g, "[REDACTED]");
  return { value: redactedValue, redacted: redactedValue !== value };
}

function assertContainedCwd(cwd: string | undefined, allowedCwdRoot: string | undefined): void {
  if (cwd === undefined || allowedCwdRoot === undefined) return;
  const resolvedCwd = resolve(cwd);
  const resolvedRoot = resolve(allowedCwdRoot);
  if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(`${resolvedRoot}${sep}`)) {
    throw new TypeError("Process cwd must be contained within the allowed cwd root");
  }
}

function buildProcessEnv(input: RunProcessInput): NodeJS.ProcessEnv | undefined {
  if (input.envAllowlist === undefined) return input.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of input.envAllowlist) {
    const value = input.env?.[key] ?? process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
