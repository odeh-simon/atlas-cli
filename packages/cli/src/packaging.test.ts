import { existsSync, readFileSync } from "node:fs";
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
    expect(rootPackage.scripts?.["release:bundle"]).toBe("node scripts/build-release.mjs");
    expect(rootPackage.scripts?.["release:smoke"]).toBe("node scripts/release-smoke.mjs");
    expect(cliPackage.bin?.atlas).toBe("./dist/index.js");
    expect(cliPackage.files).toContain("dist");
    expect(cliPackage.files).toContain("README.md");
    expect(cliPackage.engines?.node).toBe(">=22.0.0");
    expect(readFileSync(join(process.cwd(), "DOCs", "Atlas_CLI_Install_and_Release.md"), "utf8")).toContain(
      "Portable Release"
    );
    expect(existsSync(join(process.cwd(), "scripts", "build-release.mjs"))).toBe(true);
    expect(existsSync(join(process.cwd(), "scripts", "release-smoke.mjs"))).toBe(true);
  });
});
