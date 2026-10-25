import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalizeRepositoryRootPath,
  deriveEvidenceRepositoryIdentity,
  deriveId,
  stableHash
} from "@atlas/domain";

import {
  EVIDENCE_INDEX_SCHEMA_VERSION,
  evidenceApiEvidenceSchema,
  evidenceContentRecordSchema,
  evidenceEdgeSchema,
  evidenceFileRecordSchema,
  evidenceGitSnapshotSchema,
  evidenceRepositoryIdentitySchema,
  evidenceSourceClassificationSchema,
  evidenceSymbolSchema,
  indexPayloadSchema,
  indexSnapshotSchema
} from "./index.js";

const NOW = "2026-07-12T12:00:00.000Z";
const CONTENT_SHA = "c".repeat(64);

const validRepository = {
  repository_id: "evrepo_11111111111111111111",
  display_name: "Fixture Repo",
  root_path_hash: "d".repeat(64),
  created_at: NOW
};

const validGitSnapshot = {
  snapshot_id: "evgit_11111111111111111111",
  fingerprint: "e".repeat(64),
  base_fingerprint: "f".repeat(64),
  root_path_hash: "d".repeat(64),
  branch: "main",
  head_sha: "a".repeat(40),
  dirty: false,
  changed_file_count: 1,
  changed_files: [{ path: "src/index.ts", index: "M", working_tree: "M" }],
  diff_summary: {
    base_ref: "main",
    total_files: 1,
    total_line_changes: 12,
    has_binary: false,
    has_secret_risk: false,
    truncated: false,
    reviewable: true
  },
  created_at: NOW
};

const validFile = {
  file_id: "evfile_22222222222222222222",
  uri: "src/index.ts",
  content_sha256: CONTENT_SHA,
  byte_length: 42,
  last_seen_snapshot_id: "idxsnap_33333333333333333333"
};

const validContent = {
  content_sha256: CONTENT_SHA,
  byte_length: 42,
  media_type: "text/plain",
  binary: false,
  redacted: false,
  storage_uri: `evidence-blobs/${CONTENT_SHA}`
};

const validClassification = {
  classification_id: "evcls_44444444444444444444",
  file_id: "evfile_22222222222222222222",
  uri: "src/index.ts",
  source_sha256: CONTENT_SHA,
  category: "source",
  secret: false,
  binary: false,
  excluded: false
};

const validSymbol = {
  symbol_id: "evsym_55555555555555555555",
  file_id: "evfile_22222222222222222222",
  uri: "src/index.ts",
  source_sha256: CONTENT_SHA,
  name: "fixtureUtility",
  kind: "function",
  exported: true,
  line_start: 10,
  line_end: 20
};

const validEdge = {
  edge_id: "evedge_66666666666666666666",
  kind: "import",
  from_file_id: "evfile_22222222222222222222",
  to_file_id: "evfile_77777777777777777777",
  from_uri: "src/index.ts",
  to_uri: "src/util.ts",
  rule: "resolved-import"
};

const validTestAssociation = {
  association_id: "evtassoc_88888888888888888888",
  test_file_id: "evfile_99999999999999999999",
  source_file_id: "evfile_22222222222222222222",
  test_uri: "tests/util.test.ts",
  source_uri: "src/util.ts",
  rule: "co-named-test"
};

const validConfigEvidence = {
  config_evidence_id: "evcfg_aaaaaaaaaaaaaaaaaaaa",
  uri: "atlas.config.json",
  source_sha256: CONTENT_SHA,
  byte_length: 24,
  format: "json",
  secret_redacted: false
};

const validApiEvidence = {
  api_evidence_id: "evapi_bbbbbbbbbbbbbbbbbbbb",
  file_id: "evfile_22222222222222222222",
  uri: "src/index.ts",
  source_sha256: CONTENT_SHA,
  name: "fixtureUtility",
  surface: "exported-function",
  line_start: 10,
  line_end: 20
};

const validCapability = {
  capability_id: "evcap_cccccccccccccccccc",
  analyzer_name: "typescript-semantic",
  analyzer_version: "3.0.0",
  languages: ["typescript"],
  capabilities: ["symbols"],
  unsupported: [],
  gaps: []
};

const validInvalidation = {
  invalidation_id: "evinval_dddddddddddddddddd",
  entity_type: "file",
  entity_id: "evfile_22222222222222222222",
  valid_from_snapshot_id: "idxsnap_33333333333333333333",
  reason: "file-changed",
  recorded_at: NOW
};

const validSnapshot = {
  snapshot_id: "idxsnap_33333333333333333333",
  schema_version: EVIDENCE_INDEX_SCHEMA_VERSION,
  repository_id: "evrepo_11111111111111111111",
  git_snapshot_id: "evgit_11111111111111111111",
  status: "current",
  analyzer_capabilities: [validCapability],
  entry_counts: {
    files: 1,
    contents: 1,
    classifications: 1,
    symbols: 1,
    edges: 1,
    test_associations: 1,
    config_evidence: 1,
    api_evidence: 1
  },
  created_at: NOW,
  relevant_inputs_sha256: "a".repeat(64),
  payload_sha256: "b".repeat(64)
};

describe("canonical hashing primitives", () => {
  it("produces byte-stable canonical JSON with recursively sorted keys", () => {
    const first = { z: "last", a: 1, nested: { y: [3, 1, 2], b: true }, arr: [{ d: 4, c: 3 }] };
    const second = { arr: [{ c: 3, d: 4 }], nested: { b: true, y: [3, 1, 2] }, a: 1, z: "last" };

    const firstBytes = Buffer.from(canonicalJson(first), "utf8");
    const secondBytes = Buffer.from(canonicalJson(second), "utf8");

    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(canonicalJson(first)).toBe('{"a":1,"arr":[{"c":3,"d":4}],"nested":{"b":true,"y":[3,1,2]},"z":"last"}');
  });

  it("matches the recorded golden stable-hash digest regardless of key insertion order", () => {
    const first = { z: "last", a: 1, nested: { y: [3, 1, 2], b: true }, arr: [{ d: 4, c: 3 }] };
    const second = { arr: [{ c: 3, d: 4 }], nested: { b: true, y: [3, 1, 2] }, a: 1, z: "last" };

    expect(stableHash(first)).toBe(stableHash(second));
    expect(stableHash(first)).toBe("f2c42f34bb1ef42fe88a2da449bf67b1ad3d3052c047edc08784627bc79b3ff7");
  });

  it("derives deterministic prefixed ids from joined parts", () => {
    expect(deriveId("evfile", ["evrepo_abc123", "src/a.ts"])).toBe("evfile_4efdde0db194ab98afde");
    expect(deriveId("evfile", ["evrepo_abc123", "src/a.ts"])).toBe(deriveId("evfile", ["evrepo_abc123", "src/a.ts"]));
    expect(deriveId("idxsnap", ["evrepo_x", "evgit_y", "a".repeat(64)])).toBe("idxsnap_d0a17a8da786da38b971");
    expect(deriveId("evfile", ["evrepo_abc123", "src/b.ts"])).not.toBe(deriveId("evfile", ["evrepo_abc123", "src/a.ts"]));
    expect(() => deriveId("../bad", ["x"])).toThrow();
  });

  it("orders object keys by codepoint, independent of environment collation", () => {
    const first = { Zeta: 1, alpha: 2, "é": 3, _under: 4 };
    const second = { _under: 4, "é": 3, alpha: 2, Zeta: 1 };

    expect(canonicalJson(first)).toBe('{"Zeta":1,"_under":4,"alpha":2,"é":3}');
    expect(stableHash(first)).toBe(stableHash(second));
    expect(stableHash(first)).toBe("9122c8e49778a08341b58629ef57537488fb30d254969b9751f815fe2f2432ec");
  });

  it("canonicalizes root path spelling before deriving repository identity", () => {
    const backslash = deriveEvidenceRepositoryIdentity({ displayName: "Probe", rootPath: "C:\\work\\atlas" });
    const forward = deriveEvidenceRepositoryIdentity({ displayName: "Probe", rootPath: "C:/work/atlas" });
    const trailing = deriveEvidenceRepositoryIdentity({ displayName: "Probe", rootPath: "c:/work/atlas/" });

    expect(backslash.repositoryId).toBe(forward.repositoryId);
    expect(trailing.repositoryId).toBe(forward.repositoryId);
    expect(backslash.rootPathHash).toBe(forward.rootPathHash);

    const BS = String.fromCharCode(92);
    expect(canonicalizeRepositoryRootPath(["C:", "Work", "Atlas", ""].join(BS))).toBe("c:/Work/Atlas");
    expect(canonicalizeRepositoryRootPath("/repos/atlas/")).toBe("/repos/atlas");
    expect(canonicalizeRepositoryRootPath("//server/share/")).toBe("//server/share");
    expect(canonicalizeRepositoryRootPath("/")).toBe("/");

    expect(() =>
      deriveEvidenceRepositoryIdentity({ displayName: "Probe", rootPath: "relative/path" })
    ).toThrow(/absolute/u);
  });
});

describe("evidence index schemas", () => {
  it("round-trips a fully populated payload through parse and canonical serialization", () => {
    const payload = {
      repository: validRepository,
      git_snapshot: validGitSnapshot,
      files: [validFile],
      contents: [validContent],
      classifications: [validClassification],
      symbols: [validSymbol],
      edges: [validEdge],
      test_associations: [validTestAssociation],
      config_evidence: [validConfigEvidence],
      api_evidence: [validApiEvidence],
      invalidations: [validInvalidation]
    };

    const parsed = indexPayloadSchema.parse(payload);
    expect(JSON.parse(canonicalJson(parsed))).toEqual(parsed);
    expect(canonicalJson(parsed)).toBe(canonicalJson(indexPayloadSchema.parse(JSON.parse(canonicalJson(parsed)))));
  });

  it("round-trips an index snapshot header through parse and canonical serialization", () => {
    const parsed = indexSnapshotSchema.parse(validSnapshot);
    expect(JSON.parse(canonicalJson(parsed))).toEqual(parsed);
    expect(canonicalJson(parsed)).toBe(canonicalJson(indexSnapshotSchema.parse(JSON.parse(canonicalJson(parsed)))));
  });

  it("rejects unknown classification categories", () => {
    expect(
      evidenceSourceClassificationSchema.safeParse({ ...validClassification, category: "bogus" }).success
    ).toBe(false);
  });

  it("rejects symbols whose line range is inverted", () => {
    expect(evidenceSymbolSchema.safeParse({ ...validSymbol, line_start: 20, line_end: 10 }).success).toBe(false);
    expect(evidenceApiEvidenceSchema.safeParse({ ...validApiEvidence, line_start: 30, line_end: 5 }).success).toBe(
      false
    );
  });

  it("rejects snapshots with a schema version other than the supported one", () => {
    expect(indexSnapshotSchema.safeParse({ ...validSnapshot, schema_version: 2 }).success).toBe(false);
    expect(indexSnapshotSchema.safeParse({ ...validSnapshot, schema_version: 0 }).success).toBe(false);
  });

  it("rejects snapshot statuses outside the closed set", () => {
    expect(indexSnapshotSchema.safeParse({ ...validSnapshot, status: "stale" }).success).toBe(false);
  });

  it("rejects absolute paths, backslashes, and traversal segments in uri fields", () => {
    expect(evidenceFileRecordSchema.safeParse({ ...validFile, uri: "/abs/src/index.ts" }).success).toBe(false);
    expect(evidenceFileRecordSchema.safeParse({ ...validFile, uri: "C:\\src\\index.ts" }).success).toBe(false);
    expect(evidenceFileRecordSchema.safeParse({ ...validFile, uri: "src\\windows.ts" }).success).toBe(false);
    expect(evidenceFileRecordSchema.safeParse({ ...validFile, uri: "../escape.ts" }).success).toBe(false);
    expect(evidenceSymbolSchema.safeParse({ ...validSymbol, uri: "/etc/passwd" }).success).toBe(false);
    expect(evidenceContentRecordSchema.safeParse({ ...validContent, storage_uri: "/abs/store.bin" }).success).toBe(
      false
    );
    expect(evidenceContentRecordSchema.safeParse({ ...validContent, storage_uri: "blobs/../secret.bin" }).success).toBe(
      false
    );
    expect(evidenceGitSnapshotSchema.safeParse({ ...validGitSnapshot, changed_files: [{ path: "C:/x.ts", index: "A", working_tree: "A" }] }).success).toBe(false);
  });

  it("rejects scheme-prefixed URIs in repository-relative fields", () => {
    expect(evidenceFileRecordSchema.safeParse({ ...validFile, uri: "https://example.com/src/index.ts" }).success).toBe(
      false
    );
    expect(evidenceFileRecordSchema.safeParse({ ...validFile, uri: "file:///C:/src/index.ts" }).success).toBe(false);
    expect(evidenceSymbolSchema.safeParse({ ...validSymbol, uri: "https://cdn.example.net/util.js" }).success).toBe(
      false
    );
  });

  it("applies relative-path rules to git rename metadata and status tokens", () => {
    expect(
      evidenceGitSnapshotSchema.safeParse({
        ...validGitSnapshot,
        changed_files: [{ path: "src/renamed.ts", index: "R100", working_tree: "M", original_path: "C:\\old\\x.ts" }]
      }).success
    ).toBe(false);
    expect(
      evidenceGitSnapshotSchema.safeParse({
        ...validGitSnapshot,
        changed_files: [{ path: "src/renamed.ts", index: "C:\\abs", working_tree: "M" }]
      }).success
    ).toBe(false);
    expect(
      evidenceGitSnapshotSchema.safeParse({
        ...validGitSnapshot,
        changed_files: [{ path: "src/renamed.ts", index: "M", working_tree: "/abs" }]
      }).success
    ).toBe(false);
    expect(
      evidenceGitSnapshotSchema.safeParse({
        ...validGitSnapshot,
        changed_files: [{ path: "src/renamed.ts", index: "R", working_tree: "M", original_path: "src/old.ts" }]
      }).success
    ).toBe(true);
  });

  it("rejects repository identities carrying raw paths instead of hashes", () => {
    expect(evidenceRepositoryIdentitySchema.safeParse({ ...validRepository, root_path_hash: "/repos/atlas" }).success).toBe(
      false
    );
    expect(evidenceGitSnapshotSchema.safeParse({ ...validGitSnapshot, root_path_hash: "C:/repos/atlas" }).success).toBe(
      false
    );
  });

  it("strips unknown fields so raw paths and secrets have no persistence channel", () => {
    const parsed = evidenceRepositoryIdentitySchema.parse({
      ...validRepository,
      root_path: "/repos/atlas",
      secret_note: "token"
    });
    expect(parsed).toEqual(validRepository);
  });

  it("requires caller/callee edges to be statically resolved while imports stay flexible", () => {
    expect(evidenceEdgeSchema.safeParse({ ...validEdge, kind: "caller" }).success).toBe(false);
    expect(evidenceEdgeSchema.safeParse({ ...validEdge, kind: "caller", resolution: "static" }).success).toBe(true);
    expect(evidenceEdgeSchema.safeParse({ ...validEdge, resolution: "heuristic" }).success).toBe(true);
  });
});
