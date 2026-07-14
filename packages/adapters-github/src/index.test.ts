import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getGitHubAdapterHealth,
  normalizeGitHubRepository,
  parseGitHubReference,
  readGitHubFixture
} from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-github-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("GitHub adapter", () => {
  it("parses repository, pull request, and issue URLs", () => {
    expect(parseGitHubReference("https://github.com/acme/atlas")).toMatchObject({
      kind: "repository",
      owner: "acme",
      repo: "atlas"
    });
    expect(parseGitHubReference("https://github.com/acme/atlas/pull/12")).toMatchObject({
      kind: "pull_request",
      number: 12
    });
    expect(parseGitHubReference("https://github.com/acme/atlas/issues/7")).toMatchObject({
      kind: "issue",
      number: 7
    });
  });

  it("normalizes repository fixture metadata", () => {
    const snapshot = normalizeGitHubRepository({
      owner: "acme",
      repo: "atlas",
      defaultBranch: "main",
      pullRequests: [
        { number: 2, title: "Second", state: "open", headRef: "feature/b", baseRef: "main" },
        { number: 1, title: "First", state: "merged" }
      ]
    });

    expect(snapshot).toMatchObject({ provider: "github", owner: "acme", repo: "atlas", defaultBranch: "main" });
    expect(snapshot.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([1, 2]);
  });

  it("reads fixtures and reports health", () => {
    const root = tempRoot();
    const filePath = join(root, "github.json");
    writeFileSync(filePath, JSON.stringify({ owner: "acme", repo: "atlas" }));

    expect(readGitHubFixture(filePath)).toMatchObject({ owner: "acme", repo: "atlas" });
    expect(getGitHubAdapterHealth()).toMatchObject({ configured: false, mode: "fixture", writable: false });
  });

  it("rejects malformed references and fixtures", () => {
    expect(() => parseGitHubReference("https://example.test/acme/atlas")).toThrow("github.com");
    expect(() => normalizeGitHubRepository({ owner: "acme" })).toThrow("owner and repo");
  });
});
