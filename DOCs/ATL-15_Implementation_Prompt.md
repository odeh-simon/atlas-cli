# ATL-15 Implementation Prompt

You are the implementing agent for Linear issue `ATL-15`, **B3.3 - Add analyzer interface and TypeScript semantic graph v2**, in the Atlas CLI repository.

Your job is to implement the approved analyzer contract and TypeScript/JavaScript semantic graph v2 on top of the approved ATL-14 evidence-index checkpoint, then produce a review-ready handoff. Do not implement ATL-16 query/CLI behavior, mark ATL-15 Done, or approve your own implementation.

## Hard start gate

ATL-15 is blocked by ATL-14. Start implementation only when all of the following are true:

1. ATL-14 has passed its complete validation and release gates.
2. An independent reviewer has approved the exact ATL-14 diff and evidence.
3. ATL-14 has an immutable checkpoint commit and is marked Done in Linear.
4. The ATL-15 branch starts from that approved checkpoint with no inherited, unexplained dirty files.

At the time this prompt was finalized, the repository was on `codex/atlas-production-orchestration` at `6bdc2009f3d6040aadf7cbe594d67a3a8d46937e`, a commit titled `Checkpoint B3.2: incremental indexing, invalidation and historical snapshots (ATL-14)`. However, Linear still reported ATL-14 as Backlog and no independent approval evidence was established during prompt preparation. Treat `6bdc200` as a candidate dependency checkpoint, not an approved ATL-15 base, until the review evidence and Linear state are reconciled. If the gate is not satisfied, stop after reporting the exact dependency state; do not begin B3.3.

## Authority and required reading

Read these sources before changing code, in this order:

1. `DOCs/Atlas_V1_Product_Requirements_Document.md`, version 2.0, for product behavior, safety boundaries, and release requirements.
2. The Linear document `Atlas Implementation Context and Production-Orchestration Plan`, mirrored at `DOCs/Atlas_Implementation_Context.md`, especially Sections 1, 5, 7, 8 Batch 3, 9, and 10.
3. Linear issue `ATL-15`, including its dependency, outcome, primary code boundary, deliverables, acceptance criteria, non-goals, and stop conditions.
4. The independently approved ATL-14 checkpoint and its review/evidence packet.
5. `DOCs/M0_Engineering_Design/16_context_manifest_v3_semantic_discovery.md`.
6. `DOCs/M0_Engineering_Design/17_evidence_index_storage.md`.
7. Current implementations and tests in `packages/context-discovery`, `packages/evidence-index`, `packages/schemas`, `packages/persistence`, `packages/security`, and `packages/test-utils`.

If these sources conflict materially, stop and report the conflict. Do not silently choose an interpretation. If the approved ATL-14 checkpoint differs from assumptions in this prompt, preserve its public invariants and adapt B3.3 narrowly.

## Baseline to inspect

Before editing:

- record the branch, approved ATL-14 base commit, current HEAD, staged/unstaged/untracked state, Node/pnpm versions, and platform;
- read the complete ATL-14 diff and independent approval, not only its final summary;
- inspect the evidence-index schemas, migrations, persistence APIs, incremental invalidation, snapshot promotion, analyzer-version fingerprinting, and cancellation behavior;
- inspect `packages/context-discovery/src/semantic.ts` and its fixtures for manifest-v3 compatibility;
- run the approved baseline validation commands and preserve their exact results;
- identify which B3.1/B3.2 symbol, edge, test-association, API, configuration, capability, and gap records can be extended additively and which require a versioned migration.

Do not reset, revert, or overwrite user-owned changes. Stop if the baseline is dirty for unexplained reasons or cannot be tied to the approved ATL-14 checkpoint.

## Outcome

Populate the persistent evidence index through a versioned, extensible, deterministic analyzer contract and deepen the TypeScript/JavaScript semantic graph. Every semantic claim must be tied to current source evidence and an explicit proof classification. Unsupported or ambiguous semantics must become visible capability gaps rather than invented graph edges.

The resulting graph is persisted evidence for later bounded queries and planning integration. This batch does not expose those consumers yet.

## Production invariants

Preserve all of the following:

1. Repository and Git evidence from ATL-14 remains the identity and freshness authority.
2. Analyzer output is advisory evidence only; it cannot override exclusions, secret/binary classification, path containment, Git identity, or snapshot integrity.
3. No symbol or edge may cite stale bytes: every record binds to repository-relative URI, current source hash, and exact source span where applicable.
4. No caller, callee, API, or schema relation may be emitted from naming similarity or an unresolved guess.
5. Analyzer/config/version changes participate in the relevant-input fingerprint and invalidate affected evidence deterministically.
6. A cancelled or failed analyzer run cannot promote a corrupt or semantically incomplete snapshot as current.
7. Unsupported semantics are explicit, scoped, deterministic gaps with declared severity and capability impact.
8. Output ordering, identifiers, serialization, diagnostics, and fixture results are deterministic across equivalent runs.
9. Existing manifest-v3 semantic behavior remains compatible or migrates through an explicit, tested compatibility path.
10. Trusted built-in analyzer registration must not become an arbitrary code-execution/plugin-loading surface.

## Required scope

### 1. Versioned analyzer contract

Define a stable analyzer interface that declares at least:

- analyzer identity, semantic version, implementation/config fingerprint, supported languages/extensions, and capability set;
- accepted repository/snapshot/file inputs, source hashes, package/config evidence, deterministic limits, and cancellation signal;
- emitted symbols, imports, re-exports, reverse relations, test associations, package boundaries, API/schema evidence or relations where provable, and exact diagnostics/gaps;
- source spans and hashes, proof/resolution classification, confidence policy, and provenance for every semantic record;
- bounded resource/metric output without source-content telemetry;
- analyzer status such as completed, partial, unsupported, cancelled, or failed, with a documented promotion policy.

Use schemas for persisted or cross-package data. Keep runtime-only compiler objects behind the analyzer boundary.

### 2. Deterministic analyzer registry and selection

Implement trusted built-in registration and deterministic analyzer selection by declared language/capability. Reject duplicate identities, incompatible versions, ambiguous ownership, malformed output, and undeclared capabilities. Do not dynamically execute analyzer code from repository content or configuration.

### 3. TypeScript/JavaScript analyzer v2

Use the TypeScript compiler API and current project configuration to analyze supported TS, TSX, JS, JSX, MJS, and CJS inputs. Cover:

- declarations and exported symbols, including aliases, default/named exports, re-exports, overloads, and declaration merging where TypeScript can prove identity;
- imports, re-exports, resolved local-module edges, reverse dependents, cycles, and package-boundary crossings;
- nearest and explicit test associations using deterministic repository evidence;
- `tsconfig` discovery/inheritance, compiler options, `baseUrl`, path aliases, package exports where TypeScript resolves them, project references, and monorepo package boundaries;
- direct caller/callee relations only when the compiler evidence proves the source and target; unresolved, dynamic, reflective, framework-runtime, and polymorphic cases become scoped gaps;
- API and schema relationships only when tied to exact declarations and source evidence; do not infer contracts from filenames or prose.

Preserve the existing semantic-v3 output contract or provide an explicit versioned adapter so current fixtures and downstream artifact readers remain valid.

### 4. Exact evidence and proof model

Extend schemas additively where the approved baseline cannot represent the required evidence. Each semantic edge must carry enough information to establish:

- repository and snapshot scope;
- source and target repository-relative URIs and stable entity identifiers;
- current source hash or hashes;
- exact one-based source span(s), including line and column or deterministic offsets where needed;
- relation kind, analyzer/rule identity, and proof/resolution classification;
- whether the result is exact, bounded, partial, or unsupported.

Do not overload `heuristic` to represent unproven caller/API/schema claims. If new edge kinds, proof types, span fields, or gap records are needed, add versioned schemas, additive migrations, compatibility tests, and deterministic ID rules.

### 5. Evidence-index integration

Integrate analyzers with the ATL-14 build transaction so that:

- only safe, included, current source records reach analyzers;
- changed inputs and analyzer versions invalidate the minimum provably affected semantic evidence;
- unaffected semantic rows remain stable under incremental updates;
- analyzer outputs are validated before persistence;
- symbols, edges, test associations, capabilities, and gaps are stored atomically with their candidate snapshot;
- cancellation, crash, malformed output, unsupported syntax, or persistence failure follows an explicit fail-closed or scoped-partial policy and never corrupts the prior current snapshot;
- promoted snapshot headers truthfully report analyzer versions, capabilities, gaps, counts, and relevant-input hashes.

Do not add the ATL-16 query/inspection/repair command surface.

### 6. Capability and gap taxonomy

Define typed, versioned, deterministic capability and gap records. Distinguish at least unsupported language, unsupported syntax, unresolved module, malformed/unsupported project configuration, unsupported project-reference boundary, dynamic import/call, ambiguous symbol, graph/resource limit, cancellation, analyzer failure, and incomplete proof.

Every gap must identify its scope, severity, analyzer/version, affected URI or project where safe, and whether it blocks snapshot promotion or only a later semantic-completeness claim. Avoid absolute paths and source excerpts in portable gap records.

### 7. Security, portability, and limits

- Preserve generated, binary, secret, excluded-path, symlink, realpath, and repository-containment rules before analysis and persistence.
- Never parse or persist excluded secret content merely to obtain semantics.
- Bound files, bytes, compiler programs, graph records, diagnostics, wall-clock work, and cancellation latency using declared limits.
- Store repository-relative portable evidence; do not leak raw absolute paths, tokens, environment values, or source content into logs/telemetry.
- Treat compiler diagnostics and repository-controlled text as untrusted data when rendering errors.

### 8. Documentation

Update the evidence-index and semantic-discovery engineering documents with the approved analyzer contract, proof model, capability matrix, promotion policy, schema/migration changes, resource limits, and known unsupported semantics. Document facts implemented in this batch, not ATL-16 or later aspirations as completed behavior.

## Non-goals

Do not implement:

- ATL-16/B3.4 graph query CLI, interactive inspection, repair commands, or planning-facing query APIs;
- B3.5 context-manifest/index integration, planning consumption, agent-package consumption, or workflow gates;
- Batch 4 authority, conflict, pattern, or invariant extraction;
- embeddings, vector search, AI-generated semantic edges, speculative data flow, whole-program runtime call graphs, framework-specific runtime graphs, or unsupported-language analyzers;
- arbitrary third-party analyzer loading, repository-supplied executable plugins, organization-wide cloud indexing, or source telemetry;
- unrelated refactors, production backup/restore, retention compaction, or GitHub/Linear orchestration.

If a required change crosses one of these boundaries, stop and request an approved scope/dependency decision.

## Acceptance criteria

Prove all of the following with deterministic tests and inspectable evidence:

1. Existing semantic-manifest-v3 fixtures remain compatible or migrate through an explicit, versioned, tested path.
2. Alias, default/named export, re-export chain, cycle, overload, declaration-merging, monorepo, package-boundary, path-alias, project-reference, and test-association fixtures are deterministic.
3. No caller/callee/API/schema edge is emitted without current exact evidence, source span/hash, analyzer rule, and declared proof type.
4. Unsupported language, framework, syntax, dynamic behavior, ambiguous symbol, and project-reference cases produce visible scoped capability gaps rather than silent omission or invention.
5. Analyzer crash, malformed output, timeout, and cancellation leave the index unpromoted or explicitly scoped partial according to the documented policy; the prior valid current snapshot remains authoritative.
6. Secrets, generated/binary content, excluded paths, unsafe symlinks, path escapes, and out-of-repository files never enter analyzer evidence.
7. Equivalent runs produce byte-stable ordering, identifiers, capability records, gaps, and persisted payloads.
8. A one-file semantic change invalidates only provably affected symbols/edges/associations; unchanged evidence remains stable.
9. Analyzer/config/version changes invalidate the appropriate semantic evidence and cannot silently reuse incompatible rows.
10. Performance, memory, output-size, and cancellation behavior stay within declared fixture budgets without weakening ATL-14's large-repository guarantees.
11. Additive migrations upgrade old databases safely, reject unsupported future versions, and preserve legacy snapshot inspection.
12. The complete repository and release gates pass without retries masking nondeterminism.

## Required fixture matrix

Add focused fixtures for at least:

- TS, TSX, JS, JSX, MJS, and CJS;
- relative imports, extension substitution, path aliases, package exports, re-export chains, and cycles;
- named/default exports, aliases, overloads, declaration merging, and duplicate names in separate scopes;
- direct provable calls versus dynamic, polymorphic, computed, reflective, and unresolved calls;
- monorepo package boundaries, nested/inherited `tsconfig`, malformed config, and project references;
- source/test naming conventions, explicit imports, nearest tests, and ambiguous test associations;
- schema/API exact declarations and unsupported inference cases;
- generated, binary, secret, excluded, symlink escape, and repository-boundary inputs;
- analyzer crash, malformed output, cancellation, resource exhaustion, and partial capability;
- unchanged reuse, one-file update, analyzer-version change, deterministic rerun, and legacy migration.

Assertions must verify exact records and absence of forbidden edges, not only aggregate counts.

## Validation commands

Use focused commands during implementation and finish with the repository's complete approved gate. At minimum run:

```bash
pnpm check
pnpm exec vitest run packages/context-discovery/src/semantic.test.ts --reporter=verbose
pnpm exec vitest run packages/schemas/src/evidence-index.test.ts packages/persistence/src/evidence-index.test.ts packages/persistence/src/migrations.test.ts --reporter=verbose
pnpm exec vitest run packages/evidence-index/src --reporter=verbose
pnpm test
pnpm release:bundle
pnpm release:smoke
pnpm release:check
git diff --check
git status --short
```

Add and run targeted analyzer-contract and TypeScript-analyzer-v2 test files using their final paths. Also rerun every ATL-14 benchmark and cancellation/crash test affected by analyzer integration.

Do not report a command as passing unless it completed with exit code 0 in the final worktree. Preserve exact test-file/test counts, durations, benchmark inputs/results, archive checksum, warnings, and any intentionally skipped platform cases.

## Required handoff

Produce a review-ready evidence packet containing:

1. ATL-15 acceptance criterion -> implementation -> test/evidence mapping.
2. Exact branch, approved ATL-14 base commit, final HEAD, dirty/staged state, and changed/untracked file list.
3. File-by-file change summary and explicit statement that no ATL-16/B3.5 behavior was included.
4. Analyzer contract and deterministic registry description, including versioning and selection rules.
5. TypeScript/JavaScript capability matrix showing supported, partial, unsupported, and blocking semantics.
6. Representative exact symbol/edge/test/API/schema records with source hashes, spans, proof types, and corresponding source fixture references.
7. Gap taxonomy and examples for unsupported language/framework/configuration/dynamic behavior, including promotion consequences.
8. Schema, migration, persistence, invalidation, compatibility, and rollback/fail-closed statement.
9. Crash, cancellation, malformed-output, partial-analysis, and prior-snapshot-preservation evidence.
10. Security/portability evidence for exclusions, secrets, binaries, symlinks, path containment, untrusted diagnostics, and absence of raw absolute paths.
11. Benchmark fixture shape, environment, cold/incremental/reuse timings, memory/output bounds, cancellation latency, and comparison with ATL-14 baselines.
12. Exact validation commands and results, known limitations, deviations, unresolved questions, and stop conditions.

Request independent review against the exact final diff, source evidence, capability claims, and test packet. The independent reviewer, not the implementing agent, decides whether ATL-15 may be approved and checkpointed. Only after that approval may Linear mark ATL-15 Done and ATL-16 become eligible to start.
