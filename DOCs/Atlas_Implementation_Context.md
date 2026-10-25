# Atlas Implementation Context and Production-Orchestration Plan

| Field | Value |
|---|---|
| Status | Governing delivery baseline |
| Applies from | Commit `c6df706` (`Build semantic context manifest v3`) |
| Supersedes | Informal batch descriptions and chat-only implementation instructions |
| Owners | Product owner approves intent and final release; Atlas orchestrator/reviewer approves each implementation batch |
| Delivery rule | A batch may start only when every dependency is approved and checkpointed |
| Product proving ground | Trail Safe, after Atlas production-readiness certification |

## 1. Purpose and authority

This document governs the remaining work required to make Atlas a production-grade, local-first workflow orchestrator and evidence-based work validator. It records what Atlas can prove today, the target operating model, and the dependency-ordered batch contracts used to create implementation work.

The approved product requirements in `DOCs/Atlas_V1_Product_Requirements_Document.md` remain authoritative for product behavior. The designs in `DOCs/M0_Engineering_Design/` remain authoritative for implemented subsystem details. This document is authoritative for delivery order, batch boundaries, cross-batch invariants, and promotion gates. If sources conflict, implementation must stop and surface the conflict; an agent must not silently choose one.

Linear issues derived from this document are execution views. They may add operational detail but may not weaken this document. Changes to scope, dependency order, safety policy, or acceptance criteria require an approved document update before issue changes or implementation.

## 2. Evidence baseline

The current capability assessment is grounded in:

- workflow states and transitions in `packages/domain/src/state.ts` and `packages/workflow-engine/src/transitions.ts`;
- artifacts, schemas, hashes, dependencies, approvals, findings, and persistence in `packages/schemas`, `packages/persistence`, and `packages/artifact-store`;
- Linear and GitHub behavior in `packages/adapters-linear` and `packages/adapters-github`;
- context discovery and semantic analysis in `packages/context-discovery` and `packages/app-services/src/context-*.ts`;
- planning, handoff, checks, reviews, orchestration, and completion in `packages/app-services`;
- security behavior in `packages/security` and the process/Git adapters;
- the Batch 1 design `DOCs/M0_Engineering_Design/15_evidence_and_independent_review_gates.md`;
- the Batch 2 design `DOCs/M0_Engineering_Design/16_context_manifest_v3_semantic_discovery.md`;
- independent Batch 2 validation: 247 tests, repository checks, release bundle, installed-binary smoke test, and diff-integrity check all passed before commit `c6df706`.

## 3. Atlas capability at the approved baseline

### 3.1 Capabilities that exist now

Atlas currently provides:

1. A deterministic, table-driven task lifecycle from intake through context, planning, contract approval, implementation, checks, independent review, fixes, completion, and recovery.
2. A local SQL.js system of record with sessions, events, locks, artifact dependencies, immutable files, approvals, findings, and SHA-256 lineage.
3. Read-oriented Linear issue intake for title, description, labels, comments, attachments, status, priority, and assignee, plus explicit comment posting.
4. Manual task intake and local-first operation when SaaS integrations are unavailable.
5. Context manifest/content-pack v3 with:
   - deterministic TypeScript/JavaScript symbols, imports, re-exports, local resolution, reverse-dependency expansion, package boundaries, and test associations;
   - root-to-scope repository instruction precedence;
   - configured pins, exclusions, required categories and globs, source and graph budgets, gaps, and quality state;
   - exact line-range evidence, hashes, redaction, binary/secret exclusions, realpath containment, and Git/config/task freshness;
   - optional bounded AI reranking that may rank real candidates but cannot invent repository evidence.
6. Planning gates that require a fresh, semantically complete v3 manifest and matching content pack. Legacy manifests remain inspectable but fail closed for planning.
7. Versioned implementation contracts with schema validation, semantic comparison, explicit human approval, and supersession controls.
8. Agent handoffs containing the approved contract, bounded context evidence, file boundaries, commands, and immutable artifact lineage.
9. Shell-free command execution, argument validation, bounded output, secret redaction, path containment, and Git before/after capture.
10. Dependency-ordered deterministic checks, affected-path rules, logging, redaction, freshness, design/visual evidence, and required-check policy.
11. Independent review packages containing substantive contract, diff, check, and evidence content; actor separation; finding-specific resolution; and iterative repair packages.
12. Completion gates requiring the current approved contract, current immutable diff, fresh required checks, accepted independent review, no open blocker, Git freshness, and explicit human approval.
13. Read-oriented GitHub repository/PR inspection and PR commenting.
14. Release bundling and installed-binary smoke validation.

### 3.2 Known limits at this baseline

Atlas does not yet provide:

- a persistent incremental or historical code-evidence index;
- semantic analyzers beyond the current TypeScript/JavaScript graph, or deep framework/API/schema/data-flow analysis;
- a typed authority model for conflicting requirements, repository rules, architecture documents, code, tests, and task assertions;
- an explicit pattern, invariant, anti-pattern, and exception extraction artifact;
- synthesis and compression that preserves provenance under strict token budgets;
- a plan-aware second discovery pass that tests a draft plan against newly identified evidence;
- outcome-based learning from evidence use, omissions, review findings, retries, and human decisions;
- full Linear project/parent/sub-issue/dependency/state orchestration or webhook-driven intake/reconciliation;
- automatic branch/worktree and PR creation, CI aggregation, review-thread handling, merge detection, or idempotent webhook reconciliation;
- production credential storage; current integration secrets are reversibly encoded rather than protected by an OS keychain or external secret reference;
- a universal remote-evidence requirement for PR/CI/merge completion modes;
- production-scale persistence, backup/restore, multi-process coordination, retention/compaction, and crash/corruption certification;
- an explicit wall-clock/directory-visit discovery cutoff in addition to the current source/byte/graph budgets.

## 4. Target capability after all batches

At the end of this plan, Atlas will orchestrate a task from a normalized architecture/work-package source through dependency-correct Linear work, evidence-backed planning, isolated implementation, deterministic and independent validation, bounded repair, PR/CI review, human approval, merge reconciliation, and closure.

Atlas will be able to prove:

- which versioned sources authorized every requirement and decision;
- which repository evidence was discovered, synthesized, used, omitted, contradicted, or invalidated;
- that a plan survived a second evidence-discovery pass and unresolved conflicts were escalated;
- that implementation occurred in an isolated, policy-compliant workspace against the current approved contract;
- that check and review evidence is fresh, content-resolved, independently produced, and bound to the exact diff;
- that retries and repair loops stayed within declared limits;
- that Linear, GitHub, local Git, artifacts, and workflow state converge idempotently after duplicate, delayed, missing, or reordered events;
- that only a human or an explicitly authorized external actor performs product decisions, architecture exceptions, destructive Git actions, final approval, and merge;
- that credentials, sensitive content, and telemetry obey least-privilege and redaction policies;
- and that completion cannot be inferred from an agent’s self-report.

## 5. Global implementation invariants

Every batch must preserve these rules:

1. **Evidence before inference.** Models may interpret cited evidence; they may not create repository or external-system facts.
2. **Immutable lineage.** Every derived artifact records schema version, content hash, producer/actor, source versions, parent artifacts, repository identity, Git fingerprint, and time.
3. **Current superseding inputs.** Gates resolve the current approved/superseding artifact, never merely any historical approved artifact.
4. **Independent validation.** The implementing actor cannot be the sole reviewer or final validator of its own work.
5. **Finding-specific closure.** A general clean review never blanket-resolves prior findings. Every closure cites disposition and fresh evidence.
6. **Fail closed.** Missing, stale, truncated, conflicted, skipped, malformed, or unverifiable required evidence blocks progression.
7. **Human authority.** Material scope/architecture choices, accepted deviations, destructive Git operations, final completion, and merge remain explicit human decisions.
8. **Bounded execution.** Discovery, models, commands, retries, repair cycles, network calls, artifacts, and logs have configured budgets and terminal stop conditions.
9. **Safe external writes.** Mutations are previewable, explicitly authorized by policy, idempotent, attributable, and reconcilable.
10. **Local-first degradation.** Remote failures do not corrupt local state or fabricate success; supported local work continues where valid.
11. **Backward-safe evolution.** Schema and storage changes have migrations, compatibility behavior, fixtures, rollback/repair guidance, and fail-closed handling for unsupported versions.
12. **No Trail Safe compromise.** Atlas experiments run behind explicit capability flags or shadow mode and cannot weaken Trail Safe architecture, tests, review, or approval gates.

## 6. Roles and separation of responsibility

| Role | May do | Must not do |
|---|---|---|
| Intake/decomposition service | Normalize source documents, propose work packages, create authorized Linear structures | Invent acceptance criteria or silently alter architecture |
| Context-discovery agent | Ask evidence questions, rank existing candidates, identify gaps/conflicts | Invent files, symbols, requirements, or claim completeness without deterministic proof |
| Planner | Draft a contract and request more evidence | Implement code, approve its plan, or suppress unresolved conflicts |
| Implementing agent | Change files within the approved contract and report deviations/blockers | Approve contract changes, validate its own work as sufficient, merge, or close work |
| Deterministic validators | Run declared checks and produce machine evidence | Convert skipped/unavailable checks into passes |
| Independent review agents | Review exact contract/diff/evidence in declared lanes and cite findings | Share implementing-actor identity where independence is required, or close unrelated findings |
| Atlas orchestrator | Enforce state, lineage, budgets, separation, reconciliation, and handoffs | Make product decisions or infer approvals |
| Human approver | Resolve ambiguity, approve contracts/deviations/completion/merge | N/A; decisions must still be explicit and recorded |

## 7. Batch promotion protocol

For every batch:

1. Start from a clean checkpoint of all approved dependencies.
2. Produce an implementation plan grounded in current code and this document.
3. Restrict changes to the batch scope. Newly discovered prerequisite work is reported, not silently absorbed.
4. Run focused tests during implementation and the full repository validation before handoff.
5. Produce a review packet resolving the contract, changed files, exact diff, test/check evidence, migrations, documentation, and known limitations.
6. An independent reviewer assesses correctness, security, compatibility, failure modes, and scope.
7. Blocking findings enter bounded, finding-specific repair/re-review cycles.
8. The Atlas orchestrator/reviewer explicitly approves and checkpoints the batch.
9. Only then may the next dependent batch start.

Default repair limit: two implementation repair attempts per finding and three total review cycles per batch. Exceeding either limit, encountering an architecture conflict, requiring destructive migration, or being unable to produce required evidence stops the batch for human decision.

## 8. Dependency-ordered implementation batches

### Batch 1 — Evidence and independent-review gates

**Status:** Completed and approved at commit `b8547d2`.

**Outcome:** Handoffs and completion use resolved evidence rather than artifact identifiers or agent assertions.

**Delivered:** immutable implementation diffs; content-resolved planning, agent, and review packages; actor separation; current-contract and freshness enforcement; finding-specific resolution; stronger required-check behavior; completion gating on accepted independent review.

**Acceptance evidence:** repository checks, focused adversarial tests, release validation, and independent code review were completed before checkpoint.

### Batch 2 — Semantic discovery and context manifest v3

**Status:** Completed and approved at commit `c6df706`.

**Depends on:** Batch 1.

**Outcome:** Planning and implementation begin from fresh, bounded, semantically enriched, code-resolved evidence.

**Delivered:** manifest/content-pack v3; TypeScript/JavaScript semantic graph; symbols/imports/re-exports/reverse dependencies/test associations; instruction chains; strict context configuration; pins/categories/budgets/gaps; safe AI reranking; evidence fragments and freshness; context inspect/status; legacy fail-closed behavior.

**Deliberate limits:** no persistent historical index, cross-language semantic platform, authority/conflict model, synthesis/compression, or plan-aware second pass.

**Acceptance evidence:** 247 tests, repository checks, release bundle, installed-binary smoke test, and diff-integrity check passed.

### Batch 3 — Persistent evidence index and semantic graph v2

**Status:** Planned.

**Depends on:** Batch 2.

**Outcome:** Discovery uses an incremental, content-addressed repository index with deeper and extensible semantics instead of rebuilding only a task-local graph.

**In scope:**

- versioned index schemas for repositories, Git commits, files, content hashes, symbols, imports, exports, callers/callees where provable, tests, configuration, schemas/APIs, and source classifications;
- incremental update/invalidation from Git and filesystem evidence;
- historical snapshots sufficient to compare relevant evidence across task runs and reviewed outcomes;
- an analyzer interface plus TypeScript/JavaScript analyzer v2; framework/language analyzers remain optional plugins but capability/gap reporting is mandatory;
- bounded graph queries, wall-clock/directory-visit limits, cancellation, corruption detection, rebuild/repair, inspect, and metrics;
- index migrations, fixtures, deterministic serialization, and legacy task compatibility.

**Non-goals:** embeddings as an authority source; organization-wide cloud indexing; silent semantic claims for unsupported languages.

**Acceptance:** unchanged repositories reuse the index deterministically; single-file changes invalidate only affected graph regions; deleted/renamed files do not leave authoritative ghost evidence; unsupported semantics produce gaps; corrupt/stale indexes fail closed or rebuild safely; large-repository performance and cancellation tests pass.

### Batch 4 — Authority, conflict resolution, patterns, and invariants

**Status:** Planned.

**Depends on:** Batch 3.

**Outcome:** Atlas can distinguish normative authority from descriptive evidence, surface conflicts, and extract reusable architectural patterns and invariants before planning.

**In scope:**

- typed claims with provenance, authority class, scope, version, confidence, and supersession;
- configurable precedence across approved contracts, architecture baselines/ADRs, repository instructions, policy/config, schemas/APIs, tests, implementation, issue text, comments, and model suggestions;
- conflict sets with deterministic detection, resolution records, accepted deviations, expiry/scope, and human-escalation state;
- a versioned pattern/invariant report covering conventions, boundary rules, security invariants, test obligations, anti-patterns, exceptions, and strength/evidence;
- independent citation validation ensuring every claim resolves to current evidence;
- inspection and audit commands that explain why an authority won.

**Non-goals:** model-selected policy precedence; automatic architecture waivers; treating frequency as authority.

**Acceptance:** contradiction fixtures block planning; same-scope authority is deterministic; stale/superseded claims cannot win; uncited or weak invariants are labeled and cannot become mandatory; human decisions are immutable and scoped; adversarial instruction-conflict tests pass.

### Batch 5 — Context synthesis, compression, and plan-aware rediscovery

**Status:** Planned.

**Depends on:** Batch 4.

**Outcome:** Atlas creates compact, provenance-preserving context and validates a draft plan through a bounded second discovery pass.

**In scope:**

- deterministic evidence deduplication and context cards for requirements, architecture, code, tests, APIs/schemas, patterns, conflicts, and gaps;
- extractive-first compression with source spans, loss/truncation markers, per-category budgets, and fidelity checks;
- a draft-plan schema whose steps declare evidence, affected boundaries, assumptions, risks, tests, and explicit context questions;
- second-pass queries derived from the draft plan; a versioned context delta; plan reconciliation and renewed approval when material evidence changes scope;
- bounded revision count, token/time budgets, cancellation, fallback, and inspectable quality metrics.

**Non-goals:** free-form summaries without citations; unlimited recursive agent research; approval of a plan by its author.

**Acceptance:** every synthesized assertion traces to exact evidence; hidden-relevant-file fixtures are found in pass two; contradictions reopen the plan; compression-loss fixtures block rather than omit required facts; no-op second passes are deterministic; revision limits escalate to a human.

### Batch 6 — Work packages and Linear decomposition

**Status:** Planned.

**Depends on:** Batch 5.

**Outcome:** Approved architecture/work documents become dependency-correct, single-PR work packages and idempotently managed Linear parent/sub-issues.

**In scope:**

- a work-package schema containing objective, rationale, evidence references, deliverables, acceptance criteria, non-goals, file/architecture boundaries, dependencies, risks, tests, validation expectations, and estimated change surface;
- deterministic decomposition/sizing rules and dependency graph validation;
- Linear creation/update for projects, parent/sub-issues, relations, labels, states, comments, attachments/references, and Atlas session linkage;
- preservation of Linear descriptions and comments in normalized task briefs; acceptance criteria derived only from explicit sources;
- preview/approval, idempotency keys, dry run, partial-failure recovery, and reconciliation.

**Non-goals:** autonomous prioritization of product goals; silently rewriting human-edited issues; starting implementation for blocked work.

**Acceptance:** a reference architecture document produces stable small issues; no issue is blocked by a future dependent issue; cycles/orphans/oversized work fail validation; duplicate delivery creates no duplicate issues; comments and acceptance criteria retain provenance; network and partial-write tests recover safely.

### Batch 7 — Isolated implementation and scope enforcement

**Status:** Planned.

**Depends on:** Batch 6.

**Outcome:** Atlas executes approved work in isolated branches/worktrees with enforceable scope and bounded agent repair.

**In scope:**

- safe branch/worktree creation, identity, cleanup preview, resume, and reconciliation;
- implementation packages resolving contract, context cards, evidence, boundaries, commands, stop conditions, and completion-report schema;
- changed-file, dependency, generated-file, migration, and forbidden-path policies;
- immutable before/after Git evidence, patch capture, deviation requests, and evidence-use events;
- agent time/output/retry/cost budgets, cancellation, crash recovery, and provider-neutral adapters.

**Non-goals:** autonomous merge; force operations; allowing implementation agents to expand scope or approve deviations.

**Acceptance:** dirty/base-drift/path-escape/symlink tests fail safely; parallel sessions cannot collide; out-of-scope diffs block; crashes resume without losing evidence; agent self-reports cannot override Git/check facts; cleanup is explicit and recoverable.

### Batch 8 — Independent review and evidence-use attribution

**Status:** Planned.

**Depends on:** Batch 7.

**Outcome:** Specialized independent reviews prove requirement coverage and record how context evidence influenced planning, implementation, and validation.

**In scope:**

- review lanes for contract/architecture, correctness, tests, security/privacy, migrations/data, UI/design/accessibility when applicable, and operations;
- reviewer identity/capability separation and quorum policy;
- an evidence-use ledger linking evidence to plan steps, code changes, tests, findings, deviations, and unused/contradicted evidence;
- finding schema/evidence sufficiency, deduplication without blanket closure, dispositions, fix batches, re-review, and bounded escalation;
- requirement-to-diff-to-test coverage and review completeness reports.

**Non-goals:** review by the implementing actor as the only approval; severity-free generic verdicts; auto-resolving prior findings.

**Acceptance:** actor-collision and stale-review fixtures block; every blocker cites exact current evidence; unrelated clean reviews cannot close findings; repair changes invalidate affected lanes; uncited requirements appear as coverage gaps; retry limits escalate.

### Batch 9 — Secure Linear/GitHub orchestration and reconciliation

**Status:** Planned.

**Depends on:** Batch 8.

**Outcome:** Atlas safely coordinates remote workflow state, PRs, CI, reviews, merge detection, and issue closure without losing local authority or idempotency.

**In scope:**

- OS keychain/credential-manager storage and environment-reference mode; migration from reversible Base64 with secret-safe diagnostics;
- least-privilege capability discovery and per-operation authorization;
- GitHub branch push/PR create-update, CI/check aggregation, review decisions/threads, comment/update operations, merge detection, and exact head/base binding;
- Linear webhook/poll intake, state/comment/link updates, dependency reconciliation, and close-after-merge policy;
- signed webhook verification where supported, event inbox/outbox, deduplication, replay, ordering, retry/backoff, dead-letter inspection, and manual repair;
- remote/local drift detection and explicit conflict resolution.

**Non-goals:** automatic merge or issue closure without approved policy and evidence; storing raw credentials in Atlas artifacts; assuming remote state is authoritative for local approvals.

**Acceptance:** duplicate/out-of-order/missing events converge; stale CI cannot pass a new head; PR/issue writes are idempotent; credential migration never logs secrets; revoked/insufficient credentials fail locally and safely; merge/close requires exact approved evidence; offline recovery reconciles on return.

### Batch 10 — Context-quality learning loop

**Status:** Planned.

**Depends on:** Batch 9.

**Outcome:** Atlas improves context selection from audited outcomes without allowing self-modifying heuristics to become unreviewed authority.

**In scope:**

- a privacy-bounded outcome dataset linking candidates, selected/used evidence, gaps, plan revisions, implementation deviations, findings, repair cycles, human additions/removals, and final outcomes;
- explicit quality metrics for precision proxies, omission discovery, citation coverage, compression fidelity, plan churn, review escapes, latency, and cost;
- versioned ranking profiles and explainable feature weights;
- offline replay, benchmark corpora, shadow evaluation, comparison reports, promotion/rollback, drift detection, and data retention/deletion;
- human approval before a learned profile becomes active.

**Non-goals:** training on raw private repositories by default; online self-modification; using task success as proof that evidence was correct.

**Acceptance:** learning is disabled by default or explicitly configured; shadow runs cannot alter workflow; profiles are reproducible/versioned/rollbackable; regressions block promotion; privacy and deletion tests pass; attribution metrics expose unused and missing evidence.

### Batch 11 — Production hardening and release readiness

**Status:** Planned.

**Depends on:** Batch 10.

**Outcome:** Atlas is durable, observable, supportable, and safe under production-scale failures and concurrency.

**In scope:**

- storage migration strategy, backup/restore, atomicity, corruption detection/repair, retention/compaction, and audit export;
- multi-process locks, lease recovery, cancellation, resource limits, and crash consistency;
- structured privacy-safe logs/metrics/traces, diagnostic bundles with preview/redaction, and operator runbooks;
- performance and scale budgets for indexing, synthesis, orchestration, and reconciliation;
- cross-platform packaging, upgrade/downgrade compatibility policy, dependency/security/license review, and release provenance;
- user/admin documentation, threat model, data map, and failure-recovery playbooks.

**Non-goals:** Atlas cloud service or multi-tenant collaboration unless separately approved.

**Acceptance:** backup/restore and migration matrices pass; kill/restart and concurrent-process tests preserve invariants; no P0/P1 data-loss, secret-exposure, false-approval, or destructive-action defect remains; performance budgets pass on representative repositories; release artifact provenance and smoke tests pass.

### Batch 12 — End-to-end and adversarial production certification

**Status:** Planned.

**Depends on:** Batch 11.

**Outcome:** The complete workflow is proven before Trail Safe implementation is allowed to depend on Atlas.

**In scope:**

- scripted golden journeys from architecture document through work packages, Linear, context/planning, isolated implementation, checks/reviews/fixes, PR/CI, human approval, merge, reconciliation, and closure;
- offline/resume, stale input, supersession, conflicting authority, missing context, corrupt index/database, interrupted agents, retry exhaustion, remote partial failure, duplicate webhooks, malicious issue/code content, secret fixtures, and actor-collision scenarios;
- at least two representative repositories and a Trail Safe rehearsal task that cannot modify production architecture;
- certification report with evidence matrix, open limitations, operational readiness, rollback criteria, and human sign-off.

**Non-goals:** beginning Trail Safe feature implementation; waiving failed gates to meet a date.

**Acceptance:** all required journeys pass from released binaries; every failure scenario stops or recovers as designed; no unresolved release-blocking finding exists; evidence is reproducible; the product owner explicitly approves Atlas for the Trail Safe proving phase.

## 9. Linear issue contract

Every batch issue must include:

- the batch number/title and this document path;
- outcome and why it is required now;
- approved dependency issue(s), never a future issue;
- evidence baseline and current limitations relevant to the batch;
- in-scope deliverables and explicit non-goals;
- schema/storage/API/CLI changes expected;
- acceptance criteria and adversarial tests;
- migration, compatibility, security, and documentation expectations;
- required handoff evidence and the promotion/stop rules from Section 7.

Issues are ordered by dependency, not merely priority. Batch 1 and Batch 2 are historical completed records. Batch 3 is the first executable issue. Each later issue is blocked only by its immediate predecessor unless the implementation uncovers an additional approved prerequisite. No agent may start a blocked issue.

## 10. Pull-request and work-size rules

A batch is an approval boundary, not necessarily one pull request. Before coding, its implementing agent must propose sub-deliverables when any of these applies:

- more than one independently migratable schema/storage boundary;
- more than one external integration mutation surface;
- an estimated diff above roughly 800 net lines of production code or 20 changed production files;
- more than one independently reviewable risk class;
- migrations and behavioral rollout cannot be safely reviewed together;
- full focused validation is expected to exceed 20 minutes.

Sub-deliverables remain within one batch and use dependency order: schemas/contracts first, deterministic core second, adapters/integration third, CLI/inspection fourth, migrations/documentation/tests throughout. Every PR must leave the repository buildable, preserve backward-safe behavior, and cite the parent batch issue and exact acceptance slice. The batch is approved only after integrated review of all its PRs.

## 11. Trail Safe proving policy

Trail Safe begins only after Batch 12 certification and human approval. During proving:

- the approved Trail Safe architecture baseline and ADRs outrank Atlas suggestions;
- Atlas experimental context/ranking features run in shadow mode until separately promoted;
- deterministic Trail Safe tests, architecture checks, independent review, and human merge remain mandatory;
- Atlas failures pause or fall back to an approved manual workflow; they do not relax product gates;
- Atlas defects and product defects are tracked separately with explicit causal evidence;
- no Atlas experiment may rewrite Trail Safe history, merge code, accept an architecture deviation, or close a task autonomously.

## 12. Definition of program completion

This program is complete only when Batch 12 is approved, all preceding batch checkpoints and migrations are traceable, the complete released-binary scenario matrix passes, no release-blocking finding remains, operational and recovery documentation is current, and the product owner explicitly authorizes the Trail Safe proving phase.
