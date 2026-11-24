# Deliverable B: Architecture Decision Records

All ADRs are `Accepted for M0 review` unless noted. Each ADR may be revisited only when its listed conditions are met and a replacement ADR preserves PRD gates, auditability, and safety.

## ADR-001: TypeScript and Node.js Platform

- Status: Accepted for M0 review.
- Context: Sigil is a cross-platform CLI integrating Git, SaaS APIs, JSON/Markdown schemas, and local processes.
- Decision: Implement Sigil in TypeScript on Node.js.
- Rationale: Strong ecosystem for CLIs, schemas, SaaS SDKs, Markdown, process APIs, and cross-platform packaging.
- Alternatives considered: Go for static binary; Rust for safety; Python for scripting speed.
- Consequences: Requires Node runtime and dependency governance; faster adapter development.
- Risks: Node package supply chain and native dependency variance.
- Mitigations: Lockfiles, vulnerability scanning, provenance, adapter contract tests.
- PRD requirements affected: AT-SET-001, NFR-016, NFR-017.
- Revisit when: Native packaging or performance becomes a blocker.

## ADR-002: Supported Node.js Version

- Decision: Target Node.js 22 LTS for V1, with CI validating latest patch.
- Rationale: Current LTS gives modern APIs and long support window.
- Alternatives: Node 20 LTS for broader installed base; latest current for newest APIs.
- Consequences: Users on older Node must upgrade or use packaged distribution.
- Risks: Some enterprise environments lag.
- Mitigations: Clear doctor diagnostics and installer docs.
- PRD: AT-SET-001, OQ-001, NFR-016.
- Revisit when: Pilot repositories standardize on a different LTS.

## ADR-003: Supported Operating Systems

- Decision: Support latest supported Windows, latest macOS, and Ubuntu LTS in V1 CI.
- Rationale: Matches PRD cross-platform commitment and Windows PowerShell requirement.
- Alternatives: macOS/Linux only for V1; Windows best-effort.
- Consequences: Process, path, lock, and keychain code must be abstracted.
- Risks: Git/path/signal differences.
- Mitigations: OS fixture matrix and direct process APIs.
- PRD: NFR-016, OQ-001.
- Revisit when: Pilot usage proves a smaller or larger matrix is required.

## ADR-004: CLI Framework Selection

- Decision: Use Commander for command parsing.
- Rationale: Mature, lightweight, TypeScript-friendly, enough for nested commands and help.
- Alternatives: Clipanion, oclif, yargs.
- Consequences: Packaging remains simple; richer plugin CLI features are custom.
- Risks: Manual conventions for JSON/errors.
- Mitigations: Shared CLI output layer and snapshot tests.
- PRD: AT-SET-001, NFR-018.
- Revisit when: Plugin-driven command discovery is needed.

## ADR-005: Local-First Architecture

- Decision: All core state, artifacts, checks, Git facts, and manual handoffs are local.
- Rationale: Required by PRD and reduces privacy/infrastructure risk.
- Alternatives: Cloud service or hybrid sync.
- Consequences: No transparent collaboration or cross-machine sync in V1.
- Risks: Local corruption/loss.
- Mitigations: Backups, exports, doctor, archive.
- PRD: NFR-001, NFR-010.
- Revisit when: V2 team collaboration is approved.

## ADR-006: SQLite Selection

- Decision: Use SQLite as local metadata store. For the M1 walking skeleton, use `sql.js` behind the persistence boundary to avoid Node's experimental `node:sqlite` warning and avoid requiring native Windows C++ build tools.
- Rationale: Transactional, portable, queryable, reliable for single-user local workflows.
- Alternatives: JSON files, LevelDB, Postgres, `node:sqlite`, `better-sqlite3`.
- Consequences: Requires migrations and backup strategy. `sql.js` introduces asynchronous initialization and file export semantics that must stay isolated inside persistence.
- Risks: WASM startup/export costs, durability semantics differing from native SQLite, and later driver migration if larger workloads need native performance.
- Mitigations: Keep a narrow persistence boundary, use atomic file writes around exported database bytes, test migrations/backup/restore, and revisit native drivers during release hardening if the supported Windows toolchain/prebuild story is acceptable.
- PRD: AT-SES-001, NFR-005, NFR-017.
- Revisit when: persistence performance, locking, concurrency, or release packaging requires a native SQLite driver.

## ADR-007: Database Authority Versus Filesystem Authority

- Decision: SQLite is authoritative for metadata/state; artifact files are authoritative for artifact bytes.
- Rationale: Keeps large human artifacts inspectable while preserving transactional state queries.
- Alternatives: DB blobs only; filesystem only.
- Consequences: Requires reconciliation by hash.
- Risks: DB/file divergence.
- Mitigations: Atomic write protocol, hashes, doctor repair.
- PRD: AT-ART-001, NFR-005.
- Revisit when: Divergence repair proves unreliable.

## ADR-008: Event Log Scope

- Decision: Use append-only audit events plus mutable current state; do not full-event-source V1.
- Rationale: Auditability without replay complexity.
- Alternatives: Full event sourcing; no event log.
- Consequences: Current state is stored directly and must be tested with events.
- Risks: Event/current-state mismatch.
- Mitigations: Same transaction writes transition event and state.
- PRD: NFR-007, AT-SES-002.
- Revisit when: Multi-user sync/replay is required.

## ADR-009: Artifact Storage Location

- Decision: Canonical artifacts live under user data directory; optional gitignored project mirror/link is allowed.
- Rationale: Avoids committing sensitive handoff content by default.
- Alternatives: Project-local `.sigil` by default; DB-only.
- Consequences: Sessions are machine-local unless exported.
- Risks: Discoverability lower.
- Mitigations: `sigil status` paths and export.
- PRD: OQ-003, OQ-010, AT-ART-001.
- Revisit when: Team sharing becomes V2 scope.

## ADR-010: Session Storage Location

- Decision: Store session DB and artifacts under OS user data root, namespaced by repository identity and session ID.
- Rationale: Supports multiple repos and avoids repository pollution.
- Alternatives: One DB per repo in repo; one global DB only.
- Consequences: Need repo identity mapping.
- Risks: Remote URL privacy in paths.
- Mitigations: Hash repo IDs in paths; display friendly names in metadata.
- PRD: AT-SES-001, NFR-009.
- Revisit when: Project-portable sessions are prioritized.

## ADR-011: Project Configuration Location

- Decision: Use `sigil.config.json` at repo root for secret-free project config and `sigil.local.json` for machine-local overrides.
- Rationale: Explicit, portable, easy to validate.
- Alternatives: `.sigil/config.json`, package.json field.
- Consequences: Adds root file if committed.
- Risks: Repo noise or accidental secrets.
- Mitigations: schema rejects secret values; local file gitignored by init.
- PRD: AT-SET-002, AT-SET-004, OQ-002.
- Revisit when: Pilot repo requires hidden config directory.

## ADR-012: User Configuration Location

- Decision: Store user preferences under OS config directory, not repo.
- Rationale: Keeps personal behavior local.
- Alternatives: Environment variables only; home dotfile only.
- Consequences: Need config explain with source paths.
- Risks: Cross-platform path confusion.
- Mitigations: doctor output and docs.
- PRD: AT-SET-004.
- Revisit when: Enterprise managed config is required.

## ADR-013: Secret Storage Mechanism

- Decision: Store credential values in OS keychain through a credential adapter; config stores aliases or env var references.
- Rationale: Prevents plaintext tokens in project files.
- Alternatives: Encrypted local file; env only.
- Consequences: OS-specific adapter work.
- Risks: Keychain unavailable in headless environments.
- Mitigations: Explicit env reference fallback, never silent plaintext.
- PRD: AT-AUTH-001, NFR-008.
- Revisit when: CI use cases require managed secret providers.

## ADR-014: Schema Validation Approach

- Decision: Use Zod for runtime validation and TypeScript inference.
- Rationale: Strong fit for imported artifacts and adapter boundaries.
- Alternatives: JSON Schema/Ajv; io-ts.
- Consequences: Need JSON schema export if external tooling needs it.
- Risks: Large schemas can become costly.
- Mitigations: Versioned schema modules and fixtures.
- PRD: AT-CON-001, NFR-018.
- Revisit when: OpenAPI/JSON Schema distribution becomes mandatory.

## ADR-015: Database Migration Approach

- Decision: Versioned SQL migrations with transactional apply, pre-migration backup, and migration record table.
- Rationale: Transparent and recoverable.
- Alternatives: ORM auto migrations.
- Consequences: Manual migration authoring.
- Risks: Cross-version mistakes.
- Mitigations: migration tests and rollback fixtures.
- PRD: NFR-017.
- Revisit when: schema complexity demands a migration framework.

## ADR-016: Atomic Database and Artifact Writes

- Decision: Stage artifact bytes, hash them, write DB metadata in transaction, promote artifacts atomically, record finalize event.
- Rationale: Prevents half-visible approved artifacts.
- Alternatives: DB first; file first only.
- Consequences: Requires recovery of staged/promoted states.
- Risks: Crash between DB commit and rename.
- Mitigations: transition journal and reconciliation.
- PRD: AT-SES-001, AT-ART-001, NFR-005.
- Revisit when: filesystem semantics fail on supported OS.

## ADR-017: Session Locking

- Decision: Use DB lock rows plus advisory lock files and heartbeat for session mutation.
- Rationale: Prevents concurrent mutation and supports stale detection.
- Alternatives: SQLite busy timeout only; lock file only.
- Consequences: More recovery code.
- Risks: stale locks block work.
- Mitigations: PID/process validation and explicit unlock recovery.
- PRD: NFR-004, AT-SES-001.
- Revisit when: daemon/server model appears.

## ADR-018: State-Machine Implementation

- Decision: Implement state transitions as explicit table-driven guards in domain code, not ad hoc command logic.
- Rationale: Testability, traceability, predictable invalid transitions.
- Alternatives: External state-machine library; command-local checks.
- Consequences: New transitions require central updates.
- Risks: table grows large.
- Mitigations: transition matrix tests.
- PRD: AT-SES-002, AT-CMP-001.
- Revisit when: parallel workflow branches become necessary.

## ADR-019: Adapter Architecture

- Decision: Define capability-checked, provider-neutral TypeScript interfaces with namespaced metadata.
- Rationale: Keeps workflow independent of SaaS/agent specifics.
- Alternatives: Direct SDK calls from app services.
- Consequences: More initial abstraction.
- Risks: lowest-common-denominator limitations.
- Mitigations: capability model and extension fields.
- PRD: AT-AGT-001, NFR-012.
- Revisit when: one provider requires a core model extension.

## ADR-020: Linear Integration Method

- Decision: Use official Linear API/SDK for read-only V1 intake.
- Rationale: Least surprise and supportable auth/rate handling.
- Alternatives: Web scraping; manual only.
- Consequences: Requires token/scopes.
- Risks: API changes.
- Mitigations: adapter contract tests and fixture snapshots.
- PRD: AT-INT-001.
- Revisit when: Linear writeback is approved.

## ADR-021: GitHub Integration Method

- Decision: Use official GitHub API for optional read metadata only in V1.
- Rationale: Local Git remains authoritative.
- Alternatives: `gh` CLI dependency; no GitHub.
- Consequences: API auth optional.
- Risks: rate limits.
- Mitigations: cached snapshots and offline fallback.
- PRD: AT-INT-004.
- Revisit when: PR creation/update enters scope.

## ADR-022: Figma Integration Method

- Decision: Parse Figma URLs locally; fetch metadata through official API when configured; accept user evidence files.
- Rationale: Preserves design truth without false fidelity.
- Alternatives: require API; screenshots only.
- Consequences: Some references remain metadata-limited.
- Risks: inaccessible files.
- Mitigations: explicit limitations in manifests.
- PRD: AT-INT-005.
- Revisit when: visual comparison tooling is configured.

## ADR-023: Human-Mediated ChatGPT Handoff

- Decision: V1 exports/imports artifacts and may copy/open destinations; it does not automate ChatGPT browser sessions.
- Rationale: Honest, secure, compatible with consumer subscriptions.
- Alternatives: Browser automation; official API.
- Consequences: Some manual copy remains.
- Risks: user imports wrong response.
- Mitigations: hashes, templates, validation, stale detection.
- PRD: AT-PLN-002.
- Revisit when: official API adapter is approved.

## ADR-024: Claude Code Invocation Model

- Decision: Invoke installed Claude Code CLI through coding-agent adapter using approved package file/stdin mode based on detected capabilities.
- Rationale: Provider remains replaceable.
- Alternatives: direct SDK/model API.
- Consequences: Capability detection required.
- Risks: CLI interface changes.
- Mitigations: version matrix and manual export fallback.
- PRD: AT-AGT-003, OQ-005.
- Revisit when: supported CLI versions change materially.

## ADR-025: Codex Invocation Model

- Decision: Invoke installed Codex CLI through the same coding-agent adapter contract as Claude Code.
- Rationale: Same contract identity works across agents.
- Alternatives: Codex-specific workflow state.
- Consequences: Provider-specific features stay optional metadata.
- Risks: reduced use of advanced Codex capabilities.
- Mitigations: extension field and adapter-specific package formatter.
- PRD: AT-AGT-001, AT-AGT-003.
- Revisit when: Codex requires durable resumable sessions in core.

## ADR-026: Local Process Execution

- Decision: Use direct spawn/execFile with executable plus argument arrays; PTY only when declared.
- Rationale: Reduces shell injection and cross-platform variation.
- Alternatives: shell commands everywhere.
- Consequences: Config must model args explicitly.
- Risks: Some project commands rely on shell features.
- Mitigations: explicit shell-mode with warnings and allowlist.
- PRD: AT-EXE-001, NFR-008.
- Revisit when: shell-mode dominates pilot commands.

## ADR-027: Shell-Safety Strategy

- Decision: Reject interpolation by default, canonicalize paths, validate env vars, redact output, and block destructive patterns.
- Rationale: Repository/config content is untrusted.
- Alternatives: trust project config.
- Consequences: Some setup is stricter.
- Risks: false positives.
- Mitigations: explicit approved exceptions with audit.
- PRD: Security req 7-8, NFR-008.
- Revisit when: policy scanner blocks valid common workflows.

## ADR-028: Git Safety Boundary

- Decision: V1 never resets, force-checkouts, force-pushes, merges, rebases, deletes branches, stashes, discards, or silently commits.
- Rationale: Trust and PRD safety.
- Alternatives: configurable automation.
- Consequences: User handles some Git operations.
- Risks: slower workflow.
- Mitigations: clear recovery instructions and evidence exports.
- PRD: AT-GIT-001, NFR-019.
- Revisit when: explicit project policy for commits is approved.

## ADR-029: Context-Discovery Strategy

- Decision: Deterministic discovery from task references, Git facts, configured roots, rule files, text/symbol search, tests, GraphQL, and user pins.
- Rationale: V1 correctness cannot rely on undefined AI relevance.
- Alternatives: model-ranked context.
- Consequences: Heuristics need tuning.
- Risks: omissions.
- Mitigations: manifest gaps, pins, exclusions, freshness.
- PRD: AT-CTX-002, AT-CTX-003.
- Revisit when: official model API relevance is approved.

## ADR-030: Context-Budget Strategy

- Decision: Apply per-source, per-category, and global byte/file/time budgets; report overflow explicitly.
- Rationale: Prevents noise and silent truncation.
- Alternatives: unlimited context.
- Consequences: Packages may require narrowing.
- Risks: critical content omitted.
- Mitigations: required-source classes and user pins.
- PRD: AT-CTX-005, NFR-014.
- Revisit when: target agents support larger contexts reliably.

## ADR-031: Artifact Versioning

- Decision: Version artifacts by type-local sequence plus content hash and schema version.
- Rationale: Human-friendly versions and strong integrity.
- Alternatives: hash-only; mutable latest files.
- Consequences: More metadata.
- Risks: orphaned versions.
- Mitigations: retention/archive rules.
- PRD: AT-ART-001.
- Revisit when: storage size becomes material.

## ADR-032: Approval Immutability

- Decision: Approved artifacts and approval records are append-only and never edited; corrections supersede.
- Rationale: Prevents intent drift.
- Alternatives: mutable approval status.
- Consequences: More versions.
- Risks: accidental approval clutter.
- Mitigations: status views group superseded versions.
- PRD: AT-APP-001, AT-APP-002.
- Revisit when: legal retention policy requires redaction/deletion.

## ADR-033: Material Contract-Change Detection

- Decision: Treat changes to scope, architecture, data/security, design constraints, acceptance, tests, or prohibitions as material by default.
- Rationale: Conservative approval model.
- Alternatives: user decides every diff; AI classifier.
- Consequences: More approvals.
- Risks: ceremony.
- Mitigations: section diff and non-material classification with rationale.
- PRD: AT-APP-002, OQ-011.
- Revisit when: pilot shows excessive false material changes.

## ADR-034: Error and Exit-Code Conventions

- Decision: Use typed domain errors mapped to stable CLI exit codes and JSON problem objects.
- Rationale: Scriptability and clear UX.
- Alternatives: generic exit 1.
- Consequences: More maintenance.
- Risks: inconsistent mapping.
- Mitigations: central error mapper tests.
- PRD: AT-SET-001, NFR-018.
- Revisit when: external automation needs richer codes.

## ADR-035: Logging and Diagnostic Retention

- Decision: Retain redacted structured logs and command logs under session retention policy; source content excluded by default.
- Rationale: Supports recovery without leakage.
- Alternatives: no logs; full logs.
- Consequences: Need cleanup/archive.
- Risks: residual sensitive data.
- Mitigations: redaction tests and preview manifests.
- PRD: NFR-015, NFR-009.
- Revisit when: enterprise retention policies are defined.

## ADR-036: Packaging and Distribution

- Decision: npm package for V1 CLI plus signed/checksummed release artifacts where supported.
- Rationale: Natural for Node CLI and cross-platform install.
- Alternatives: standalone binaries only; Homebrew/winget first.
- Consequences: Node install requirement.
- Risks: environment path conflicts.
- Mitigations: doctor and version command checks.
- PRD: AT-SET-001.
- Revisit when: packaged binary adoption is required.

## ADR-037: Testing Strategy

- Decision: Test through unit, state, schema, migration, crash, adapter contract, Git/process fixtures, security, CLI snapshots, and E2E release suites.
- Rationale: Recovery and safety are product-critical.
- Alternatives: mostly E2E.
- Consequences: Higher upfront test investment.
- Risks: slow CI.
- Mitigations: tiered per-commit/PR/nightly suites.
- PRD: release criteria, NFR-004, NFR-011.
- Revisit when: CI duration exceeds target.

## ADR-038: Telemetry Policy

- Decision: V1 includes product telemetry and analysis in addition to local diagnostics, with strict content exclusion, user-visible controls, redaction tests, and a documented telemetry event taxonomy.
- Rationale: Product telemetry is needed to measure workflow health, adoption, recovery outcomes, handoff reduction, and quality-gate effectiveness while preserving developer trust.
- Alternatives: local diagnostics only; no diagnostics; unrestricted analytics.
- Consequences: Requires telemetry schema design, privacy review, configuration UX, test coverage, and release documentation.
- Risks: accidental content leakage, user mistrust, regulatory/privacy concerns, and analytics becoming a hidden dependency for core workflow.
- Mitigations: no source code/prompts/diffs/secrets/filenames/repository URLs/raw issue text/raw design text/artifact content; redaction and contract tests; telemetry preview/export; disable control; core workflow remains local-first and functional without telemetry transport.
- PRD: NFR-009, OQ-012.
- Revisit when: privacy review requires opt-in/opt-out changes, enterprise policy controls are added, or telemetry events need content-bearing fields.

## ADR-039: Visual-Evidence Handling

- Decision: V1 stores user-supplied visual evidence and optional project screenshot command results; it does not claim pixel-perfect fidelity without configured tooling.
- Rationale: Avoids false confidence.
- Alternatives: require screenshot automation; no visual evidence.
- Consequences: Manual evidence remains possible.
- Risks: stale screenshots.
- Mitigations: link evidence to contract and Git state.
- PRD: AT-INT-005, AT-CHK-002, OQ-009.
- Revisit when: visual regression tooling is available.

## ADR-040: Design-System Policy Enforcement

- Decision: Enforce deterministic project-configured scans for tokens, arbitrary Tailwind values, prohibited imports/components, and component mappings.
- Rationale: Catches known violations without subjective AI claims.
- Alternatives: manual review only; AI visual review.
- Consequences: Project-specific rule authoring.
- Risks: false positives/negatives.
- Mitigations: fixtures, exceptions with rationale, documented scanner limits.
- PRD: AT-CHK-002, OQ-008.
- Revisit when: design system exposes machine-readable rules.
