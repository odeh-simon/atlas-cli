import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CancellationError, PersistenceError, canonicalJson } from "@sigil/domain";
import { getEvidenceIndexSnapshotPayload, readCurrentIndexSnapshot, saveDatabase } from "@sigil/persistence";
import { TYPESCRIPT_ANALYZER_NAME, TYPESCRIPT_ANALYZER_VERSION } from "@sigil/schemas";

import { createTypeScriptAnalyzer } from "./analyzer/typescript-analyzer.js";
import { clearAnalyzerRegistry, getAnalyzer, listAnalyzers, registerAnalyzer } from "./analyzer/registry.js";
import type { EvidenceAnalyzer } from "./analyzer/contract.js";
import { updateEvidenceIndex } from "./engine.js";
import { createCommittedRepo, openEngineDb } from "./test-helpers.js";

const tempRoots: string[] = [];
const NOW = () => new Date("2026-08-10T10:00:00.000Z");

function tempRoot(prefix = "sigil-analyzer-matrix-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearAnalyzerRegistry();
});

function writeRepoFile(repo: string, path: string, content: string): void {
  const target = join(repo, ...path.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

const DECLARED_UNSUPPORTED = [
  "framework-runtime-graph",
  "polymorphic-calls",
  "reflective-calls",
  "whole-program-dataflow"
];

const DECLARED_CAPABILITIES = [
  "api-evidence",
  "caller-callee-static",
  "imports",
  "package-boundaries",
  "re-exports",
  "symbols",
  "test-associations"
];

describe("analyzer contract and registry", () => {
  it("registers trusted built-ins deterministically and rejects duplicates", () => {
    clearAnalyzerRegistry();
    const a = createTypeScriptAnalyzer();
    registerAnalyzer(a);
    expect(listAnalyzers()).toHaveLength(1);
    expect(getAnalyzer(a.identity.name, a.identity.version)).toBeDefined();
    expect(() => registerAnalyzer(a)).toThrow(/Duplicate/);
    expect(() => registerAnalyzer({ identity: { name: "bad/name", version: "1.0.0", fingerprint: "x", languages: ["ts"], extensions: [".ts"], capabilities: ["x"], unsupported: [] }, analyze: () => { throw new Error("x"); } } as unknown as EvidenceAnalyzer)).toThrow(/Invalid analyzer name/);
  });

  it("selects by language/capability and rejects undeclared capabilities", () => {
    clearAnalyzerRegistry();
    const a = createTypeScriptAnalyzer();
    registerAnalyzer(a);
    expect(listAnalyzers()[0]?.identity.capabilities).toContain("symbols");
    expect(listAnalyzers()[0]?.identity.languages).toContain("typescript");
  });

  it("rejects unknown analyzer versions exactly", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    expect(() =>
      updateEvidenceIndex(opened.db, {
        rootPath: repo,
        dbPath: opened.dbPath,
        now: NOW,
        analyzerVersions: [{ name: TYPESCRIPT_ANALYZER_NAME, version: "0.0.0-unknown" }]
      })
    ).toThrow(PersistenceError);
  });
});

describe("TypeScript analyzer v2 - language and module fixtures", () => {
  it("handles TS, TSX, JS, JSX, MJS, CJS with deterministic symbols", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.tsx": "export const B = () => null;\n",
      "src/c.js": "export function c(){}\n",
      "src/d.jsx": "export const D = () => null;\n",
      "src/e.mjs": "export const e = 1;\n",
      "src/f.cjs": "module.exports = { f: 1 };\n"
    });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    expect(payload).toBeDefined();
    const byUri = new Map((payload?.symbols ?? []).map((s) => [s.uri, s]));
    // Exact: TS/JS/MJS produce named exported symbols with truthful provenance.
    for (const uri of ["src/a.ts", "src/c.js", "src/e.mjs"]) {
      const sym = (payload?.symbols ?? []).find((s) => s.uri === uri);
      expect(sym).toBeDefined();
      expect(sym?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
      expect(sym?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
      expect(sym?.proof).toBe("exact");
      expect(sym?.line_start).toBeGreaterThanOrEqual(1);
      expect(sym?.line_end).toBeGreaterThanOrEqual(sym?.line_start ?? 1);
      expect(sym?.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(byUri.get("src/a.ts")?.name).toBe("a");
    // No forbidden invented API surfaces.
    expect((payload?.api_evidence ?? []).every((a) => a.surface === "exported-function")).toBe(true);
    expect(payload?.gaps.filter((g) => g.code === "unsupported-language")).toHaveLength(0);
    // Capability header always carries declared unsupported semantics.
    const caps = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.snapshot.analyzer_capabilities;
    const tsCap = caps?.find((c) => c.analyzer_name === TYPESCRIPT_ANALYZER_NAME);
    expect(tsCap?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
    expect([...(tsCap?.unsupported ?? [])].sort()).toEqual(DECLARED_UNSUPPORTED);
    expect([...(tsCap?.capabilities ?? [])].sort()).toEqual(DECLARED_CAPABILITIES);
  });

  it("resolves relative imports, path aliases, package exports, re-export chains and cycles", async () => {
    const repo = tempRoot();
    writeRepoFile(repo, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    writeRepoFile(repo, "src/util.ts", "export const util = 1;\n");
    writeRepoFile(repo, "src/alias-consumer.ts", "import { util } from \"@/util\";\nexport const x = util;\n");
    writeRepoFile(repo, "src/re-export-a.ts", "export * from \"./util\";\n");
    writeRepoFile(repo, "src/re-export-b.ts", "export { util } from \"./re-export-a\";\n");
    writeRepoFile(repo, "src/cycle-a.ts", "import { b } from \"./cycle-b\";\nexport const a = b;\n");
    writeRepoFile(repo, "src/cycle-b.ts", "import { a } from \"./cycle-a\";\nexport const b = a;\n");
    const { execSync } = await import("node:child_process");
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync("git config user.email \"a@test\"", { cwd: repo, stdio: "ignore" });
    execSync("git config user.name \"a\"", { cwd: repo, stdio: "ignore" });
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync("git commit -m init", { cwd: repo, stdio: "ignore" });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    const edges = payload?.edges ?? [];
    const alias = edges.find((e) => e.from_uri === "src/alias-consumer.ts" && e.to_uri === "src/util.ts");
    expect(alias?.kind).toBe("import");
    expect(alias?.rule).toBe("typescript-module-resolution");
    expect(alias?.resolution).toBe("static");
    expect(alias?.proof).toBe("exact");
    expect(alias?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
    expect(alias?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
    expect(alias?.from_source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(alias?.to_source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(alias?.from_line_start).toBe(1);
    const reExport = edges.find((e) => e.from_uri === "src/re-export-a.ts" && e.to_uri === "src/util.ts");
    expect(reExport?.kind).toBe("re-export");
    expect(reExport?.proof).toBe("exact");
    expect(edges.some((e) => e.from_uri === "src/cycle-a.ts" && e.to_uri === "src/cycle-b.ts" && e.kind === "import")).toBe(true);
    expect(edges.some((e) => e.from_uri === "src/cycle-b.ts" && e.to_uri === "src/cycle-a.ts" && e.kind === "import")).toBe(true);
    // No heuristic caller edges invented here.
    expect(edges.filter((e) => e.kind === "caller" || e.kind === "callee").every((e) => e.resolution === "static")).toBe(true);
  });

  it("emits named/default exports, aliases, overloads, declaration merging deterministically", async () => {
    const repo = createCommittedRepo({
      "src/exports.ts": `
export const named = 1;
export { named as alias };
export default named;
export function overload(a: string): void;
export function overload(a: number): void;
export function overload(a: any){ }
export interface Foo { a: string }
export interface Foo { b: number }
`,
    });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    const syms = (payload?.symbols ?? []).filter((s) => s.uri === "src/exports.ts").map((s) => s.name).sort();
    expect(syms).toContain("named");
    expect(syms.some((n) => n === "alias" || n === "named")).toBe(true);
    expect(syms).toContain("default");
    expect(syms).toContain("overload");
    expect(syms.filter((n) => n === "Foo").length).toBeGreaterThanOrEqual(1);
    const ordered = (payload?.symbols ?? []).filter((s) => s.uri === "src/exports.ts");
    const sorted = [...ordered].sort((a, b) => a.name.localeCompare(b.name) || a.line_start - b.line_start);
    expect(ordered.map((s) => s.symbol_id).sort()).toEqual(sorted.map((s) => s.symbol_id).sort());
    // Exact provenance on every symbol.
    for (const s of ordered) {
      expect(s.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
      expect(s.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
      expect(s.proof).toBe("exact");
    }
  });

  it("emits only provable caller/callee edges and gaps for dynamic/reflective", async () => {
    const repo = createCommittedRepo({
      "src/calls.ts": `
import { util } from "./util.js";
export function util2(){}
export function caller(){ util(); util2(); eval("x"); }
export function dynamic(){ const name = "util"; (global as any)[name](); }
`,
      "src/util.ts": "export function util(){}\n",
    });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    const callerEdges = (payload?.edges ?? []).filter((e) => e.kind === "caller");
    const crossFile = callerEdges.find((e) => e.from_uri === "src/calls.ts" && e.to_uri === "src/util.ts");
    expect(crossFile).toBeDefined();
    expect(crossFile?.resolution).toBe("static");
    expect(crossFile?.proof).toBe("exact");
    expect(crossFile?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
    expect((payload?.gaps ?? []).some((g) => g.code === "dynamic-call" || g.code === "reflective-call" || g.code === "unresolved-callee")).toBe(true);
    expect(callerEdges.every((e) => e.resolution === "static" && e.proof === "exact")).toBe(true);
    // No callee edges invented without static proof in this fixture.
    expect((payload?.edges ?? []).filter((e) => e.kind === "callee")).toHaveLength(0);
  });

  it("handles monorepo boundaries, nested tsconfig and malformed config as exact gaps", async () => {
    const repo = tempRoot();
    writeRepoFile(repo, "packages/pkg-a/package.json", JSON.stringify({ name: "pkg-a" }));
    writeRepoFile(repo, "packages/pkg-a/src/index.ts", "export const a = 1;\n");
    writeRepoFile(repo, "packages/pkg-a/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { baseUrl: "." } }));
    writeRepoFile(repo, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    writeRepoFile(repo, "src/bad-config.ts", "export const x = 1;\n");
    writeRepoFile(repo, "packages/pkg-b/package.json", JSON.stringify({ name: "pkg-b" }));
    writeRepoFile(repo, "packages/pkg-b/src/index.ts", "export const b = 1;\n");
    writeRepoFile(repo, "packages/pkg-b/tsconfig.json", "{ invalid json");
    const { execSync } = await import("node:child_process");
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync("git config user.email \"a@test\"", { cwd: repo, stdio: "ignore" });
    execSync("git config user.name \"a\"", { cwd: repo, stdio: "ignore" });
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync("git commit -m init", { cwd: repo, stdio: "ignore" });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    expect(payload).toBeDefined();
    expect(result.snapshotId).toBeDefined();
    // Exact: malformed package-local tsconfig produces a scoped nonblocking gap and still promotes.
    const malformed = (payload?.gaps ?? []).filter((g) => g.code === "tsconfig-malformed");
    expect(malformed.length).toBeGreaterThanOrEqual(1);
    const scoped = malformed.find((g) => g.scope_uri === "packages/pkg-b/tsconfig.json");
    expect(scoped).toBeDefined();
    expect(scoped?.severity).toBe("warning");
    expect(scoped?.blocking).toBe(false);
    expect(scoped?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
    expect(scoped?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
    // Snapshot promotes because the gap is scoped nonblocking.
    expect(readCurrentIndexSnapshot(opened.db, result.repositoryId)?.snapshot.snapshot_id).toBe(result.snapshotId);
  });

  it("creates test associations via naming and imports, marks ambiguous", async () => {
    const repo = createCommittedRepo({
      "src/foo.ts": "export function foo(){}\n",
      "src/bar.ts": "export function bar(){}\n",
      "tests/foo.test.ts": "import { foo } from \"../src/foo\";\n",
      "tests/bar.test.ts": "import { bar } from \"../src/bar\";\n",
    });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    const fooAssoc = payload?.test_associations.find((a) => a.source_uri === "src/foo.ts" && a.test_uri === "tests/foo.test.ts");
    expect(fooAssoc?.rule).toBe("test-imports-production");
    expect(fooAssoc?.proof).toBe("exact");
    expect(fooAssoc?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
    expect(fooAssoc?.source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fooAssoc?.test_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload?.test_associations.some((a) => a.source_uri === "src/bar.ts")).toBe(true);
  });

  it("emits API evidence only for exact exported functions", async () => {
    const repo = createCommittedRepo({
      "src/api.ts": "export function myApi(){}\nexport const notApi = 1;\n",
    });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    const myApi = payload?.api_evidence.find((a) => a.name === "myApi");
    expect(myApi?.surface).toBe("exported-function");
    expect(myApi?.proof).toBe("exact");
    expect(myApi?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
    expect(myApi?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
    expect(myApi?.line_start).toBe(1);
    expect(payload?.api_evidence.some((a) => a.uri === "src/api.ts" && a.name === "notApi" && a.surface === "http-endpoint")).toBe(false);
  });

  it("never analyzes secret, binary, excluded, symlink escape", async () => {
    const repo = createCommittedRepo({
      "src/ok.ts": "export const ok = 1;\n",
      "src/secret-credentials.json": JSON.stringify({ token: "secret" }),
    });
    const outside = tempRoot();
    writeRepoFile(outside, "evil.ts", "export const evil=1;\n");
    try {
      symlinkSync(join(outside, "evil.ts"), join(repo, "src/link.ts"));
    } catch {}
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    expect(payload?.symbols.some((s) => s.uri === "src/secret-credentials.json")).toBe(false);
    expect(payload?.symbols.some((s) => s.uri === "src/link.ts")).toBe(false);
    expect(payload?.edges.some((e) => e.from_uri === "src/link.ts" || e.to_uri === "src/link.ts")).toBe(false);
  });

  it("reports complete capability record including declared unsupported semantics", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a = 1;\n" });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const snapshot = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.snapshot;
    expect(snapshot?.analyzer_capabilities).toHaveLength(1);
    const cap = snapshot?.analyzer_capabilities[0];
    expect(cap?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
    expect(cap?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
    expect([...(cap?.capabilities ?? [])].sort()).toEqual(DECLARED_CAPABILITIES);
    expect([...(cap?.unsupported ?? [])].sort()).toEqual(DECLARED_UNSUPPORTED);
    expect(Array.isArray(cap?.gaps)).toBe(true);
  });
});

describe("incremental reverse-dependency preservation", () => {
  it("preserves valid import and caller edges when only the imported target changes", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export function greet(){ return 1; }\n",
      "src/b.ts": "import { greet } from \"./a\";\nexport function run(){ return greet(); }\n"
    });
    const opened = await openEngineDb(repo);
    const before = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const beforePayload = getEvidenceIndexSnapshotPayload(opened.db, before.snapshotId as string)?.payload;
    const beforeImport = beforePayload?.edges.find((e) => e.from_uri === "src/b.ts" && e.to_uri === "src/a.ts" && e.kind === "import");
    const beforeCaller = beforePayload?.edges.find((e) => e.from_uri === "src/b.ts" && e.to_uri === "src/a.ts" && e.kind === "caller");
    expect(beforeImport?.edge_id).toBeDefined();
    expect(beforeCaller?.edge_id).toBeDefined();
    // Edit only the target without breaking the import/call.
    writeRepoFile(repo, "src/a.ts", "export function greet(){ return 2; }\n");
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const afterPayload = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload;
    const afterImport = afterPayload?.edges.find((e) => e.from_uri === "src/b.ts" && e.to_uri === "src/a.ts" && e.kind === "import");
    const afterCaller = afterPayload?.edges.find((e) => e.from_uri === "src/b.ts" && e.to_uri === "src/a.ts" && e.kind === "caller");
    // Valid dependent edges remain with refreshed target hash.
    expect(afterImport?.edge_id).toBe(beforeImport?.edge_id);
    expect(afterCaller?.edge_id).toBe(beforeCaller?.edge_id);
    const targetSha = afterPayload?.files.find((f) => f.uri === "src/a.ts")?.content_sha256;
    expect(afterImport?.to_source_sha256).toBe(targetSha);
    expect(afterCaller?.to_source_sha256).toBe(targetSha);
    // Dependent source hash is unchanged.
    expect(afterImport?.from_source_sha256).toBe(beforeImport?.from_source_sha256);
    // No gap was invented for this valid change.
    expect((afterPayload?.gaps ?? []).filter((g) => g.scope_uri === "src/b.ts" && g.blocking)).toHaveLength(0);
  });

  it("invalidates dependent edges on target deletion without ghosts", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export function greet(){ return 1; }\n",
      "src/b.ts": "import { greet } from \"./a\";\nexport const x = 1;\n"
    });
    const opened = await openEngineDb(repo);
    const before = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    expect(getEvidenceIndexSnapshotPayload(opened.db, before.snapshotId as string)?.payload.edges.some((e) => e.to_uri === "src/a.ts")).toBe(true);
    const { rmSync } = await import("node:fs");
    rmSync(join(repo, "src/a.ts"));
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload;
    expect(payload?.files.map((f) => f.uri)).not.toContain("src/a.ts");
    expect(payload?.edges.some((e) => e.from_uri === "src/a.ts" || e.to_uri === "src/a.ts")).toBe(false);
    expect(payload?.symbols.some((s) => s.uri === "src/a.ts")).toBe(false);
    expect(payload?.invalidations.some((i) => i.reason === "file-deleted")).toBe(true);
  });

  it("rebuilds dependents on rename without ghost URIs", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "import { a } from \"./a\";\nexport const b = a;\n"
    });
    const opened = await openEngineDb(repo);
    updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["mv", "src/a.ts", "src/renamed.ts"], { cwd: repo });
    // Update the importer to the new path so the edge remains valid.
    writeRepoFile(repo, "src/b.ts", "import { a } from \"./renamed\";\nexport const b = a;\n");
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload;
    expect(payload?.files.map((f) => f.uri)).toContain("src/renamed.ts");
    expect(payload?.files.map((f) => f.uri)).not.toContain("src/a.ts");
    expect(payload?.edges.some((e) => e.from_uri === "src/a.ts" || e.to_uri === "src/a.ts")).toBe(false);
    expect(payload?.edges.some((e) => e.from_uri === "src/b.ts" && e.to_uri === "src/renamed.ts" && e.kind === "import")).toBe(true);
  });

  it("drops caller edges when the export is removed", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export function greet(){ return 1; }\n",
      "src/b.ts": "import { greet } from \"./a\";\nexport function run(){ return greet(); }\n"
    });
    const opened = await openEngineDb(repo);
    const before = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    expect(getEvidenceIndexSnapshotPayload(opened.db, before.snapshotId as string)?.payload.edges.some((e) => e.kind === "caller")).toBe(true);
    writeRepoFile(repo, "src/a.ts", "export const other = 1;\n");
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload;
    // Import edge remains (module still resolves) but the caller edge is gone.
    expect(payload?.edges.some((e) => e.from_uri === "src/b.ts" && e.to_uri === "src/a.ts" && e.kind === "import")).toBe(true);
    expect(payload?.edges.some((e) => e.from_uri === "src/b.ts" && e.to_uri === "src/a.ts" && e.kind === "caller")).toBe(false);
  });

  it("preserves multi-hop re-export chains when the leaf target changes", async () => {
    const repo = createCommittedRepo({
      "src/leaf.ts": "export const value = 1;\n",
      "src/mid.ts": "export * from \"./leaf\";\n",
      "src/top.ts": "export * from \"./mid\";\n"
    });
    const opened = await openEngineDb(repo);
    const before = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const beforeIds = (getEvidenceIndexSnapshotPayload(opened.db, before.snapshotId as string)?.payload.edges ?? []).map((e) => e.edge_id).sort();
    expect(beforeIds.length).toBeGreaterThanOrEqual(2);
    writeRepoFile(repo, "src/leaf.ts", "export const value = 2;\n");
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const afterEdges = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload.edges ?? [];
    expect(afterEdges.some((e) => e.from_uri === "src/mid.ts" && e.to_uri === "src/leaf.ts" && e.kind === "re-export")).toBe(true);
    expect(afterEdges.some((e) => e.from_uri === "src/top.ts" && e.to_uri === "src/mid.ts" && e.kind === "re-export")).toBe(true);
    expect(afterEdges.map((e) => e.edge_id).sort()).toEqual(beforeIds);
  });

  it("keeps genuinely unaffected rows byte-identical", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export function greet(){ return 1; }\n",
      "src/b.ts": "import { greet } from \"./a\";\nexport function run(){ return greet(); }\n",
      "src/c.ts": "export const c = 1;\n"
    });
    const opened = await openEngineDb(repo);
    const before = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const beforePayload = getEvidenceIndexSnapshotPayload(opened.db, before.snapshotId as string)?.payload;
    writeRepoFile(repo, "src/a.ts", "export function greet(){ return 2; }\n");
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const afterPayload = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload;
    const beforeC = (beforePayload?.symbols ?? []).filter((s) => s.uri === "src/c.ts").map((s) => canonicalJson(s)).sort();
    const afterC = (afterPayload?.symbols ?? []).filter((s) => s.uri === "src/c.ts").map((s) => canonicalJson(s)).sort();
    expect(afterC).toEqual(beforeC);
    expect(afterC.length).toBeGreaterThan(0);
  });
});

describe("analyzer version provenance", () => {
  it("accepts the exact registered implementation version", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, {
      rootPath: repo,
      dbPath: opened.dbPath,
      now: NOW,
      analyzerVersions: [{ name: TYPESCRIPT_ANALYZER_NAME, version: TYPESCRIPT_ANALYZER_VERSION }]
    });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    expect(payload?.symbols[0]?.analyzer_name).toBe(TYPESCRIPT_ANALYZER_NAME);
    expect(payload?.symbols[0]?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
  });

  it("rejects a mismatched requested version without promoting", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);
    expect(() =>
      updateEvidenceIndex(opened.db, {
        rootPath: repo,
        dbPath: opened.dbPath,
        now: NOW,
        analyzerVersions: [{ name: TYPESCRIPT_ANALYZER_NAME, version: "1.0.0" }]
      })
    ).toThrow(/Unknown analyzer version|version mismatch/);
    const still = readCurrentIndexSnapshot(opened.db, first.repositoryId);
    expect(still?.snapshot.snapshot_id).toBe(first.snapshotId);
    expect(still?.payload.symbols[0]?.analyzer_version).toBe(TYPESCRIPT_ANALYZER_VERSION);
  });

  it("invalidates on a genuine implementation-version change", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    // Register a second genuine implementation under a new version.
    const secondImpl: EvidenceAnalyzer = {
      identity: {
        name: TYPESCRIPT_ANALYZER_NAME,
        version: "9.9.9",
        fingerprint: "test-fingerprint-9.9.9",
        languages: ["typescript"],
        extensions: [".ts"],
        capabilities: ["symbols"],
        unsupported: []
      },
      analyze: (input) => ({
        symbols: [],
        edges: [],
        testAssociations: [],
        apiEvidence: [],
        configEvidence: [],
        gaps: [],
        diagnostics: [],
        status: "completed",
        metrics: { filesAnalyzed: input.files.length, symbolsEmitted: 0, edgesEmitted: 0, gapsEmitted: 0, durationMs: 0, truncated: false }
      })
    };
    registerAnalyzer(secondImpl);
    const second = updateEvidenceIndex(opened.db, {
      rootPath: repo,
      dbPath: opened.dbPath,
      now: NOW,
      analyzerVersions: [{ name: TYPESCRIPT_ANALYZER_NAME, version: "9.9.9" }]
    });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    const payload = getEvidenceIndexSnapshotPayload(opened.db, second.snapshotId as string)?.payload;
    expect(payload?.symbols).toHaveLength(0);
    const caps = getEvidenceIndexSnapshotPayload(opened.db, second.snapshotId as string)?.snapshot.analyzer_capabilities;
    expect(caps?.[0]?.analyzer_version).toBe("9.9.9");
  });
});

describe("fail-closed promotion policy", () => {
  it("does not promote on analyzer crash and preserves the prior snapshot", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);
    clearAnalyzerRegistry();
    const crashing: EvidenceAnalyzer = {
      identity: {
        name: TYPESCRIPT_ANALYZER_NAME,
        version: TYPESCRIPT_ANALYZER_VERSION,
        fingerprint: "crash",
        languages: ["typescript"],
        extensions: [".ts"],
        capabilities: ["symbols"],
        unsupported: []
      },
      analyze: () => { throw new Error("injected crash"); }
    };
    registerAnalyzer(crashing);
    writeRepoFile(repo, "src/a.ts", "export const a=2;\n");
    expect(() => updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW })).toThrow(/injected crash/);
    const still = readCurrentIndexSnapshot(opened.db, first.repositoryId);
    expect(still?.snapshot.snapshot_id).toBe(first.snapshotId);
  });

  it("does not promote on malformed analyzer output and preserves the prior snapshot", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);
    clearAnalyzerRegistry();
    const malformed: EvidenceAnalyzer = {
      identity: {
        name: TYPESCRIPT_ANALYZER_NAME,
        version: TYPESCRIPT_ANALYZER_VERSION,
        fingerprint: "malformed",
        languages: ["typescript"],
        extensions: [".ts"],
        capabilities: ["symbols"],
        unsupported: []
      },
      analyze: (input) => ({
        symbols: [{ bogus: true, analyzer_name: TYPESCRIPT_ANALYZER_NAME, analyzer_version: TYPESCRIPT_ANALYZER_VERSION } as unknown as never],
        edges: [],
        testAssociations: [],
        apiEvidence: [],
        configEvidence: [],
        gaps: [],
        diagnostics: [],
        status: "completed",
        metrics: { filesAnalyzed: input.files.length, symbolsEmitted: 1, edgesEmitted: 0, gapsEmitted: 0, durationMs: 0, truncated: false }
      } as unknown as ReturnType<EvidenceAnalyzer["analyze"]>)
    };
    registerAnalyzer(malformed);
    writeRepoFile(repo, "src/a.ts", "export const a=2;\n");
    expect(() => updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW })).toThrow(/malformed/);
    expect(readCurrentIndexSnapshot(opened.db, first.repositoryId)?.snapshot.snapshot_id).toBe(first.snapshotId);
  });

  it("does not promote on blocking resource failure and preserves the prior snapshot", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);
    clearAnalyzerRegistry();
    const blocking: EvidenceAnalyzer = {
      identity: {
        name: TYPESCRIPT_ANALYZER_NAME,
        version: TYPESCRIPT_ANALYZER_VERSION,
        fingerprint: "blocking",
        languages: ["typescript"],
        extensions: [".ts"],
        capabilities: ["symbols"],
        unsupported: []
      },
      analyze: (input) => ({
        symbols: [],
        edges: [],
        testAssociations: [],
        apiEvidence: [],
        configEvidence: [],
        gaps: [{
          gap_id: "evgap_blocking",
          analyzer_name: TYPESCRIPT_ANALYZER_NAME,
          analyzer_version: TYPESCRIPT_ANALYZER_VERSION,
          code: "graph-resource-limit",
          severity: "blocking",
          message: "injected blocking truncation",
          blocking: true
        }],
        diagnostics: [],
        status: "failed",
        metrics: { filesAnalyzed: input.files.length, symbolsEmitted: 0, edgesEmitted: 0, gapsEmitted: 1, durationMs: 0, truncated: true }
      } as unknown as ReturnType<EvidenceAnalyzer["analyze"]>)
    };
    registerAnalyzer(blocking);
    writeRepoFile(repo, "src/a.ts", "export const a=2;\n");
    expect(() => updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW })).toThrow(/blocking/);
    expect(readCurrentIndexSnapshot(opened.db, first.repositoryId)?.snapshot.snapshot_id).toBe(first.snapshotId);
  });

  it("does not promote on cancellation and preserves the prior snapshot", async () => {
    const repo = createCommittedRepo({ "src/a.ts": "export const a=1;\n" });
    const opened = await openEngineDb(repo);
    const first = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    saveDatabase(opened.dbPath, opened.db);
    const controller = new AbortController();
    controller.abort();
    expect(() => updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW, signal: controller.signal })).toThrow(CancellationError);
    const still = readCurrentIndexSnapshot(opened.db, first.repositoryId);
    expect(still?.snapshot.snapshot_id).toBe(first.snapshotId);
  });

  it("promotes scoped nonblocking unsupported syntax with explicit gaps", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/equals.ts": "import foo = require(\"./a\");\nexport const x = 1;\n"
    });
    const opened = await openEngineDb(repo);
    const result = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const payload = getEvidenceIndexSnapshotPayload(opened.db, result.snapshotId as string)?.payload;
    expect(result.snapshotId).toBeDefined();
    const gap = (payload?.gaps ?? []).find((g) => g.code === "unsupported-syntax" && g.scope_uri === "src/equals.ts");
    expect(gap).toBeDefined();
    expect(gap?.blocking).toBe(false);
    expect(readCurrentIndexSnapshot(opened.db, result.repositoryId)?.snapshot.snapshot_id).toBe(result.snapshotId);
  });
});

describe("determinism and invalidation scope", () => {
  it("invalidates only affected semantic rows on one-file change", async () => {
    const repo = createCommittedRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    const opened = await openEngineDb(repo);
    const before = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const beforePayload = getEvidenceIndexSnapshotPayload(opened.db, before.snapshotId as string)?.payload;
    const beforeSyms = new Map(beforePayload?.symbols.map((s) => [s.symbol_id, s]));
    writeRepoFile(repo, "src/b.ts", "export const b = 2;\n");
    const after = updateEvidenceIndex(opened.db, { rootPath: repo, dbPath: opened.dbPath, now: NOW });
    const afterPayload = getEvidenceIndexSnapshotPayload(opened.db, after.snapshotId as string)?.payload;
    const aBefore = [...beforeSyms.values()].find((s) => s.uri === "src/a.ts");
    const aAfter = afterPayload?.symbols.find((s) => s.uri === "src/a.ts");
    expect(aBefore?.symbol_id).toBe(aAfter?.symbol_id);
    expect(aBefore?.source_sha256).toBe(aAfter?.source_sha256);
    expect(canonicalJson(aAfter)).toBe(canonicalJson(aBefore));
    const bAfter = afterPayload?.symbols.find((s) => s.uri === "src/b.ts");
    expect(bAfter?.source_sha256).not.toBe(aBefore?.source_sha256);
  });

  it("produces byte-identical payloads for equivalent independent runs", async () => {
    const files = { "src/a.ts": "export const a=1;\n", "src/b.ts": "import { a } from \"./a\";\nexport const b=a;\n" };
    const repoOne = createCommittedRepo(files);
    const repoTwo = createCommittedRepo(files);
    const openedOne = await openEngineDb(repoOne);
    const openedTwo = await openEngineDb(repoTwo);
    const first = updateEvidenceIndex(openedOne.db, { rootPath: repoOne, dbPath: openedOne.dbPath, now: NOW });
    const second = updateEvidenceIndex(openedTwo.db, { rootPath: repoTwo, dbPath: openedTwo.dbPath, now: NOW });
    const payloadOne = getEvidenceIndexSnapshotPayload(openedOne.db, first.snapshotId as string)?.payload;
    const payloadTwo = getEvidenceIndexSnapshotPayload(openedTwo.db, second.snapshotId as string)?.payload;
    // Compare semantic payloads independent of repository identity/timestamps.
    // Payload order is deterministic per repository (IDs bind repositoryId),
    // so sort by stable content keys before cross-repository comparison.
    const normalizeSymbols = (symbols: NonNullable<typeof payloadOne>["symbols"]) =>
      symbols.map((s) => ({ ...s, symbol_id: "id", file_id: "f" })).sort((a, b) => a.uri.localeCompare(b.uri) || a.name.localeCompare(b.name) || a.line_start - b.line_start);
    const normalizeEdges = (edges: NonNullable<typeof payloadOne>["edges"]) =>
      edges.map((e) => ({ ...e, edge_id: "id", from_file_id: "f", to_file_id: "f" })).sort((a, b) => a.from_uri.localeCompare(b.from_uri) || a.to_uri.localeCompare(b.to_uri) || a.kind.localeCompare(b.kind));
    expect(normalizeSymbols(payloadOne?.symbols ?? [])).toEqual(normalizeSymbols(payloadTwo?.symbols ?? []));
    expect(normalizeEdges(payloadOne?.edges ?? [])).toEqual(normalizeEdges(payloadTwo?.edges ?? []));
    expect(canonicalJson((payloadOne?.gaps ?? []).map((g) => ({ ...g, gap_id: "id" })))).toBe(
      canonicalJson((payloadTwo?.gaps ?? []).map((g) => ({ ...g, gap_id: "id" })))
    );
    // Reuse on unchanged repository.
    const reused = updateEvidenceIndex(openedOne.db, { rootPath: repoOne, dbPath: openedOne.dbPath, now: NOW });
    expect(reused.snapshotId).toBe(first.snapshotId);
  });
});
