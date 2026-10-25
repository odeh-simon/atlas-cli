import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { deriveEvidenceRepositoryIdentity, deriveId, stableHash } from "@atlas/domain";

export const testUtilsPackage = "@atlas/test-utils";

export const FIXTURE_NOW_ISO = "2026-07-12T12:00:00.000Z";
export const FIXTURE_ROOT_PATH = "/repos/atlas-sample";

export interface FixtureFileSpec {
  readonly path: string;
  readonly content: string;
}

export interface SampleEvidenceIndexOptions {
  readonly seed?: string | undefined;
  readonly files?: readonly FixtureFileSpec[] | undefined;
  readonly rootPath?: string | undefined;
}

export interface FixtureRepositoryIdentity {
  readonly displayName: string;
  readonly rootPath: string;
  readonly remoteUrl?: string | undefined;
}

export interface FixtureGitSnapshotInput {
  readonly repositoryId: string;
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly baseFingerprint: string;
  readonly branch?: string | undefined;
  readonly headSha?: string | undefined;
  readonly dirty: boolean;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface FixtureCapabilityInput {
  readonly capability_id: string;
  readonly analyzer_name: string;
  readonly analyzer_version: string;
  readonly languages: string[];
  readonly capabilities: string[];
  readonly unsupported: string[];
  readonly gaps: string[];
}

export interface FixtureFileRow {
  readonly fileId: string;
  readonly repositoryId: string;
  readonly uri: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly lastSeenSnapshotId: string;
}

export interface FixtureContentRow {
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly binary: boolean;
  readonly redacted: boolean;
  readonly sensitivity?: string | undefined;
  readonly storageUri?: string | undefined;
}

export interface FixtureClassificationRow {
  readonly classificationId: string;
  readonly repositoryId: string;
  readonly fileId?: string | undefined;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly category: string;
  readonly sensitivity: string;
  readonly secret: boolean;
  readonly binaryCheck: boolean;
  readonly excluded: boolean;
  readonly excludedReason?: string | undefined;
}

export interface FixtureSymbolRow {
  readonly symbolId: string;
  readonly repositoryId: string;
  readonly fileId: string;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly name: string;
  readonly kind: string;
  readonly exported: boolean;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface FixtureEdgeRow {
  readonly edgeId: string;
  readonly repositoryId: string;
  readonly kind: string;
  readonly fromFileId: string;
  readonly toFileId: string;
  readonly fromUri: string;
  readonly toUri: string;
  readonly rule: string;
  readonly resolution: "static" | "heuristic";
}

export interface FixtureTestAssociationRow {
  readonly associationId: string;
  readonly repositoryId: string;
  readonly testFileId: string;
  readonly sourceFileId: string;
  readonly testUri: string;
  readonly sourceUri: string;
  readonly rule: string;
}

export interface FixtureConfigEvidenceRow {
  readonly configEvidenceId: string;
  readonly repositoryId: string;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly byteLength: number;
  readonly format: string;
  readonly secretRedacted: boolean;
}

export interface FixtureApiEvidenceRow {
  readonly apiEvidenceId: string;
  readonly repositoryId: string;
  readonly fileId: string;
  readonly uri: string;
  readonly sourceSha256: string;
  readonly name: string;
  readonly surface: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface SampleEvidenceIndexInput {
  readonly repository: FixtureRepositoryIdentity;
  readonly gitSnapshot?: FixtureGitSnapshotInput | undefined;
  readonly relevantInputsSha256: string;
  readonly analyzers?: readonly FixtureCapabilityInput[] | undefined;
  readonly files?: readonly FixtureFileRow[] | undefined;
  readonly contents?: readonly FixtureContentRow[] | undefined;
  readonly classifications?: readonly FixtureClassificationRow[] | undefined;
  readonly symbols?: readonly FixtureSymbolRow[] | undefined;
  readonly edges?: readonly FixtureEdgeRow[] | undefined;
  readonly testAssociations?: readonly FixtureTestAssociationRow[] | undefined;
  readonly configEvidence?: readonly FixtureConfigEvidenceRow[] | undefined;
  readonly apiEvidence?: readonly FixtureApiEvidenceRow[] | undefined;
  readonly createdAt: string;
}

export const DEFAULT_FIXTURE_FILES: readonly FixtureFileSpec[] = [
  { path: "AGENTS.md", content: "# Fixture Instructions\n\nFollow the deterministic fixture rules.\n" },
  { path: "atlas.config.json", content: "{\n  \"schemaVersion\": 1\n}\n" },
  { path: "dist/generated.js", content: "// generated output\nmodule.exports = {};\n" },
  { path: "secrets/example.env", content: "FIXTURE_TOKEN=redacted\n" },
  { path: "src/index.ts", content: "import { fixtureUtility } from \"./util.js\";\n\nexport const value = fixtureUtility(2);\n" },
  { path: "src/util.ts", content: "export function fixtureUtility(input: number): number {\n  return input * 2;\n}\n" },
  { path: "tests/util.test.ts", content: "import { fixtureUtility } from \"../src/util.js\";\n\nfixtureUtility(2);\n" },
  { path: "vendor/logo.bin", content: "fixture-binary-placeholder\n" }
];

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sampleEvidenceIndexInput(options: SampleEvidenceIndexOptions = {}): SampleEvidenceIndexInput {
  const seed = options.seed ?? "atlas-fixture";
  const files = [...(options.files ?? DEFAULT_FIXTURE_FILES)].sort((a, b) => a.path.localeCompare(b.path));
  const rootPath = options.rootPath ?? FIXTURE_ROOT_PATH;

  const identity = deriveEvidenceRepositoryIdentity({
    displayName: `Fixture Repo (${seed})`,
    rootPath,
    remoteUrl: `https://example.com/atlas/${seed}.git`
  });

  const createdAt = FIXTURE_NOW_ISO;
  const fingerprint = sha256Text(`fixture-git:${seed}`);
  const baseFingerprint = sha256Text("fixture-base");
  const branch = `feature/${seed}`;
  const headSha = "f".repeat(40);
  const gitSnapshotId = deriveId("evgit", [identity.repositoryId, fingerprint, baseFingerprint]);

  const relevantInputsSha256 = stableHash({
    analyzers: ["typescript-semantic"],
    files: files.map((file) => ({ path: file.path, sha256: sha256Text(file.content) })),
    seed
  });

  const snapshotId = deriveId("idxsnap", [identity.repositoryId, gitSnapshotId, relevantInputsSha256]);

  const fileRows: FixtureFileRow[] = files.map((file) => ({
    fileId: deriveId("evfile", [identity.repositoryId, file.path]),
    repositoryId: identity.repositoryId,
    uri: file.path,
    contentSha256: sha256Text(file.content),
    byteLength: Buffer.byteLength(file.content, "utf8"),
    lastSeenSnapshotId: snapshotId
  }));

  const classifications: FixtureClassificationRow[] = files.map((file) => {
    const profile = classifyFixtureFile(file.path);
    return {
      classificationId: deriveId("evcls", [identity.repositoryId, file.path]),
      repositoryId: identity.repositoryId,
      fileId: deriveId("evfile", [identity.repositoryId, file.path]),
      uri: file.path,
      sourceSha256: sha256Text(file.content),
      category: profile.category,
      sensitivity: profile.sensitivity,
      secret: profile.secret,
      binaryCheck: profile.binary,
      excluded: profile.excluded,
      ...(profile.excludedReason === undefined ? {} : { excludedReason: profile.excludedReason })
    };
  });

  const contents: FixtureContentRow[] = files.map((file) => {
    const profile = classifyFixtureFile(file.path);
    return {
      contentSha256: sha256Text(file.content),
      byteLength: Buffer.byteLength(file.content, "utf8"),
      mediaType: profile.binary ? "application/octet-stream" : "text/plain",
      binary: profile.binary,
      redacted: profile.secret,
      sensitivity: profile.sensitivity,
      storageUri: `evidence-blobs/${sha256Text(file.content)}`
    };
  });

  const utilContent = contentOf(files, "src/util.ts");
  const utilFileId = deriveId("evfile", [identity.repositoryId, "src/util.ts"]);

  return {
    repository: {
      displayName: identity.displayName,
      rootPath,
      remoteUrl: `https://example.com/atlas/${seed}.git`
    },
    gitSnapshot: {
      repositoryId: identity.repositoryId,
      snapshotId: gitSnapshotId,
      fingerprint,
      baseFingerprint,
      branch,
      headSha,
      dirty: false,
      snapshot: {
        base_fingerprint: baseFingerprint,
        branch,
        changed_file_count: 0,
        changed_files: [],
        dirty: false,
        fingerprint,
        head_sha: headSha,
        parents: [],
        root_path_hash: identity.rootPathHash
      },
      createdAt
    },
    relevantInputsSha256,
    analyzers: [
      {
        capability_id: deriveId("evcap", [identity.repositoryId, "typescript-semantic", "3.0.0"]),
        analyzer_name: "typescript-semantic",
        analyzer_version: "3.0.0",
        capabilities: ["edges", "symbols", "test-associations"],
        gaps: [],
        languages: ["typescript"],
        unsupported: []
      }
    ],
    files: fileRows,
    contents,
    classifications,
    symbols: [
      {
        symbolId: deriveId("evsym", [identity.repositoryId, "src/util.ts", "fixtureUtility"]),
        repositoryId: identity.repositoryId,
        fileId: utilFileId,
        uri: "src/util.ts",
        sourceSha256: sha256Text(utilContent),
        name: "fixtureUtility",
        kind: "function",
        exported: true,
        lineStart: 1,
        lineEnd: 3
      }
    ],
    edges: [
      {
        edgeId: deriveId("evedge", [identity.repositoryId, "import", "src/index.ts", "src/util.ts"]),
        repositoryId: identity.repositoryId,
        kind: "import",
        fromFileId: deriveId("evfile", [identity.repositoryId, "src/index.ts"]),
        toFileId: utilFileId,
        fromUri: "src/index.ts",
        toUri: "src/util.ts",
        rule: "resolved-import",
        resolution: "static"
      }
    ],
    testAssociations: [
      {
        associationId: deriveId("evtassoc", [identity.repositoryId, "tests/util.test.ts", "src/util.ts"]),
        repositoryId: identity.repositoryId,
        testFileId: deriveId("evfile", [identity.repositoryId, "tests/util.test.ts"]),
        sourceFileId: utilFileId,
        testUri: "tests/util.test.ts",
        sourceUri: "src/util.ts",
        rule: "co-named-test"
      }
    ],
    configEvidence: [
      {
        configEvidenceId: deriveId("evcfg", [identity.repositoryId, "atlas.config.json"]),
        repositoryId: identity.repositoryId,
        uri: "atlas.config.json",
        sourceSha256: sha256Text(contentOf(files, "atlas.config.json")),
        byteLength: Buffer.byteLength(contentOf(files, "atlas.config.json"), "utf8"),
        format: "json",
        secretRedacted: false
      }
    ],
    apiEvidence: [
      {
        apiEvidenceId: deriveId("evapi", [identity.repositoryId, "src/util.ts", "fixtureUtility"]),
        repositoryId: identity.repositoryId,
        fileId: utilFileId,
        uri: "src/util.ts",
        sourceSha256: sha256Text(utilContent),
        name: "fixtureUtility",
        surface: "exported-function",
        lineStart: 1,
        lineEnd: 3
      }
    ],
    createdAt
  };
}

export function fixtureRepoTree(dir: string, files: readonly FixtureFileSpec[]): void {
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
}

interface FixtureClassificationProfile {
  readonly category: string;
  readonly sensitivity: string;
  readonly secret: boolean;
  readonly binary: boolean;
  readonly excluded: boolean;
  readonly excludedReason?: string | undefined;
}

function classifyFixtureFile(uri: string): FixtureClassificationProfile {
  if (uri.startsWith("vendor/")) {
    return { category: "source", sensitivity: "internal", secret: false, binary: true, excluded: false };
  }
  if (uri.startsWith("secrets/")) {
    return {
      category: "config",
      sensitivity: "confidential",
      secret: true,
      binary: false,
      excluded: false
    };
  }
  if (uri.startsWith("dist/")) {
    return {
      category: "source",
      sensitivity: "internal",
      secret: false,
      binary: false,
      excluded: true,
      excludedReason: "generated/**"
    };
  }
  if (uri === "AGENTS.md") {
    return { category: "instruction", sensitivity: "internal", secret: false, binary: false, excluded: false };
  }
  if (uri === "atlas.config.json") {
    return { category: "config", sensitivity: "internal", secret: false, binary: false, excluded: false };
  }
  if (uri.startsWith("tests/") || uri.endsWith(".test.ts")) {
    return { category: "test", sensitivity: "internal", secret: false, binary: false, excluded: false };
  }
  return { category: "source", sensitivity: "internal", secret: false, binary: false, excluded: false };
}

function contentOf(files: readonly FixtureFileSpec[], path: string): string {
  const found = files.find((file) => file.path === path);
  if (found === undefined) {
    throw new Error(`Fixture file is missing: ${path}`);
  }
  return found.content;
}
