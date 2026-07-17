import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getCredentialToken, listCredentials, redactSecretText, removeCredential, storeCredential } from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-security-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("credential aliases", () => {
  it("stores, lists, reads, and removes credentials by alias without listing raw tokens", () => {
    const env = { ATLAS_HOME: tempRoot() };
    const token = "figd_example_secret_token";

    const stored = storeCredential({ env, alias: "figma.default", provider: "figma", token });
    const listed = listCredentials({ env });

    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(listed).toEqual([stored]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(getCredentialToken({ env, alias: "figma.default", provider: "figma" })).toBe(token);
    expect(removeCredential({ env, alias: "figma.default" })).toBe(true);
    expect(listCredentials({ env })).toEqual([]);
  });

  it("stores AI provider credentials", () => {
    const env = { ATLAS_HOME: tempRoot() };
    const token = "sk_example_secret_token";

    const stored = storeCredential({ env, alias: "openrouter.default", provider: "ai", token });

    expect(stored.provider).toBe("ai");
    expect(getCredentialToken({ env, alias: "openrouter.default", provider: "ai" })).toBe(token);
    expect(JSON.stringify(listCredentials({ env }))).not.toContain(token);
  });

  it("redacts common token-like text", () => {
    expect(redactSecretText("token figd_example_secret_token")).toBe("token [REDACTED]");
    expect(redactSecretText("token sk_example_secret_token")).toBe("token [REDACTED]");
  });
});
