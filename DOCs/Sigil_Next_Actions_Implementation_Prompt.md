# Sigil Next-Actions Implementation Prompt

You are the implementation and assessment agent for the immediate Sigil production-readiness actions. Work in the existing Sigil CLI repository and prepare a reviewable result covering checkpoint/status reconciliation, test-suite reliability, and estimates for the remaining ATL backlog.

Do not treat this as authorization to implement later Sigil batches. Preserve all existing user work. Do not reset, clean, stash, overwrite, or silently relocate dirty files. Do not approve your own work or report an issue Done without the required independent approval evidence.

## Outcome

Produce an evidence-backed, review-ready account of:

1. What the repository proves about B3.2 and the in-progress B3.3 work, and how that maps to ATL-14 and ATL-15.
2. Why the full test run timed out in Vitest's worker `onTaskUpdate` reporting while the analyzer-matrix file passed in isolation, and what minimal change makes the full validation reliable.
3. A realistic remaining-effort estimate for ATL-3 through ATL-12, including engineering, integration, independent review, human decision gates, and external-service certification.

Keep implementation changes limited to fixes required to make the existing validation gate reliable. Do not expand the product scope.

## Baseline recorded when this prompt was prepared

Re-read every item below before acting; these are observations, not permission to assume the state is unchanged.

- Branch: `codex/sigil-production-orchestration`.
- HEAD: `6bdc200` — `Checkpoint B3.2: incremental indexing, invalidation and historical snapshots (ATL-14)`.
- ATL-14 and ATL-15 both showed `Backlog` in Linear, despite the B3.2 checkpoint commit and uncommitted analyzer work in the checkout.
- The worktree was dirty. It included tracked evidence-index, persistence, schema, lockfile, release-script, and design-document changes; untracked `.freebuff/`, ATL-14/ATL-15 prompt documents, `opencode.json`, analyzer code, and analyzer tests were also present.
- `pnpm check` passed.
- The full `pnpm test` run reported 322 passing tests across 59 of 60 files, then exited nonzero with three Vitest worker `onTaskUpdate` timeouts associated with `packages/evidence-index/src/analyzer-matrix.test.ts`.
- The analyzer-matrix file passed by itself: 28 tests in about 96 seconds (about 91 seconds of test time).
- The 2,000-file evidence-index fixture passed in the full run. It reported about 19.3 seconds for a full build, 14.4 seconds for an incremental update, and 1.1 seconds for unchanged snapshot reuse on the preparation machine.
- The release bundle, installed-binary smoke test, and full release gate were not run in that assessment.

## Authority and required reading

Before changing files or Linear, read:

1. Repository `AGENTS.md` files and the global working agreement at `~/.agent-squad/core/AGENTS.md`.
2. `DOCs/Sigil_Implementation_Context.md`, especially Sections 1, 5, 7–10, and 12.
3. Linear issues `ATL-3`, `ATL-13`, `ATL-14`, and `ATL-15`, including dependency relations and current state history.
4. `DOCs/ATL-14_Implementation_Prompt.md` and `DOCs/ATL-15_Implementation_Prompt.md`.
5. The complete current `git status`, staged and unstaged diff, untracked-file inventory, and recent commit history.
6. `vitest.config.ts`, the analyzer-matrix test file, evidence-index tests, and release scripts.

The governing implementation context and issue acceptance criteria outrank this prompt. If they conflict, stop and report the conflict rather than silently choosing a side.

## Worktree and change-safety rules

- Capture branch, HEAD, Node/pnpm versions, platform, status, and diff before any edit.
- Inspect untracked files without printing or exposing credential contents. Do not alter `sigil.config.json`, `.freebuff/`, `opencode.json`, or other unrelated user-owned files.
- Keep one primary writer. Do not reset, checkout, rebase, amend, commit, stash, or clean the existing worktree.
- Separate inherited changes from your own changes in the final report. Keep any new edits narrowly scoped and reviewable.
- Do not implement ATL-16 or any later batch.
- Do not mark ATL-14 or ATL-15 Done, approve work, or bypass a dependency gate.

## Phase 1 — Reconcile B3.2/B3.3 against evidence

1. Inspect the entire committed B3.2 checkpoint and current dirty/untracked changes. Map each change to ATL-14, ATL-15, another batch, or unrelated work; cite file paths and commits.
2. Compare the ATL-14 acceptance criteria to implementation and actual validation evidence. Do not infer approval from the commit title or a green typecheck.
3. Compare the existing analyzer code/tests to ATL-15 scope. Identify what is implemented, incomplete, outside scope, or unverified. Do not add B3.3 work until ATL-14's hard start gate is satisfied.
4. Record whether an independent review of the exact B3.2 diff exists and whether Linear's state is supported by the evidence.
5. Produce a proposed status reconciliation for ATL-14, ATL-15, and parent ATL-3. Update Linear only if the authenticated user has explicitly authorized those writes and the relevant approval gate is satisfied. Otherwise, provide exact proposed changes and the missing approval evidence; leave Linear untouched.
6. Do not declare the worktree clean by moving or discarding changes. If clean checkpoints are needed, propose a safe, user-reviewable method and stop before destructive or history-rewriting actions.

## Phase 2 — Stabilize validation

Investigate the full-suite worker timeouts without treating the passing isolated test as proof that the full gate is healthy.

1. Reproduce the full-suite failure and collect exact exit codes, durations, test/file counts, worker settings, warnings, and resource observations.
2. Determine whether the failure comes from worker scheduling/reporting, over-parallelized slow fixtures, filesystem/SQL.js/Git contention, or a test defect. Distinguish a test assertion failure from a runner timeout.
3. Choose the smallest deterministic fix. Prefer appropriate worker scheduling or separating an intentionally long benchmark lane. Do not inflate generic timeouts or weaken the 2,000-file performance assertion without evidence.
4. Add or adjust tests/config only when necessary to prevent recurrence, and explain the tradeoff. Do not hide retries or make nondeterministic failures appear green.
5. Run and report, at minimum:

   ```bash
   pnpm check
   pnpm exec vitest run packages/evidence-index/src/analyzer-matrix.test.ts --reporter=verbose
   pnpm test
   pnpm release:bundle
   pnpm release:smoke
   git diff --check
   ```

   Run `pnpm release:check` if the preceding gates pass and it does not merely repeat an unresolved expensive failure. Report every command's actual exit code; do not claim completion if the full suite or required release gate remains red.

## Phase 3 — Estimate the remaining ATL backlog

1. Refresh all ATL team issue statuses and dependencies. Count parent and child issues separately, and reconcile apparent stale statuses with repository evidence.
2. Estimate remaining work by batch from ATL-3 through ATL-12, grounded in issue descriptions and the governing plan. Distinguish:
   - agent implementation effort;
   - integration and repair effort;
   - independent review and checkpoint time;
   - human decision/approval wait time;
   - secure external-service setup and certification time.
3. Give ranges for one primary agent and for two or three bounded parallel agents with one integrator/reviewer. Account for dependency-critical paths; do not assume linear speedup from adding agents.
4. State assumptions about agent availability, human response time, test stability, external credentials/sandboxes, and Trail Safe rehearsal access. Include confidence and the major schedule risks.
5. Do not write estimates into Linear unless the authenticated user has explicitly authorized those writes. Otherwise, provide a proposed estimate table and the evidence behind it.

## Required deliverables

Create a concise, reviewable report at `DOCs/Sigil_Next_Actions_Assessment.md` containing:

1. Baseline fingerprints and exact repository/Linear state observed.
2. ATL-14 acceptance-to-evidence mapping and independent-approval state.
3. ATL-15 implementation progress and hard start-gate result.
4. Full-suite timeout root cause, minimal fix, and before/after validation evidence.
5. Remaining ATL batch estimates, assumptions, confidence, and critical path.
6. Proposed Linear updates, clearly marked as applied or not applied and why.
7. Changed-file list separating inherited work from agent-authored work, known limitations, and the next human decision required.

Do not include secrets, credential values, raw private source excerpts, or unnecessary full logs in the report.

## Completion criteria

The task is complete when the reconciliation report is evidence-backed, the validation failure is fixed and the required checks pass, and the backlog estimate is reviewable. If ATL-14 lacks independent approval, ATL-15 must remain blocked; report that dependency clearly instead of bypassing it. If any required evidence or authorization is unavailable, finish all independent work and state the exact remaining blocker without changing external state.
