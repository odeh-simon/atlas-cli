import { describe, expect, it } from "vitest";

import { runProcess } from "./index.js";

describe("runProcess", () => {
  it("runs an executable with argument arrays and captures stdout", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('hello')"]
    });

    expect(result.status).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
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

  it("rejects shell-like command strings", async () => {
    await expect(runProcess({ command: "node && echo unsafe" })).rejects.toThrow("not a shell command");
  });
});
