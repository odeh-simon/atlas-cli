# ATL-14 Implementation Prompt

You are the implementing agent for Linear issue `ATL-14`, **B3.2 - Implement incremental indexing, invalidation, and historical snapshots**, in the Sigil CLI repository.

Your job is to finish the existing B3.2 work and produce a review-ready handoff. Do not start B3.3, mark ATL-14 Done, or approve your own implementation.

## Authority and required reading

Read these sources before changing code, in this order:

1. `DOCs/Sigil_V1_Product_Requirements_Document.md`, version 2.0, for product behavior and safety requirements.
2. The Linear document `Sigil Implementation Context and Production-Orchestration Plan`, mirrored at `DOCs/Sigil_Implementation_Context.md`, especially Sections 1, 5, 7, 8 Batch 3, 9, and 10.
3. Linear issue `ATL-14`, including its outcome, boundaries, acceptance criteria, validation, non-goals, and stop conditions.
4. The approved B3.1 checkpoint `166563b` and Linear issue `ATL-13`.
5. `DOCs/M0_Engineering_Design/16_context_manifest_v3_semantic_discovery.md`.
6. `DOCs/M0_Engineering_Design/17_evidence_index_storage.md`.
7. Current implementations in `packages/git`, `packages/context-discovery`, `packages/schemas`, `packages/persistence`, `packages/artifacts`, and `packages/test-utils`.

If these sources conflict materially, stop and report the conflict. Do not silently choose an interpretation.

## Current repository state

- Branch: `codex/sigil-production-orchestration`.
- Approved dependency checkpoint: `166563b` (`ATL-13`, B3.1 storage foundation).
- The worktree already contains substantial uncommitted B3.2 implementation. Treat it as user-owned work and continue from it; do not reset, revert, overwrite, or recreate it wholesale.
- Existing B3.2 paths include `packages/evidence-index` plus related schema, persistence, migration, workspace, lockfile, test, and design-document changes.
- `pnpm check` currently passes.
- The focused evidence-index suite currently passes 21 tests, including incremental invalidation, historical comparison, cancellation/crash recovery, and a 2,000-file fixture.
- The measured focused benchmark is approximately 16.7 seconds for the first 2,000-file build, 0.82 seconds for exact unchanged reuse, and 10.8 seconds for a one-file update.
- The full suite currently reports 318 passing and 2 timing-related failures under parallel load. The failing tests pass when run separately. ATL-14 cannot be promoted until the full repository suite is reliably green.
- Release bundle and installed-binary smoke currently pass, but `pnpm release:check` does not pass while the full test suite is unstable.

Re-read `git status`, the complete diff, untracked files, and current tests before editing. Distinguish changes already present from changes you add.

## Outcome

Deliver the deterministic evidence-index engine that creates, exactly reuses, incrementally updates, invalidates, and compares repository evidence snapshots while preserving B3.1 identity, storage, migration, portability, and fail-closed guarantees.

This batch must not change context-discovery, planning, or CLI behavior yet.

## Required scope

Complete and verify:

1. Full and incremental index builds keyed by repository identity, Git state, repository-relative paths, content hashes, configuration fingerprint, and analyzer versions.
2. Exact add/change/delete/rename invalidation with branch, commit, config, and instruction-change handling and no authoritative ghost records.
3. Exact unchanged-repository snapshot reuse without reprocessing file content.
4. Immutable historical snapshots and repository-isolated, deterministic, bounded comparison APIs.
5. Atomic current-snapshot promotion with the previous valid snapshot remaining authoritative after cancellation, crash, failed save, or interrupted build.
6. Rebuild markers and a rebuildable fail-closed state for corrupt, missing, stale, or unsupported current evidence.
7. Explicit dirty-worktree, staged, unstaged, untracked, symlink, realpath, secret, binary, excluded, and unsafe-URI behavior consistent with context manifest v3.
8. Content-free metrics for scans, hashes, cache hits, reuse, invalidation reasons, rebuilds, duration, throughput, payload size, and storage growth.
9. Additive migrations, compatibility behavior, deterministic fixtures, and current design documentation.
10. Stable full-suite execution on Windows under repository-level parallel load.

## Non-goals

Do not implement:

- B3.3 analyzer-v2 symbol or framework enrichment;
- B3.4 graph-query CLI, inspection commands, or repair command surface;
- B3.5 context-manifest, planning, agent-package, or workflow integration;
- Batch 4 authority, conflict, pattern, or invariant behavior;
- embeddings, cloud indexing, ranking, AI selection, retention compaction, production backup/restore, or multiprocess orchestration;
- unrelated refactors or broad test-infrastructure rewrites.

If a required fix crosses one of these boundaries, stop and report it as a prerequisite or approved deviation.

## Acceptance criteria

Prove all of the following with deterministic tests and inspectable evidence:

1. An unchanged repository reuses the exact current snapshot without rehashing or reprocessing source content.
2. A one-file change invalidates only the file and index records that are provably affected; unrelated rows remain byte-identical.
3. Deleted and renamed files, branch switches, rewritten commits, config changes, dirty changes, and untracked-file changes cannot return stale authoritative evidence.
4. An interrupted or cancelled build never replaces the last valid current snapshot.
5. Corrupt, missing, unsupported, or partially persisted current data fails closed and reaches an explicit rebuildable state.
6. Historical comparison is deterministic, bounded by configured limits, and rejects cross-repository comparison or reuse.
7. Large-fixture, cancellation, concurrent-reader, failed-save, crash-recovery, symlink/path-containment, secret/binary, migration, and deterministic-serialization tests pass.
8. Existing manifest-v3 freshness, planning, agent handoff, redaction, Git safeguard, check, review, and completion tests remain green.
9. The complete release gate passes without test retries masking nondeterminism.

## Full-suite stabilization requirement

Investigate the two full-suite timeouts as a B3.2 integration/resource issue. Do not merely raise unrelated test timeouts until you understand the cause.

- Measure process, filesystem, SQL.js, Git-fixture, and worker contention introduced by the evidence-index suite.
- Keep the 2,000-file performance assertion meaningful.
- Prefer deterministic test isolation, bounded worker scheduling, fixture reuse where safe, or a clearly separated benchmark lane over arbitrary timeout inflation.
- Ensure timed-out child processes and Windows temp directories are released before cleanup.
- Demonstrate that the previously failing agent-invocation and configured-check tests pass both alone and as part of the complete suite.

## Validation commands

Run focused checks during implementation and finish with the complete sequence:

```bash
pnpm check
pnpm exec vitest run packages/schemas/src/evidence-index.test.ts packages/persistence/src/evidence-index.test.ts packages/persistence/src/migrations.test.ts
pnpm exec vitest run packages/evidence-index/src --reporter=verbose
pnpm exec vitest run packages/app-services/src/agent-invoke.test.ts packages/app-services/src/checks.test.ts --reporter=verbose
pnpm test
pnpm release:bundle
pnpm release:smoke
pnpm release:check
git diff --check
git status --short
```

Do not report a command as passing unless it completed with exit code 0 in the final worktree. Preserve exact test-file/test counts, durations, benchmark values, archive checksum, and any warnings.

## Required handoff

Produce a review-ready report containing:

1. ATL-14 acceptance criterion -> implementation -> test/evidence mapping.
2. Exact branch, approved base commit, current HEAD, dirty/staged state, and changed/untracked file list.
3. File-by-file summary distinguishing inherited B3.2 work from your additions.
4. Schema/migration/API compatibility statement and rollback/fail-closed behavior.
5. Invalidation traces for unchanged, add, edit, delete, rename, branch, commit, config, dirty, and untracked scenarios.
6. Benchmark fixture shape, machine/runtime, first build, exact reuse, incremental update, throughput, payload bytes, database growth, and cancellation behavior.
7. Exact validation commands and results, including full-suite and release-check results.
8. Security/portability evidence for secrets, binaries, symlinks, path containment, cross-repository isolation, and absence of raw absolute paths in portable artifacts.
9. Known limitations explicitly assigned to B3.3, B3.4, B3.5, Batch 9, or Batch 11 rather than silently implemented here.
10. Unresolved questions, deviations, and stop conditions encountered.

Request independent review against the exact final diff and evidence. The independent reviewer, not the implementing agent, decides whether ATL-14 may be approved and checkpointed. Only after that approval may Linear mark ATL-14 Done and ATL-15 become eligible to start.
