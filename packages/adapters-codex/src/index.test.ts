import { describe, expect, it } from "vitest";

import { formatCodexPackage, getCodexAdapterHealth, invokeCodex } from "./index.js";

describe("Codex adapter", () => {
  it("reports health and formats handoff packages", () => {
    expect(getCodexAdapterHealth()).toMatchObject({ provider: "codex", configured: false, writable: false });
    expect(getCodexAdapterHealth({ command: "codex" })).toMatchObject({ configured: true, command: "codex" });

    expect(
      formatCodexPackage({
        mode: "implement",
        instructions: "Ship the change.",
        artifactIds: ["art_contract"]
      })
    ).toContain("Mode: implement");
  });

  it("invokes a Codex-compatible executable with prompt args", async () => {
    const result = await invokeCodex({
      command: failingCommand(),
      package: {
        mode: "review",
        instructions: "Review only.",
        artifactIds: ["art_review"]
      },
      timeoutMs: 10_000
    });

    expect(result.provider).toBe("codex");
    expect(result.process.status).toBe("failed");
    expect(result.process.stderr.length).toBeGreaterThan(0);
    expect(result.process.args[0]).toBe("--prompt");
  });
});

function failingCommand(): string {
  return process.platform === "win32" ? "git" : process.execPath;
}
