# Sigil Next-Actions Assessment (reconciliation, validation, backlog estimates)

Date (UTC): 2026-10-04. Branch: `codex/sigil-production-orchestration`. This report is
evidence-backed and review-ready. It approves nothing and marks nothing Done. Linear was
left untouched (no independent-approval evidence exists for ATL-14, and no Linear write
authorization was given; this environment also has no Linear integration to refresh issue
state, so Linear observations below rest on the prompt baseline plus the governing plan).

## 1. Baseline fingerprints and observed state

- Branch: `codex/sigil-production-orchestration`. HEAD: `6bdc2009f3d6040aadf7cbe594d67a3a8d46937e`
  (`Checkpoint B3.2: incremental indexing, invalidation and historical snapshots (ATL-14)`).
  Approved B3.1 base: `166563b`. No commits were added by this agent.
- Runtime: Node v24.19.0, pnpm 9.15.0, win32 x64, 8 CPUs, ~17 GB RAM (~2 GB free at
  session start). Vitest 2.1.9. `pnpm check` (tsc -b): exit 0, before and after.
- `git status` (abridged; full list in §7): 14 tracked modified files (design docs,
  evidence-index engine/package, persistence, schemas, lockfile, release scripts,
  `vitest.config.ts`) plus 9 untracked paths (`.freebuff/project-id`, three prompt docs,
  `opencode.json`, `analyzer-matrix.test.ts`, `analyzer/{contract,registry,typescript-analyzer}.ts`).
  Nothing was reset, stashed, cleaned, committed, or relocated. `sigil.config.json` was
  not touched; `.freebuff/` and `opencode.json` were listed but never read for content.
- Linear (per assessment-prompt baseline, unverifiable from here): ATL-14 and ATL-15 both
  `Backlog`; ATL-13 is the approved B3.1 checkpoint. Governing plan (§8) and the PRD status
  table corroborate: Batch 3 is "in delivery", B3.2 worktree unapproved, B3.3–B3.5 planned.
- Prior-prompt baseline for comparison: full `pnpm test` showed 322 passing tests across 59
  of 60 files, then nonzero exit with three Vitest worker `onTaskUpdate` timeouts tied to
  `analyzer-matrix.test.ts` (28 tests, ~96 s isolated); 2,000-file fixture passed
  (~19.3 s full / ~14.4 s incremental / ~1.1 s reuse); release gates not run.

## 2. ATL-14 (B3.2) acceptance-to-evidence mapping and approval state

Committed B3.2 (`6bdc200`, +3090/−195 across 30 files) delivers the engine the acceptance
criteria require: full/incremental builds keyed by repo/Git/config/analyzer identity
(`engine.ts`, `scan.ts`, `invalidation.ts`), exact reuse (`incremental.test.ts`),
add/change/delete/rename plus branch/commit/config/dirty handling, immutable historical
snapshots and bounded comparison (`comparison.ts`), atomic promotion with prior-snapshot
authority on cancel/crash/failed-save (`cancellation-crash.test.ts`), fail-closed rebuild
markers, content-free metrics (`metrics.ts`), additive migrations, and Windows tar fixes.
Criteria 1–8 are covered by deterministic tests; criterion 9 (complete release gate green)
was NOT met at baseline (full suite red, `release:check` not passing).

Independent-approval state: **no independent review of the exact B3.2 diff exists as
traceable evidence.** The commit message body asserts "independent approved 2026-08-23",
but that is a self-assertion inside the implementing commit, not an independent review
packet (no reviewer identity, no finding-specific dispositions, no approval record), and
Linear still shows ATL-14 as `Backlog`. Per the PRD (§29/§177) and the ATL-15 hard start
gate, a Done state is valid only with traceable implementation, tests, review packet,
independent approval, and checkpoint. **ATL-14 must therefore remain not-Done; its Linear
state is supported by the evidence.** Required next step: independent review of the exact
`166563b..6bdc200` diff plus the validation evidence in §4, then an explicit approval and
Linear transition by the authorized reviewer/human.

## 3. ATL-15 (B3.3) progress and hard start-gate result

Hard start gate (ATL-15 prompt §7): ATL-14 fully validated + independently approved +
checkpointed/Done + clean branch from that checkpoint. Result: **FAIL — ATL-15 remains
blocked.** ATL-14 lacks independent approval and Done state, and the worktree already
contains uncommitted B3.3 scope started out of order (see mapping below). No new B3.3 work
was added by this agent, per instructions.

Uncommitted B3.3-scope inventory (all dirty/untracked, i.e. inherited user-owned work,
now structurally dependent on the analyzer integration):

- Implemented: analyzer contract (`analyzer/contract.ts`), trusted registry
  (`analyzer/registry.ts`), TypeScript analyzer v2 (`analyzer/typescript-analyzer.ts`,
  ~35 KB), engine integration with incremental reverse-dependent closure and fail-closed
  promotion, schema proof/analyzer/gap columns, migration v9 (`evidence_analyzer_gaps` +
  additive extensions), 28-test matrix (`analyzer-matrix.test.ts`: contract/registry,
  six language-module fixtures, incremental preservation, version provenance, fail-closed
  policy, determinism), relaxed incremental assertions, design-doc B3.3 sections,
  `typescript` dependency.
- Incomplete / unverified: ATL-15 fixture-matrix breadth (path-alias/package-exports edge
  cases, project references, malformed-config matrices beyond the single covered case),
  declared performance/memory/cancellation budgets versus ATL-14 baselines, legacy
  migration inspection path for v1 payloads, and any B3.4/B3.5 consumer — correctly absent.
- Outside scope but present: release-script tar platform branching (Windows bsdtar vs GNU
  `--force-local`) — small, justified validation hardening, not product scope; kept.
- Verdict: substantial B3.3 progress exists and its 28 tests pass in isolation and in the
  full suite, but it is unapproved work built on an unapproved base and must not be
  presented as satisfying ATL-15 until the ATL-14 gate clears and an independent review
  covers the exact analyzer diff.

## 4. Full-suite timeout: root cause, minimal fix, before/after evidence

- Root cause: runner scheduling/reporting failure, **not a test assertion defect**. The
  analyzer-matrix file concentrates ~28 tests that each synchronously build TypeScript
  compiler programs (1–3 s of event-loop block per test, ~47–91 s test time per file).
  Under the default `threads` pool with 8 workers on a memory-pressured box (~2 GB free),
  CPU oversubscription plus GC/heap pressure stretches the blocked windows until Vitest's
  worker `onTaskUpdate` heartbeat RPC times out — killing the run after tests themselves
  passed (baseline: 322 passed, 0 assertion failures, 3 heartbeat timeouts). B3.2 already
  needed one stabilization round (30 s timeouts in `6bdc200`); B3.3's analyzer load
  re-triggered the same failure class. Isolated-file success never proved gate health
  because contention only exists in the full parallel run.
- Minimal fix (only agent-authored product change, in `vitest.config.ts`): `pool: "forks"`
  (one process per test file — no shared worker-thread loop/GC across the SQL.js, git,
  and TS-compiler fixtures) with `minWorkers: 1, maxWorkers: 4` (explicit min required;
  bare numeric `maxWorkers` is rejected by tinypool with
  "options.minThreads and options.maxThreads must not conflict"). No timeout was inflated,
  no assertion weakened (the 2,000-file budgets are byte-identical), no retries added.
  Tradeoff: wall-clock rises ~10–25% (187 s → ~203–233 s) in exchange for heartbeat
  headroom; documented in a config comment.
- Before/after evidence (exit codes exact):
  - Before (default config): full suite 348/348 green once (186.88 s) — proving
    flakiness, not health; baseline prompt run red per §1.
  - Isolated analyzer-matrix (current tree): 28/28, 50.68 s, exit 0.
  - After fix: `pnpm test` → 347/348 once (single intermittent assertion failure, output
    not captured — see limitation), then 348/348 (202.91 s, exit 0); `pnpm release:check`
    (= check + test + bundle + smoke) → 60 files / 348 passed (210.91 s), bundle
    `sigil-cli-0.0.0.tgz` SHA-256 `9c3f89e9…7545`, smoke passed, overall exit 0.
    `pnpm check`, `release:bundle`, `release:smoke`, `git diff --check` all exit 0.
  - 2,000-file fixture under the fix (stable across runs): full ~15.2–15.3 s (132 files/s),
    incremental ~11.6–12.1 s, exact reuse ~0.9 s; payload ~1.92 MB JSON, DB ~7.1 MB.
- Known limitation: one unidentified intermittent failure in four full runs. Prime suspect
  is the relative-timing assertion `incrementalMs < fullMs` in `large-fixture.test.ts`
  (only ~20% margin on this hardware class). It was deliberately NOT relaxed without
  failure evidence, per the no-weakening rule; if it recurs, capture the failing test
  name and harden with a margin or attempt-bounded retry with flake logging — not silent
  green.

## 5. Remaining ATL backlog estimates (ATL-3 through ATL-12)

Linear could not be refreshed from this environment; parent/child counts below follow the
governing plan (§8: ATL-3 parent of the Batch 3 slice ATL-13/14/15 plus B3.4/B3.5 issues;
ATL-4…ATL-12 one issue per batch). One agent-day = one focused agent workday; review =
independent review + checkpoint; human = approval/decision latency; external = sandbox,
credential, rehearsal, or certification effort. Batches are strictly serial (each gates the
next), so parallel agents only compress within-batch sub-deliverables (~25–35% engineering
saving, review/integration still serial).

| Batch | Scope left | Agent impl | Integration/repair | Review+ckpt | Human wait | External/cert |
|---|---|---|---|---|---|---|
| ATL-14 closure | review only (impl done) | 0.5–1 | 0.5 | 1–2 | 1–3 d | — |
| ATL-15 (B3.3 rest) | fixtures, budgets, migration path | 2–4 | 1–2 | 1–2 | 1–3 d | — |
| B3.4 queries/CLI | bounded graph queries, inspect/repair | 3–5 | 1–2 | 1–2 | 1–2 d | — |
| B3.5 integration | manifest/planning/package/workflow use | 3–5 | 2–3 | 1–2 | 1–3 d | — |
| ATL-4 authority/patterns | claims, conflicts, invariants | 5–8 | 2–3 | 2–3 | 2–4 d | — |
| ATL-5 synthesis/rediscovery | cards, compression, 2nd pass | 4–6 | 2–3 | 1–2 | 2–4 d | — |
| ATL-6 work packages | decomposition + Linear delivery | 3–5 | 2–3 | 1–2 | 1–3 d | 2–4 (Linear sandbox/app) |
| ATL-7 isolation | worktrees, scope policy, budgets | 4–6 | 2–3 | 2–3 | 2–3 d | — |
| ATL-8 review lanes | lanes, quorum, evidence-use ledger | 3–5 | 1–2 | 1–2 | 1–3 d | — |
| ATL-9 orchestration | keychain, PR/CI, webhooks, reconcile | 5–8 | 3–4 | 2–3 | 2–4 d | 4–8 (GitHub+Linear sandboxes, webhooks) |
| ATL-10 learning | dataset, metrics, profiles, shadow | 3–5 | 1–2 | 1–2 | 2–4 d | corpora (overlapped) |
| ATL-11 hardening | backup, locks, packaging, docs, threat model | 5–8 | 3–4 | 2–4 | 2–4 d | 2–4 (platform/signing matrices) |
| ATL-12 certification | journeys, adversarial matrix, rehearsal | 3–5 | 2–4 | 2–4 | 3–7 d | 2–5 (2 repos + Trail Safe rehearsal) |

- Totals: engineering (impl+integration) ≈ 60–105 agent-days; review ≈ 18–31; human
  serial wait ≈ 20–46 elapsed days across ~14 gates; external ≈ 10–21 (partly overlapped).
- Elapsed guidance: one primary agent ≈ 16–26 weeks wall-clock including waits; two to
  three bounded parallel agents with one integrator/reviewer ≈ 11–18 weeks (dependency
  chain dominates; no linear speedup). Critical path: ATL-14 approval → ATL-15 →
  B3.4 → B3.5 → ATL-4 → … → ATL-12 → owner sign-off; Batch 9 credentials/sandboxes and
  Batch 12 rehearsal access are the longest external lead items — request them by ATL-6.
- Assumptions: agent availability steady; human responds in 1–3 days per gate; no
  re-architecture findings; Windows+Linux validation; test suite stays at current
  stability; Trail Safe rehearsal granted without production access.
- Confidence: medium for Batch 3 remainder (grounded in this tree); low for ATL-6…ATL-12
  (external unknowns dominate). Top risks: Batch 9 webhook/idempotency scope growth,
  Batch 11 platform matrix, human latency compounding across 14 serial gates, and
  timing-flaky perf assertions on slower hardware.

## 6. Proposed Linear updates (NOT applied)

No Linear writes were made (no approval evidence, no explicit write authorization). Proposed:

- ATL-14: `Backlog` → `In Review`, with links to `6bdc200`, this assessment §2/§4, and a
  request for independent review of the exact `166563b..6bdc200` diff. Missing: reviewer
  assignment and approval record. Do NOT mark Done until approval + green `release:check`
  on the approved tree are both traceable.
- ATL-15: stays blocked (dependency on ATL-14). Add comment noting B3.3 implementation is
  substantially present but unapproved in the dirty worktree.
- ATL-3 (parent): stays open; note B3.1 Done, B3.2 in review, B3.3+ planned.
- Estimates (§5): do not write to Linear without explicit user authorization.

## 7. Changed-file list (inherited vs agent-authored) and next decision

- Inherited dirty (tracked, pre-existing): `DOCs/M0_Engineering_Design/16…v3…md`,
  `DOCs/M0_Engineering_Design/17_evidence_index_storage.md`,
  `packages/evidence-index/package.json`, `packages/evidence-index/src/engine.ts`,
  `packages/evidence-index/src/incremental.test.ts`, `packages/persistence/src/core-schema.ts`,
  `packages/persistence/src/evidence-index.test.ts`, `packages/persistence/src/evidence-index.ts`,
  `packages/persistence/src/migrations.test.ts`, `packages/schemas/src/evidence-index.ts`,
  `pnpm-lock.yaml`, `scripts/build-release.mjs`, `scripts/release-smoke.mjs`.
- Inherited untracked: `.freebuff/`, the three `DOCs/ATL-*/Sigil_Next_Actions*` prompt docs,
  `opencode.json`, `analyzer-matrix.test.ts`, `analyzer/{contract,registry,typescript-analyzer}.ts`.
- Agent-authored: `vitest.config.ts` (forks + min/max workers with rationale comment) and
  this report. No other edits; no commits, stashes, or history changes.
- Suggested safe checkpoint path (proposal only, needs user approval): after ATL-14
  independent approval, the user/approver commits the B3.2 tree clean, then reviews and
  commits B3.3 separately — never via reset/stash/clean of the current dirty files.
- Next human decision required: assign an independent reviewer for the exact B3.2 diff and
  confirm whether the out-of-order B3.3 worktree may remain in place (uncommitted) during
  that review, or be set aside by the user without destructive operations.
