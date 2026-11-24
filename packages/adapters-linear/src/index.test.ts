import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  commentLinearIssue,
  fetchLinearIssue,
  getLinearAdapterHealth,
  isLinearIssueKey,
  normalizeLinearIssue,
  readLinearIssueFixture
} from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sigil-linear-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Linear adapter", () => {
  it("normalizes issue fixture data into a stable snapshot", () => {
    const snapshot = normalizeLinearIssue({
      id: "lin_123",
      identifier: "ENG-42",
      title: "Build intake",
      description: "Create the intake flow.",
      url: "https://linear.app/acme/issue/ENG-42/build-intake",
      state: { name: "Todo" },
      priority: { label: "High" },
      labels: [{ name: "backend" }, { name: "sigil" }],
      assignee: { displayName: "Ada" },
      comments: [{ id: "comment_1", user: { name: "Grace" }, body: "Use the local CLI first." }],
      links: [{ title: "Spec", url: "https://example.test/spec" }]
    });

    expect(snapshot).toMatchObject({
      provider: "linear",
      issueKey: "ENG-42",
      title: "Build intake",
      state: "Todo",
      priority: "High",
      assignee: "Ada"
    });
    expect(snapshot.labels).toEqual(["backend", "sigil"]);
    expect(snapshot.comments[0]).toMatchObject({ author: "Grace", body: "Use the local CLI first." });
    expect(snapshot.links[0]).toMatchObject({ title: "Spec", url: "https://example.test/spec" });
  });

  it("reads fixtures from disk", () => {
    const root = tempRoot();
    const filePath = join(root, "issue.json");
    writeFileSync(filePath, JSON.stringify({ identifier: "OPS-7", title: "Triage" }));

    expect(readLinearIssueFixture(filePath)).toMatchObject({ issueKey: "OPS-7", title: "Triage" });
  });

  it("validates issue keys and reports fixture-mode health", () => {
    expect(isLinearIssueKey("ENG-1")).toBe(true);
    expect(isLinearIssueKey("eng-1")).toBe(false);
    expect(getLinearAdapterHealth()).toMatchObject({ configured: false, writable: false, mode: "fixture" });
    expect(getLinearAdapterHealth({ apiKey: "lin_api_key" })).toMatchObject({
      configured: true,
      mode: "api-token-present"
    });
  });

  it("rejects malformed issue fixtures", () => {
    expect(() => normalizeLinearIssue({ identifier: "bad", title: "Nope" })).toThrow("Linear issue key");
    expect(() => normalizeLinearIssue({ identifier: "ENG-1" })).toThrow("Linear issue title");
  });

  it("fetches issue snapshots from the Linear GraphQL API", async () => {
    const calls: unknown[] = [];
    const snapshot = await fetchLinearIssue({
      apiKey: "lin_api_key",
      issueKey: "ENG-42",
      fetchImpl: (async (_url, init) => {
        calls.push(init);
        return new Response(
          JSON.stringify({
            data: {
              issue: {
                id: "issue-id",
                identifier: "ENG-42",
                title: "Build intake",
                description: "Create the intake flow.",
                state: { name: "Todo" },
                priorityLabel: "High",
                labels: { nodes: [{ name: "sigil" }] },
                comments: { nodes: [{ id: "c1", body: "Use CLI.", user: { displayName: "Ada" } }] },
                attachments: { nodes: [{ title: "Spec", url: "https://example.test/spec" }] }
              }
            }
          }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    expect(snapshot).toMatchObject({ issueKey: "ENG-42", title: "Build intake", priority: "High" });
    expect(snapshot.labels).toEqual(["sigil"]);
    expect(calls[0]).toMatchObject({ method: "POST" });
  });

  it("writes issue comments through the Linear API", async () => {
    const result = await commentLinearIssue({
      apiKey: "lin_api_key",
      issueId: "issue-id",
      body: "Sigil completed the run.",
      fetchImpl: (async (_url, init) => {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ authorization: "lin_api_key" });
        expect(String(init?.body)).toContain("Sigil completed the run.");
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }),
          { status: 200 }
        );
      }) as typeof fetch
    });

    expect(result).toMatchObject({ provider: "linear", target: "issue-id", status: "written", remoteId: "comment-id" });
  });
});
