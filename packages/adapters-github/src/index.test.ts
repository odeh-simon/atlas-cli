import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  commentGitHubPullRequest,
  fetchGitHubRepositorySnapshot,
  getGitHubAdapterHealth,
  normalizeGitHubRepository,
  parseGitHubReference,
  readGitHubFixture
} from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-github-"));
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
    expect(parseGitHubReference("https://github.com/acme/sigil")).toMatchObject({
      kind: "repository",
      owner: "acme",
      repo: "sigil"
    });
    expect(parseGitHubReference("https://github.com/acme/sigil/pull/12")).toMatchObject({
      kind: "pull_request",
      number: 12
    });
    expect(parseGitHubReference("https://github.com/acme/sigil/issues/7")).toMatchObject({
      kind: "issue",
      number: 7
    });
  });

  it("normalizes repository fixture metadata", () => {
    const snapshot = normalizeGitHubRepository({
      owner: "acme",
      repo: "sigil",
      defaultBranch: "main",
      pullRequests: [
        { number: 2, title: "Second", state: "open", headRef: "feature/b", baseRef: "main" },
        { number: 1, title: "First", state: "merged" }
      ]
    });

    expect(snapshot).toMatchObject({ provider: "github", owner: "acme", repo: "sigil", defaultBranch: "main" });
    expect(snapshot.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([1, 2]);
  });

  it("reads fixtures and reports health", () => {
    const root = tempRoot();
    const filePath = join(root, "github.json");
    writeFileSync(filePath, JSON.stringify({ owner: "acme", repo: "sigil" }));

    expect(readGitHubFixture(filePath)).toMatchObject({ owner: "acme", repo: "sigil" });
    expect(getGitHubAdapterHealth()).toMatchObject({ configured: false, mode: "fixture", writable: false });
  });

  it("rejects malformed references and fixtures", () => {
    expect(() => parseGitHubReference("https://example.test/acme/sigil")).toThrow("github.com");
    expect(() => normalizeGitHubRepository({ owner: "acme" })).toThrow("owner and repo");
  });

  it("fetches repository and pull request metadata from GitHub REST", async () => {
    const urls: string[] = [];
    const snapshot = await fetchGitHubRepositorySnapshot({
      token: "ghp_token",
      reference: parseGitHubReference("https://github.com/acme/sigil/pull/12"),
      fetchImpl: (async (url, init) => {
        urls.push(String(url));
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_token" });
        if (String(url).endsWith("/pulls/12")) {
          return new Response(
            JSON.stringify({
              number: 12,
              title: "Improve CLI",
              state: "open",
              head: { ref: "feature" },
              base: { ref: "main" },
              html_url: "https://github.com/acme/sigil/pull/12"
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            default_branch: "main",
            html_url: "https://github.com/acme/sigil",
            description: "Sigil"
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    expect(urls).toHaveLength(2);
    expect(snapshot).toMatchObject({ owner: "acme", repo: "sigil", defaultBranch: "main" });
    expect(snapshot.pullRequests[0]).toMatchObject({ number: 12, headRef: "feature", baseRef: "main" });
  });

  it("writes pull request comments through GitHub REST", async () => {
    const result = await commentGitHubPullRequest({
      token: "ghp_token",
      reference: parseGitHubReference("https://github.com/acme/sigil/pull/12"),
      body: "Sigil run completed.",
      fetchImpl: (async (url, init) => {
        expect(String(url)).toBe("https://api.github.com/repos/acme/sigil/issues/12/comments");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ authorization: "Bearer ghp_token" });
        return new Response(JSON.stringify({ html_url: "https://github.com/acme/sigil/pull/12#issuecomment-1" }), {
          status: 201
        });
      }) as typeof fetch
    });

    expect(result).toMatchObject({
      provider: "github",
      status: "written",
      remoteUrl: "https://github.com/acme/sigil/pull/12#issuecomment-1"
    });
  });
});
