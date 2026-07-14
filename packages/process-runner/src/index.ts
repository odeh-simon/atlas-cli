import { spawn } from "node:child_process";

export const processRunnerPackage = "@atlas/process-runner";

export type ProcessRunStatus = "succeeded" | "failed" | "timeout" | "cancelled";

export interface RunProcessInput {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessRunResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: ProcessRunStatus;
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export async function runProcess(input: RunProcessInput): Promise<ProcessRunResult> {
  assertSafeCommand(input.command);
  const args = input.args ?? [];
  const maxOutputBytes = input.maxOutputBytes ?? 1_000_000;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  let timedOut = false;
  const timeout =
    input.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, input.timeoutMs);

  try {
    return await new Promise<ProcessRunResult>((resolve) => {
      const child = spawn(input.command, args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        signal: controller.signal,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, maxOutputBytes));
      child.stderr?.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, maxOutputBytes));

      child.on("error", (error: NodeJS.ErrnoException) => {
        const cancelled = error.name === "AbortError";
        resolve({
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
        resolve({
          command: input.command,
          args,
          status: timedOut ? "timeout" : exitCode === 0 ? "succeeded" : "failed",
          exitCode: exitCode ?? undefined,
          signal: signal ?? undefined,
          stdout: decode(stdout),
          stderr: decode(stderr),
          timedOut
        });
      });
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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

function appendBounded(buffers: Buffer[], chunk: Buffer, maxOutputBytes: number): void {
  const used = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (used >= maxOutputBytes) return;
  buffers.push(chunk.subarray(0, Math.max(0, maxOutputBytes - used)));
}

function decode(buffers: readonly Buffer[]): string {
  return Buffer.concat(buffers).toString("utf8");
}
