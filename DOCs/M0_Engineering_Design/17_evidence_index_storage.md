# Evidence Index Storage Foundation

## Production invariant

The evidence index is a versioned, content-addressed persistence contract for repository evidence. The same normalized input must always produce byte-stable identifiers and serialization; any consumer that cannot prove it understands the stored schema must refuse access instead of guessing.

The index records facts about a repository at a point in time. It never changes discovery behavior by itself: discovery, planning, and gates continue to run on their existing artifacts until later batches integrate the index explicitly.

## Deterministic identity and hashing

- `canonicalJson(value)` recursively sorts object keys with a deterministic codepoint comparison (`a < b ? -1 : a > b ? 1 : 0`) and emits compact JSON with no whitespace. Key order is therefore identical in every environment, independent of ICU locale or collation.
- `stableHash(value)` is SHA-256 over canonical JSON UTF-8 bytes.
- `deriveId(prefix, parts)` returns `` `${prefix}_${sha256(parts.join("\u0000")).slice(0, 20)}` ``. The NUL separator makes part boundaries unambiguous (`["ab","c"]` never collides with `["a","bc"]`).
- Repository identity derives only from content. Root paths are canonicalized **before** hashing by `canonicalizeRepositoryRootPath`: backslash
es become forward slashes, a leading drive letter is lowercased (`C:\work\atlas` and `C:/work/atlas` both canonicalize to `c:/work/atlas`), and trailing slashes are stripped on every platform. `root_path_hash` is SHA-256 of the canonical form and `repository_id = deriveId("evrepo", [root_path_hash])`, so path-spelling variants of the same checkout share one repository identity while raw absolute paths are never persisted anywhere.
- These primitives replicate the recipes already used by semantic discovery and git safeguards (modulo the codepoint sort, which is stricter). Those local copies remain untouched until a later consolidation batch.

## Schema surface (`@atlas/schemas/evidence-index`)

`EVIDENCE_INDEX_SCHEMA_VERSION = 1` governs the payload and snapshot contract:

| Schema | Purpose |
| --- | --- |
| `evidenceRepositoryIdentitySchema` | repository_id, display_name, hashed root/remote URLs, created_at |
| `evidenceGitSnapshotSchema` | fingerprint/base fingerprint/head/dirty plus `parents` lineage |
| `evidenceFileRecordSchema` | file_id, repo-relative URI, content hash, tombstone support |
| `evidenceContentRecordSchema` | content-addressed bytes: media type, binary/redacted flags, root-relative storage URI |
| `evidenceSourceClassificationSchema` | category enum identical to `ContextCategory`, secret/binary/excluded flags with reason |
| `evidenceSymbolSchema` / `evidenceEdgeSchema` / `evidenceTestAssociationSchema` | symbol and graph evidence bound to source URI + SHA-256; caller/callee edges require `resolution="static"` |
| `evidenceConfigEvidenceSchema` / `evidenceApiEvidenceSchema` | config keys and API-surface anchors bound to files |
| `analyzerCapabilitySchema` | per-analyzer languages, capabilities, unsupported list, gaps |
| `indexSnapshotSchema` / `indexPayloadSchema` | snapshot header (status machine, entry counts, hashes) plus full normalized payload |
| `invalidationMetadataSchema` | entity-scoped invalidation records with closed reason enum |

Closed field sets are deliberate: there is no `z.record(z.unknown())` escape hatch, so secrets or absolute paths cannot ride through a free-form metadata channel. Zod objects strip unknown keys on parse, which keeps stored payloads clean even if a future producer sends extra fields.

## Storage layout

Migration `7_evidence_index_core` adds additive `evidence_*` tables only. Key decisions:

- Text primary keys hold deterministic IDs; boolean columns are `0/1` with `CHECK` constraints; enums are checked against closed value lists that mirror the zod schemas.
- `evidence_classifications.binary_check` avoids any ambiguity around keyword-like column names while keeping `is_secret`/`excluded` readable.
- `evidence_contents.sensitivity` persists exactly the caller-supplied classification of the bytes; when a producer omits it, the row-level default `internal` applies at write time. The column carries the same four-value CHECK constraint as classifications, so sensitivity survives persistence for content records too.
- `evidence_files` carries `UNIQUE (repository_id, uri)` so one URI has at most one live record per repository.
- `idx_evidence_snapshots_current` is a partial unique index: at most one `current` snapshot per repository can exist at database level, not just by convention.
- All statements are idempotent (`CREATE TABLE IF NOT EXISTS`), matching the purely additive migration policy.

Blobs referenced by `storage_uri` live under `<store-root>/<namespace>/<sha256>` through `writeContentAddressedBlob`: staged write, atomic rename, idempotent promote for identical bytes, and `ArtifactIntegrityError` when an existing path holds different bytes (corrupted store). `readVerifiedBlob` re-hashes on every read; verification failures are corruption, not warnings.

## Transactional commit protocol

`commitIndexSnapshot` runs inside a single `BEGIN IMMEDIATE ... COMMIT` transaction:

1. Validate that every caller-supplied entry row (git snapshot, files, classifications, symbols, edges, test associations, config/API evidence, invalidations) declares the derived `repository_id`; any foreign-owned row is rejected with `PersistenceError` "Cross-repository evidence rejected" before anything is written.
2. Upsert repository identity and reject mismatches (`PersistenceError` "Evidence repository identity collision") when recomputed id/root-path-hash/display name/remote hash disagree with the stored row. A second repository claiming the same root path is rejected because `root_path_hash` is unique.
3. Insert entries (contents, files, classifications, symbols, edges, associations, config/API evidence, capabilities, invalidations). Foreign keys reject entries referencing unknown files; `evidence_files` upserts refuse to rewrite an existing primary key (`PersistenceError` "file identity conflict") so dependent rows keep valid parents — only content/lineage fields refresh when the file id matches.
4. Snapshot identity binds content byte-for-byte: `snapshot_id = deriveId("idxsnap", [repository_id, git_snapshot_id, relevant_inputs_sha256, payload_sha256])`. If a row with the same id already exists, its stored `payload_sha256` must equal the recomputed hash (`ArtifactIntegrityError` otherwise) and the **stored header is returned unchanged** — replays never mutate `status`, `supersedes_snapshot_id`, or `created_at`, so a verbatim replay of an old commit cannot demote or resurrect anything.
5. When inserting a genuinely new snapshot, the prior `current` row is flipped to `superseded` and the new row records `supersedes_snapshot_id` automatically (the demoted row's id) unless the caller supplies one explicitly; a caller-supplied value that disagrees with the demoted row is rejected with `PersistenceError`. The new snapshot is inserted as `current` last. Any throw rolls back everything, so a partially written index can never masquerade as current.

`readCurrentIndexSnapshot` verifies `payload_sha256` against the canonical hash of `payload_json` before parsing, throwing `ArtifactIntegrityError` on mismatch. Snapshot status moves only through `building -> current -> superseded/invalid`; supersession is the only mutation path.

## Fail-closed version policy

**Caller contract:** every index access MUST invoke `assertSupportedIndexSchema(db)` first. `readCurrentIndexSnapshot` additionally enforces the per-row guard: a stored snapshot whose `schema_version` exceeds `EVIDENCE_INDEX_SCHEMA_VERSION` raises `MigrationError` regardless of the database-wide check.

`assertSupportedIndexSchema` refuses index access when either guard trips:

- `MAX(schema_migrations.version)` exceeds the highest known core migration (database written by a newer Atlas);
- `MAX(evidence_index_snapshots.schema_version)` exceeds `EVIDENCE_INDEX_SCHEMA_VERSION`.

Both raise `MigrationError` (RecoveryRequired exit code). Legacy sessions and artifacts stay fully readable across the upgrade because v7 is additive. This policy is scoped to explicit index access only; runtime open paths are not wired to it yet.

## Portability and safety

- No raw absolute user paths, tokens, or secret values are persisted: locations appear only as SHA-256 hashes; secret-bearing sources are flagged via classification (`secret=true`) and redacted content records.
- URIs are repository-relative forward-slash paths; artifact-store references are root-relative `namespace/sha256` pairs. Fixtures use synthetic roots so deterministic tests never encode developer directories.

## Analyzer v2 (B3.3) – Schema and Storage

- **Version:** `EVIDENCE_INDEX_SCHEMA_VERSION` remains `1` (additive). Migration `9_evidence_index_analyzer_v2` adds `evidence_analyzer_gaps` table and extends `evidence_symbols` (`col_start`, `col_end`, `proof`, `analyzer_name/version`), `evidence_edges` (`proof`, `analyzer_name/version`, `from/to_source_sha256`, `from/to_line/col`), `evidence_test_associations` (`proof`, `analyzer_name/version`, `source/test_sha256`, `line/col`), `evidence_api_evidence` (`col_*`, `proof`, `analyzer_*`), `evidence_config_evidence` (`analyzer_*`, `proof`). All new columns are nullable/defaulted, so v1 payloads remain valid.

- **Gaps:** `evidence_analyzer_gaps` stores `gap_id`, `repository_id`, `snapshot_id` (nullable, for pre-promotion), `analyzer_name/version`, `code`, `severity` (`blocking`|`warning`|`info`), `scope_uri` (nullable, repo-relative), `message` (redacted, ≤500 chars), `blocking` (0/1), `capability`, `created_at`. Gaps are part of `indexPayload.gaps` and `entry_counts.gaps`; `relevant_inputs_sha256` includes `analyzerVersions` and file SHAs, so analyzer version/config changes invalidate deterministically.

- **Entry counts:** `evidenceEntryCounts` now includes optional `gaps`; `indexPayload` includes `gaps: AnalyzerGap[]` (default `[]`).

## Known limitations

- **Single writer:** SQLite transactions serialize writers, but Atlas's advisory lock system does not yet cover evidence-index commits. Two processes committing concurrently will see one transaction block or fail rather than corrupt data; cross-process coordination lands with Batch 11 orchestration.
- **Incremental analyzer:** B3.3 analyzer runs incrementally (only changed files plus dependents) via `changedUris` and `analyzerVersionChanged`; unchanged semantic rows are carried forward from `previous` payload. Full re-analysis occurs on `gitReset` or version change.

## Extension points

- **B3.2 incremental scanner** — consumes `evidence_files` tombstones and `invalidationMetadataSchema` reasons (`file-changed`, `file-deleted`, `git-reset`) without schema change.
- **B3.3 analyzer plugins** — `EvidenceAnalyzer` contract (`contract.ts`) with `registerAnalyzer` (rejects duplicate/invalid names, path-like capabilities), `selectAnalyzersForFile` by extension, `ensureDefaultAnalyzersRegistered` (trusted `typescript-analyzer-v2`); `typescript-analyzer.ts` implements the contract. No dynamic loading from repository content.
- **B3.5 discovery integration** — context manifests may cite `snapshot_id` and `file_id`s as evidence once a current snapshot exists; the fail-closed read path gives them a safe lookup primitive.
- **B3.4 queries** — `listEvidence*` and `getEvidence*` already expose symbols/edges/gaps for bounded queries; CLI/inspection not yet exposed.
