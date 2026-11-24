import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, stableHash } from "@sigil/domain";

import {
  DEFAULT_FIXTURE_FILES,
  FIXTURE_NOW_ISO,
  FIXTURE_ROOT_PATH,
  fixtureRepoTree,
  sampleEvidenceIndexInput,
  sha256Text,
  type FixtureFileSpec
} from "./index.js";

const tempRoots: string[] = [];

function tempRoot(prefix = "sigil-test-utils-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function readTree(dir: string, relative = ""): FixtureFileSpec[] {
  const specs: FixtureFileSpec[] = [];
  for (const entry of readdirSync(relative === "" ? dir : join(dir, relative)).sort()) {
    const entryPath = relative === "" ? entry : `${relative}/${entry}`;
    if (statSync(join(dir, entryPath)).isDirectory()) {
      specs.push(...readTree(dir, entryPath));
    } else {
      specs.push({ path: entryPath, content: readFileSync(join(dir, entryPath), "utf8") });
    }
  }
  return specs;
}

describe("evidence index fixtures", () => {
  it("produces identical normalized inputs for identical trees written to different temp dirs", () => {
    const dirA = tempRoot("sigil-fixture-tree-a-");
    const dirB = tempRoot("sigil-fixture-tree-b-");

    fixtureRepoTree(dirA, DEFAULT_FIXTURE_FILES);
    fixtureRepoTree(dirB, DEFAULT_FIXTURE_FILES);

    const treeA = readTree(dirA);
    const treeB = readTree(dirB);

    expect(treeB).toEqual(treeA);
    expect(treeA.map((spec) => spec.path)).toEqual(DEFAULT_FIXTURE_FILES.map((spec) => spec.path));

    const inputA = sampleEvidenceIndexInput({ files: treeA });
    const inputB = sampleEvidenceIndexInput({ files: treeB });

    expect(canonicalJson(inputB)).toBe(canonicalJson(inputA));
    expect(stableHash(inputB)).toBe(stableHash(inputA));
  });

  it("returns the same bytes when invoked twice with the same options", () => {
    const first = sampleEvidenceIndexInput();
    const second = sampleEvidenceIndexInput();

    expect(Buffer.from(canonicalJson(second), "utf8").equals(Buffer.from(canonicalJson(first), "utf8"))).toBe(true);
    expect(stableHash(first)).toBe(stableHash(second));
    expect(first.repository.rootPath).toBe(FIXTURE_ROOT_PATH);
    expect(first.createdAt).toBe(FIXTURE_NOW_ISO);
    expect(sha256Text(FIXTURE_ROOT_PATH)).toHaveLength(64);
  });

  it("varies identity by seed while keeping file-derived facts stable", () => {
    const alpha = sampleEvidenceIndexInput({ seed: "alpha" });
    const beta = sampleEvidenceIndexInput({ seed: "beta" });

    expect(alpha.repository.displayName).not.toBe(beta.repository.displayName);
    expect(alpha.relevantInputsSha256).not.toBe(beta.relevantInputsSha256);
    expect(alpha.files?.map((file) => file.uri)).toEqual(beta.files?.map((file) => file.uri));
  });
});
