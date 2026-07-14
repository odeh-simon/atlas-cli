import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  fetchFigmaFileSnapshot,
  getFigmaAdapterHealth,
  normalizeFigmaSnapshot,
  parseFigmaReference,
  readFigmaFixture
} from "./index.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-figma-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Figma adapter", () => {
  it("parses Figma design URLs", () => {
    const reference = parseFigmaReference(
      "https://www.figma.com/design/AbCdEf123456/Product?node-id=10-20&t=token"
    );

    expect(reference).toMatchObject({
      kind: "design",
      fileKey: "AbCdEf123456",
      nodeId: "10-20"
    });
  });

  it("normalizes fixture metadata and evidence", () => {
    const snapshot = normalizeFigmaSnapshot({
      fileKey: "ABC123",
      name: "Checkout",
      url: "https://www.figma.com/file/ABC123/Checkout",
      nodeId: "1:2",
      lastModified: "2026-07-14T10:00:00.000Z",
      evidence: [
        { kind: "screenshot", title: "Main frame", url: "file:///tmp/frame.png" },
        { kind: "note", title: "Constraint", text: "Use compact layout." }
      ]
    });

    expect(snapshot).toMatchObject({ provider: "figma", fileKey: "ABC123", name: "Checkout", nodeId: "1:2" });
    expect(snapshot.evidence).toEqual([
      { kind: "screenshot", title: "Main frame", value: "file:///tmp/frame.png" },
      { kind: "note", title: "Constraint", value: "Use compact layout." }
    ]);
  });

  it("reads fixtures and reports health", () => {
    const root = tempRoot();
    const filePath = join(root, "figma.json");
    writeFileSync(filePath, JSON.stringify({ fileKey: "ABC123", name: "Checkout" }));

    expect(readFigmaFixture(filePath)).toMatchObject({ fileKey: "ABC123", name: "Checkout" });
    expect(getFigmaAdapterHealth()).toMatchObject({ configured: false, mode: "fixture", writable: false });
  });

  it("rejects malformed references and fixtures", () => {
    expect(() => parseFigmaReference("https://example.test/file/ABC")).toThrow("figma.com");
    expect(() => normalizeFigmaSnapshot({ name: "Missing key" })).toThrow("fileKey");
  });

  it("fetches file metadata from the Figma REST API", async () => {
    const reference = parseFigmaReference("https://www.figma.com/design/ABC123/Product?node-id=1-2");
    const snapshot = await fetchFigmaFileSnapshot({
      apiKey: "figd_api_key",
      reference,
      fetchImpl: (async (url, init) => {
        expect(String(url)).toContain("ids=1-2");
        expect(init?.headers).toMatchObject({ "x-figma-token": "figd_api_key" });
        return new Response(JSON.stringify({ name: "Product", lastModified: "2026-07-14T10:00:00Z", version: "1" }), {
          status: 200
        });
      }) as typeof fetch
    });

    expect(snapshot).toMatchObject({ fileKey: "ABC123", name: "Product", nodeId: "1-2" });
    expect(snapshot.evidence.map((evidence) => evidence.title)).toContain("Figma node id");
  });
});
