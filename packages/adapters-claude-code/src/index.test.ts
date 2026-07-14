import { describe, expect, it } from "vitest";

import { formatClaudeCodePackage, getClaudeCodeAdapterHealth, invokeClaudeCode } from "./index.js";

describe("Claude Code adapter", () => {
  it("reports health and formats handoff packages", () => {
    expect(getClaudeCodeAdapterHealth()).toMatchObject({
      provider: "claude-code",
      configured: false,
      writable: false
    });
    expect(getClaudeCodeAdapterHealth({ command: "claude" })).toMatchObject({ configured: true, command: "claude" });

    expect(
      formatClaudeCodePackage({
        mode: "fix",
        instructions: "Fix the accepted finding.",
        artifactIds: ["art_fix"]
      })
    ).toContain("Mode: fix");
  });

  it("invokes a Claude-compatible executable with print args", async () => {
    const result = await invokeClaudeCode({
      command: process.execPath,
      package: {
        mode: "review",
        instructions: "Review only.",
        artifactIds: ["art_review"]
      },
      timeoutMs: 1_000
    });

    expect(result.provider).toBe("claude-code");
    expect(result.process.status).toBe("failed");
    expect(result.process.stderr.length).toBeGreaterThan(0);
    expect(result.process.args[0]).toBe("--print");
  });
});
