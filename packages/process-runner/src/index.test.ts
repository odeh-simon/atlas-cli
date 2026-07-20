import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProcess } from "./index.js";

describe("runProcess", () => {
  it("runs an executable with argument arrays and captures stdout", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('hello')"]
    });

    expect(result.status).toBe("succeeded");
    expect(result.runId).toMatch(/^run_/);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toMatch(/^\d{4}-/);
  });

  it("captures non-zero exits and stderr", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.error('bad'); process.exit(3)"]
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe("bad");
  });

  it("times out long-running processes", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 50
    });

    expect(result.status).toBe("timeout");
    expect(result.timedOut).toBe(true);
  });

  it("redacts secret-like output", async () => {
    const result = await runProcess({
      runId: "run_test",
      command: process.execPath,
      args: ["-e", "console.log('sk_example_secret_token_1234567890'); console.error('abcdefghijabcdefghijabcdefghijabcdefghij')"],
      maxOutputBytes: 1_000
    });

    expect(result.runId).toBe("run_test");
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("sk_example_secret");
    expect(result.stderr).not.toContain("abcdefghijabcdefghijabcdefghijabcdefghij");
    expect(result.redacted).toBe(true);
  });

  it("reports output truncation", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('this-output-is-longer-than-the-limit')"],
      maxOutputBytes: 12
    });

    expect(result.stdout).toBe("this-output-");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("rejects cwd outside an allowed root", async () => {
    const root = join(tmpdir(), `atlas-runner-${Date.now()}`);
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed, { recursive: true });
    mkdirSync(outside, { recursive: true });

    try {
      await expect(
        runProcess({
          command: process.execPath,
          args: ["-e", "console.log('nope')"],
          cwd: outside,
          allowedCwdRoot: allowed
        })
      ).rejects.toThrow("contained within the allowed cwd root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes only allowlisted environment variables", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log(`${process.env.ATLAS_ALLOWED}:${process.env.ATLAS_BLOCKED ?? 'missing'}`)"],
      env: { ATLAS_ALLOWED: "yes", ATLAS_BLOCKED: "secret" },
      envAllowlist: ["ATLAS_ALLOWED"]
    });

    expect(result.stdout.trim()).toBe("yes:missing");
  });

  it("rejects shell-like command strings", async () => {
    await expect(runProcess({ command: "node && echo unsafe" })).rejects.toThrow("not a shell command");
  });
});
