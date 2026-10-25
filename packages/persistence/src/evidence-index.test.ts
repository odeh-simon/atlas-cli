import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactIntegrityError, MigrationError, PersistenceError } from "@atlas/domain";
import { evidenceSourceClassificationSchema } from "@atlas/schemas";
import {
  DEFAULT_FIXTURE_FILES,
  FIXTURE_NOW_ISO,
  sampleEvidenceIndexInput
} from "@atlas/test-utils";

import {
  assertSupportedIndexSchema,
  applyMigrations,
  coreMigrations,
  commitIndexSnapshot,
  createArtifactRecord,
  createRepository,
  createSession,
  getArtifactRecord,
  getEvidenceFileByUri,
  getEvidenceRepository,
  getRepository,
  getSession,
  listArtifactsForSession,
  listEvidenceClassifications,
  listEvidenceContents,
  listEvidenceFiles,
  openDatabase,
  queryAll,
  queryOne,
  readCurrentIndexSnapshot,
  saveDatabase,
  upsertEvidenceFile,
  withImmediateTransaction
} from "./index.js";

const tempRoots: string[] = [];

interface OpenedFixtureDb {
  readonly dbPath: string;
  readonly db: Awaited<ReturnType<typeof openDatabase>>;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function openedFixtureDb(prefix = "atlas-evidence-index-"): Promise<OpenedFixtureDb> {
  const root = tempRoot(prefix);
  const dbPath = join(root, "atlas.db");
  await applyMigrations({
    dbPath,
    backupDirectory: join(root, "backups"),
    now: () => new Date(FIXTURE_NOW_ISO),
    migrations: coreMigrations
  });

  return { dbPath, db: await openDatabase(dbPath) };
}

async function saveAndReopen(opened: OpenedFixtureDb): Promise<OpenedFixtureDb> {
  saveDatabase(opened.dbPath, opened.db);
  opened.db.close();
  return { dbPath: opened.dbPath, db: await openDatabase(opened.dbPath) };
}

function requireCurrent(opened: OpenedFixtureDb, repositoryId: string) {
  const current = readCurrentIndexSnapshot(opened.db, repositoryId);
  if (current === undefined) {
    throw new Error("expected a current evidence index snapshot");
  }
  return current;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deterministic evidence index commits", () => {
  it("produces byte-identical payloads and equal snapshot ids in two fresh databases", async () => {
    const first = await openedFixtureDb();
    const second = await openedFixtureDb();
    const input = sampleEvidenceIndexInput();

    const headerA = commitIndexSnapshot(first.db, input);
    const headerB = commitIndexSnapshot(second.db, input);

    expect(headerA.snapshot.snapshot_id).toBe(headerB.snapshot.snapshot_id);
    expect(headerA.snapshot.repository_id).toBe(headerB.snapshot.repository_id);

    const rowA = queryOne(
      first.db,
      "SELECT snapshot_id, payload_json, payload_sha256 FROM evidence_index_snapshots WHERE snapshot_id = ?",
      [headerA.snapshot.snapshot_id]
    );
    const rowB = queryOne(
      second.db,
      "SELECT snapshot_id, payload_json, payload_sha256 FROM evidence_index_snapshots WHERE snapshot_id = ?",
      [headerB.snapshot.snapshot_id]
    );

    expect(rowA).toEqual(rowB);
  });

  it("survives save, close, and reopen with an unchanged verified snapshot", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());
    const reopened = await saveAndReopen(opened);

    const reread = requireCurrent(reopened, header.snapshot.repository_id);
    expect(reread.snapshot.snapshot_id).toBe(header.snapshot.snapshot_id);
    expect(reread.payload.files.map((file) => file.uri)).toEqual([
      "AGENTS.md",
      "atlas.config.json",
      "dist/generated.js",
      "secrets/example.env",
      "src/index.ts",
      "src/util.ts",
      "tests/util.test.ts",
      "vendor/logo.bin"
    ]);
  });
});

describe("fail-closed schema policy", () => {
  it("rejects reading a current snapshot stored with an unsupported schema version", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    opened.db.run("UPDATE evidence_index_snapshots SET schema_version = 2 WHERE snapshot_id = ?", [
      header.snapshot.snapshot_id
    ]);

    expect(() => readCurrentIndexSnapshot(opened.db, header.snapshot.repository_id)).toThrow(MigrationError);
  });

  it("refuses index access when the database was migrated by a newer Atlas version", async () => {
    const opened = await openedFixtureDb();

    opened.db.run(
      "INSERT INTO schema_migrations (version, name, applied_at, checksum, status) VALUES (?, ?, ?, ?, ?)",
      [99, "future_core", FIXTURE_NOW_ISO, "f".repeat(64), "applied"]
    );

    expect(() => assertSupportedIndexSchema(opened.db)).toThrow(MigrationError);
  });

  it("keeps legacy sessions and artifacts readable while applying v7 on top of a v6 database", async () => {
    const root = tempRoot("atlas-evidence-legacy-");
    const dbPath = join(root, "atlas.db");

    await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now: () => new Date(FIXTURE_NOW_ISO),
      migrations: coreMigrations.filter((migration) => migration.version <= 6)
    });

    const legacyDb = await openDatabase(dbPath);
    const repository = createRepository(legacyDb, {
      repoId: "repo_legacy",
      rootPath: "C:/work/legacy",
      displayName: "Legacy Repo",
      now: FIXTURE_NOW_ISO
    });
    const session = createSession(legacyDb, {
      sessionId: "ses_legacy",
      repoId: repository.repoId,
      taskKey: "ENG-13",
      taskSource: "manual",
      primaryState: "intake_ready",
      now: FIXTURE_NOW_ISO
    });
    const artifact = createArtifactRecord(legacyDb, {
      artifactId: "art_legacy",
      sessionId: session.sessionId,
      type: "task_brief",
      schemaVersion: 1,
      contentVersion: 1,
      storageUri: "ses_legacy/task_brief/1-legacy.json",
      sha256: "a".repeat(64),
      byteLength: 10,
      mediaType: "application/json",
      sensitivity: "internal",
      status: "valid",
      producerType: "user",
      createdAt: FIXTURE_NOW_ISO
    });
    saveDatabase(dbPath, legacyDb);
    legacyDb.close();

    const upgrade = await applyMigrations({
      dbPath,
      backupDirectory: join(root, "backups"),
      now: () => new Date(FIXTURE_NOW_ISO),
      migrations: coreMigrations
    });
    expect(upgrade.applied.map((migration) => migration.version)).toEqual([7, 8, 9]);

    const reopened = await openDatabase(dbPath);
    expect(getRepository(reopened, "repo_legacy")).toEqual(repository);
    expect(getSession(reopened, "ses_legacy")?.primaryState).toBe("intake_ready");
    expect(getArtifactRecord(reopened, "art_legacy")).toEqual(artifact);
    expect(listArtifactsForSession(reopened, "ses_legacy")).toHaveLength(1);
    expect(() => assertSupportedIndexSchema(reopened)).not.toThrow();
    reopened.close();
  });
});

describe("transactional snapshot commits", () => {
  it("rolls back manual transactions so failed writes leave no partial evidence rows", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    expect(() =>
      withImmediateTransaction(opened.db, () => {
        opened.db.run(
          "INSERT INTO evidence_contents (content_sha256, byte_length, media_type, binary, redacted) VALUES (?, ?, ?, ?, ?)",
          ["b".repeat(64), 1, "text/plain", 0, 0]
        );
        throw new Error("boom");
      })
    ).toThrow("boom");

    const reopened = await saveAndReopen(opened);
    expect(queryOne(reopened.db, "SELECT COUNT(*) AS count FROM evidence_contents WHERE content_sha256 = ?", [
      "b".repeat(64)
    ])).toEqual({ count: 0 });
    expect(requireCurrent(reopened, header.snapshot.repository_id).snapshot.status).toBe("current");
  });

  it("keeps the previous snapshot current when commitIndexSnapshot fails mid-entry", async () => {
    const opened = await openedFixtureDb();
    const first = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    const mutated = sampleEvidenceIndexInput();
    expect(mutated.files !== undefined).toBe(true);
    const brokenEdges = [
      {
        edgeId: "evedge_broken00000000000000",
        repositoryId: first.snapshot.repository_id,
        kind: "import",
        fromFileId: "evfile_missing000000000001",
        toFileId: "evfile_missing000000000002",
        fromUri: "src/index.ts",
        toUri: "src/missing.ts",
        rule: "resolved-import",
        resolution: "static"
      }
    ] as const;

    expect(() => commitIndexSnapshot(opened.db, { ...mutated, edges: brokenEdges })).toThrow();

    const reopened = await saveAndReopen(opened);
    expect(requireCurrent(reopened, first.snapshot.repository_id).snapshot.snapshot_id).toBe(first.snapshot.snapshot_id);
    expect(
      queryOne(reopened.db, "SELECT COUNT(*) AS count FROM evidence_edges WHERE edge_id = ?", [
        "evedge_broken00000000000000"
      ])
    ).toMatchObject({ count: 0 });
    expect(listEvidenceFiles(reopened.db, first.snapshot.repository_id).map((file) => file.uri)).toContain("src/util.ts");
  });

  it("supersedes the previous snapshot only after a fully successful commit", async () => {
    const opened = await openedFixtureDb();
    const first = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    const grown = sampleEvidenceIndexInput({
      files: [...DEFAULT_FIXTURE_FILES, { path: "docs/new.md", content: "# New\n" }]
    });
    const second = commitIndexSnapshot(opened.db, grown);

    expect(second.snapshot.snapshot_id).not.toBe(first.snapshot.snapshot_id);
    const statuses = queryAll(
      opened.db,
      "SELECT snapshot_id, status FROM evidence_index_snapshots ORDER BY status",
      []
    ).map((row) => ({ snapshot_id: String(row.snapshot_id), status: String(row.status) }));

    expect(statuses).toEqual(
      expect.arrayContaining([
        { snapshot_id: first.snapshot.snapshot_id, status: "superseded" },
        { snapshot_id: second.snapshot.snapshot_id, status: "current" }
      ])
    );

    const reopened = await saveAndReopen(opened);
    expect(requireCurrent(reopened, first.snapshot.repository_id).snapshot.snapshot_id).toBe(second.snapshot.snapshot_id);
    expect(getEvidenceFileByUri(reopened.db, first.snapshot.repository_id, "docs/new.md")).toBeDefined();
  });

  it("auto-derives the supersedes chain and rejects caller-supplied disagreements", async () => {
    const opened = await openedFixtureDb();
    const first = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());
    const second = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({
      files: [...DEFAULT_FIXTURE_FILES, { path: "docs/new.md", content: "# New\n" }]
    }));

    expect(second.snapshot.supersedes_snapshot_id).toBe(first.snapshot.snapshot_id);

    const third = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({
      files: [...DEFAULT_FIXTURE_FILES, { path: "docs/newer.md", content: "# Newer\n" }]
    }));
    expect(third.snapshot.supersedes_snapshot_id).toBe(second.snapshot.snapshot_id);

    expect(() =>
      commitIndexSnapshot(opened.db, {
        ...sampleEvidenceIndexInput({
          files: [...DEFAULT_FIXTURE_FILES, { path: "docs/newest.md", content: "# Newest\n" }]
        }),
        supersedesSnapshotId: "idxsnap_wrong000000000000"
      })
    ).toThrow(/Superseded chain mismatch/u);

    expect(requireCurrent(opened, first.snapshot.repository_id).snapshot.snapshot_id).toBe(third.snapshot.snapshot_id);
  });

  it("returns the stored header unchanged when an identical snapshot is replayed verbatim", async () => {
    const opened = await openedFixtureDb();
    const inputA = sampleEvidenceIndexInput();
    const headerA = commitIndexSnapshot(opened.db, inputA);

    const inputB = sampleEvidenceIndexInput({
      files: [...DEFAULT_FIXTURE_FILES, { path: "docs/new.md", content: "# New\n" }]
    });
    const headerB = commitIndexSnapshot(opened.db, inputB);
    expect(headerB.snapshot.supersedes_snapshot_id).toBe(headerA.snapshot.snapshot_id);

    const rowABeforeReplay = queryOne(
      opened.db,
      "SELECT created_at, status FROM evidence_index_snapshots WHERE snapshot_id = ?",
      [headerA.snapshot.snapshot_id]
    );
    const replayed = commitIndexSnapshot(opened.db, inputA);

    expect(replayed.snapshot.snapshot_id).toBe(headerA.snapshot.snapshot_id);
    expect(replayed.snapshot.created_at).toBe(headerA.snapshot.created_at);
    expect(replayed.snapshot.status).toBe("superseded");

    expect(queryOne(opened.db, "SELECT created_at, status FROM evidence_index_snapshots WHERE snapshot_id = ?", [
      headerA.snapshot.snapshot_id
    ])).toEqual(rowABeforeReplay);
    expect(String(rowABeforeReplay?.status)).toBe("superseded");

    const current = requireCurrent(opened, headerB.snapshot.repository_id);
    expect(current.snapshot.snapshot_id).toBe(headerB.snapshot.snapshot_id);
    expect(current.payload.files.map((file) => file.uri)).toContain("docs/new.md");
    expect(queryOne(opened.db, "SELECT COUNT(*) AS count FROM evidence_index_snapshots")).toMatchObject({ count: 2 });
  });

  it("throws ArtifactIntegrityError when a same-id stored row holds different payload bytes", async () => {
    const opened = await openedFixtureDb();
    const inputA = sampleEvidenceIndexInput();
    const headerA = commitIndexSnapshot(opened.db, inputA);

    opened.db.run("UPDATE evidence_index_snapshots SET payload_json = ? WHERE snapshot_id = ?", [
      '{"repository":{"repository_id":"forged"}}',
      headerA.snapshot.snapshot_id
    ]);

    expect(() => commitIndexSnapshot(opened.db, inputA)).toThrow(ArtifactIntegrityError);

    opened.db.run("UPDATE evidence_index_snapshots SET status = 'invalid' WHERE snapshot_id = ?", [
      headerA.snapshot.snapshot_id
    ]);
    opened.db.run(
      `INSERT INTO evidence_index_snapshots
        (snapshot_id, repository_id, git_snapshot_id, status, supersedes_snapshot_id, schema_version,
         relevant_inputs_sha256, entry_counts_json, analyzer_capabilities_json, payload_json, payload_sha256, created_at)
       VALUES (?, ?, NULL, 'current', NULL, 1, ?, '{}', '[]', ?, ?, ?)`,
      [
        "idxsnap_forged00000000000",
        headerA.snapshot.repository_id,
        "a".repeat(64),
        '{"repository":{"repository_id":"forged"}}',
        "b".repeat(64),
        FIXTURE_NOW_ISO
      ]
    );

    expect(() => readCurrentIndexSnapshot(opened.db, headerA.snapshot.repository_id)).toThrow(ArtifactIntegrityError);
  });
});

describe("cross-repository evidence policy", () => {
  it("rejects alpha commits carrying beta-owned file rows without writing anything", async () => {
    const opened = await openedFixtureDb();
    const alpha = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({ seed: "alpha", rootPath: "/repos/alpha" }));
    const beta = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({ seed: "beta", rootPath: "/repos/beta" }));

    const poisoned = sampleEvidenceIndexInput({ seed: "alpha", rootPath: "/repos/alpha" });
    const poisonedFiles = (poisoned.files ?? []).map((file, index) =>
      index === 0 ? { ...file, repositoryId: beta.snapshot.repository_id } : file
    );

    expect(() => commitIndexSnapshot(opened.db, { ...poisoned, files: poisonedFiles })).toThrow(
      /Cross-repository evidence rejected/u
    );

    const reopened = await saveAndReopen(opened);
    expect(
      queryOne(reopened.db, "SELECT COUNT(*) AS count FROM evidence_index_snapshots WHERE repository_id = ?", [
        alpha.snapshot.repository_id
      ])
    ).toMatchObject({ count: 1 });
    expect(requireCurrent(reopened, alpha.snapshot.repository_id).snapshot.snapshot_id).toBe(alpha.snapshot.snapshot_id);
    expect(listEvidenceFiles(reopened.db, alpha.snapshot.repository_id)).toHaveLength(8);
    expect(listEvidenceFiles(reopened.db, beta.snapshot.repository_id)).toHaveLength(8);
    expect(getEvidenceFileByUri(reopened.db, beta.snapshot.repository_id, "AGENTS.md")?.contentSha256).toBe(
      getEvidenceFileByUri(reopened.db, alpha.snapshot.repository_id, "AGENTS.md")?.contentSha256
    );
  });

  it("rejects git snapshots owned by another repository", async () => {
    const opened = await openedFixtureDb();
    const alpha = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({ seed: "alpha", rootPath: "/repos/alpha" }));
    const beta = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({ seed: "beta", rootPath: "/repos/beta" }));

    const poisoned = sampleEvidenceIndexInput({ seed: "alpha", rootPath: "/repos/alpha" });
    const poisonedGitSnapshot =
      poisoned.gitSnapshot === undefined
        ? undefined
        : { ...poisoned.gitSnapshot, repositoryId: beta.snapshot.repository_id };

    expect(() =>
      commitIndexSnapshot(opened.db, { ...poisoned, gitSnapshot: poisonedGitSnapshot })
    ).toThrow(/Cross-repository evidence rejected/u);
    expect(requireCurrent(opened, alpha.snapshot.repository_id).snapshot.snapshot_id).toBe(alpha.snapshot.snapshot_id);
  });

  it("refuses to rewrite an evidence_files primary key on uri conflict", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    const stored = getEvidenceFileByUri(opened.db, header.snapshot.repository_id, "src/util.ts");
    expect(stored).toBeDefined();

    expect(() =>
      upsertEvidenceFile(opened.db, {
        fileId: "evfile_forged00000000001",
        repositoryId: header.snapshot.repository_id,
        uri: "src/util.ts",
        contentSha256: "a".repeat(64),
        byteLength: 1,
        lastSeenSnapshotId: header.snapshot.snapshot_id
      })
    ).toThrow(/file identity conflict/u);
    expect(getEvidenceFileByUri(opened.db, header.snapshot.repository_id, "src/util.ts")).toEqual(stored);
  });

  it("persists real sensitivity on content records instead of a fabricated constant", async () => {
    const opened = await openedFixtureDb();
    commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    const contents = listEvidenceContents(opened.db);
    const secretContent = contents.find((content) => content.redacted);
    expect(secretContent).toBeDefined();
    expect(secretContent?.sensitivity).toBe("confidential");

    for (const content of contents) {
      if (content.contentSha256 !== secretContent?.contentSha256) {
        expect(content.sensitivity).toBe("internal");
      }
    }
  });
});

describe("repository identity collision policy", () => {
  it("rejects commits whose recomputed identity mismatches the stored row", async () => {
    const opened = await openedFixtureDb();
    commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    const renamed = sampleEvidenceIndexInput({ seed: "renamed" });
    expect(renamed.repository.rootPath).toBe(sampleEvidenceIndexInput().repository.rootPath);

    expect(() => commitIndexSnapshot(opened.db, renamed)).toThrow(PersistenceError);
    expect(() => commitIndexSnapshot(opened.db, renamed)).toThrow(/identity collision/u);
  });

  it("rejects cross-repository reuse of the same root path", async () => {
    const opened = await openedFixtureDb();
    const original = sampleEvidenceIndexInput();
    commitIndexSnapshot(opened.db, original);

    const impostor = sampleEvidenceIndexInput({ seed: "impostor", rootPath: original.repository.rootPath });

    expect(() => commitIndexSnapshot(opened.db, impostor)).toThrow(/identity collision/u);
  });

  it("upserts the same root into one deterministic repository row", async () => {
    const opened = await openedFixtureDb();
    const input = sampleEvidenceIndexInput();

    const first = commitIndexSnapshot(opened.db, input);
    const second = commitIndexSnapshot(opened.db, input);

    expect(second.snapshot.repository_id).toBe(first.snapshot.repository_id);
    expect(queryOne(opened.db, "SELECT COUNT(*) AS count FROM evidence_repositories")).toMatchObject({ count: 1 });
  });

  it("lets two repositories with different roots coexist", async () => {
    const opened = await openedFixtureDb();
    const alpha = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({ seed: "alpha", rootPath: "/repos/alpha" }));
    const beta = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput({ seed: "beta", rootPath: "/repos/beta" }));

    expect(alpha.snapshot.repository_id).not.toBe(beta.snapshot.repository_id);
    expect(requireCurrent(opened, alpha.snapshot.repository_id).snapshot.repository_id).toBe(alpha.snapshot.repository_id);
    expect(requireCurrent(opened, beta.snapshot.repository_id).snapshot.repository_id).toBe(beta.snapshot.repository_id);
    expect(getEvidenceRepository(opened.db, alpha.snapshot.repository_id)?.rootPathHash).not.toBe(
      getEvidenceRepository(opened.db, beta.snapshot.repository_id)?.rootPathHash
    );
  });

  it("rejects entry inserts referencing a foreign repository under an existing transaction", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());

    const foreign = sampleEvidenceIndexInput();
    const files = foreign.files!.map((file, index) =>
      index === 0 ? { ...file, repositoryId: "evrepo_foreign0000000000" } : file
    );

    expect(() => commitIndexSnapshot(opened.db, { ...foreign, files })).toThrow();

    const reopened = await saveAndReopen(opened);
    expect(requireCurrent(reopened, header.snapshot.repository_id).snapshot.snapshot_id).toBe(header.snapshot.snapshot_id);
    expect(getEvidenceFileByUri(reopened.db, "evrepo_foreign0000000000", "src/util.ts")).toBeUndefined();
  });
});

describe("classification persistence", () => {
  it("round-trips secret, binary, and excluded classifications through storage and zod parsing", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());
    const reopened = await saveAndReopen(opened);

    const stored = listEvidenceClassifications(reopened.db, header.snapshot.repository_id);
    const parsedStored = stored.map((classification) =>
      evidenceSourceClassificationSchema.parse({
        classification_id: classification.classificationId,
        file_id: classification.fileId,
        uri: classification.uri,
        source_sha256: classification.sourceSha256,
        category: classification.category,
        sensitivity: classification.sensitivity,
        secret: classification.secret,
        binary: classification.binaryCheck,
        excluded: classification.excluded,
        ...(classification.excludedReason === undefined ? {} : { excluded_reason: classification.excludedReason })
      })
    );
    const byUri = new Map(parsedStored.map((classification) => [classification.uri, classification]));

    const secret = evidenceSourceClassificationSchema.parse(byUri.get("secrets/example.env"));
    expect(secret.secret).toBe(true);
    expect(secret.sensitivity).toBe("confidential");
    expect(secret.category).toBe("config");

    const binary = evidenceSourceClassificationSchema.parse(byUri.get("vendor/logo.bin"));
    expect(binary.binary).toBe(true);
    expect(binary.excluded).toBe(false);

    const excluded = evidenceSourceClassificationSchema.parse(byUri.get("dist/generated.js"));
    expect(excluded.excluded).toBe(true);
    expect(excluded.excluded_reason).toBe("generated/**");

    const plain = evidenceSourceClassificationSchema.parse(byUri.get("src/util.ts"));
    expect(plain).toMatchObject({ secret: false, binary: false, excluded: false, category: "source" });

    expect(stored).toHaveLength(8);
    expect(stored.every((classification) => classification.repositoryId === header.snapshot.repository_id)).toBe(true);
  });
});

describe("payload corruption detection", () => {
  it("throws ArtifactIntegrityError when stored payload bytes no longer match their hash", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());
    const reopened = await saveAndReopen(opened);

    reopened.db.run(
      "UPDATE evidence_index_snapshots SET payload_json = REPLACE(payload_json, '\"files\"', '\"filez\"') WHERE snapshot_id = ?",
      [header.snapshot.snapshot_id]
    );

    expect(() => readCurrentIndexSnapshot(reopened.db, header.snapshot.repository_id)).toThrow(ArtifactIntegrityError);
  });

  it("throws ArtifactIntegrityError when the payload hash column itself is tampered with", async () => {
    const opened = await openedFixtureDb();
    const header = commitIndexSnapshot(opened.db, sampleEvidenceIndexInput());
    const reopened = await saveAndReopen(opened);

    reopened.db.run(
      "UPDATE evidence_index_snapshots SET payload_sha256 = ? WHERE snapshot_id = ?",
      ["e".repeat(64), header.snapshot.snapshot_id]
    );

    expect(() => readCurrentIndexSnapshot(reopened.db, header.snapshot.repository_id)).toThrow(ArtifactIntegrityError);
  });
});
