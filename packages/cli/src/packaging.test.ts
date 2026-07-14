import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CLI packaging metadata", () => {
  it("exposes an atlas executable from root and CLI package metadata", () => {
    const rootPackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
      engines?: Record<string, string>;
    };
    const cliPackage = JSON.parse(readFileSync(join(process.cwd(), "packages", "cli", "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      files?: string[];
      engines?: Record<string, string>;
    };

    expect(rootPackage.bin?.atlas).toBe("./packages/cli/dist/index.js");
    expect(rootPackage.scripts?.atlas).toBe("node packages/cli/dist/index.js");
    expect(cliPackage.bin?.atlas).toBe("./dist/index.js");
    expect(cliPackage.files).toContain("dist");
    expect(cliPackage.files).toContain("README.md");
    expect(cliPackage.engines?.node).toBe(">=22.0.0");
  });
});
