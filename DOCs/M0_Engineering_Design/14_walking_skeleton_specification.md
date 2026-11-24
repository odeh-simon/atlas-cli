# Deliverable N: Walking-Skeleton Specification

## Scope

The walking skeleton proves the Sigil architecture end to end without production integrations.

Included:

1. Manual task creation.
2. Persistent local session.
3. Minimal context-manifest import.
4. Planning-package export.
5. Implementation-contract import.
6. Contract validation.
7. Human contract approval.
8. Manual agent-package export.
9. Simulated execution-result import.
10. One deterministic local check.
11. Review-package generation.
12. Review-report import.
13. Finding disposition.
14. Completion-gate evaluation.
15. Human completion approval.
16. Session close and resume.

Excluded: Linear, GitHub remote operations, Figma API access, direct Claude Code/Codex invocation, OS notifications, visual comparison, and complex context discovery.

## User Journey

```text
sigil init --yes
sigil start --manual --title "Usage details" --objective "Show usage rows for admins"
sigil context import examples/context-manifest.json
sigil plan
sigil contract import examples/contract.md
sigil approve contract 1 --yes
sigil implement export --manual
sigil execution import examples/execution-result.json
sigil checks run
sigil review prepare
sigil review import examples/review-report.md
sigil findings disposition REV-001 --resolve --evidence "check:basic passed"
sigil complete --check
sigil approve completion --yes
sigil status
sigil resume
```

## CLI Commands

| Command | Primary transition |
| --- | --- |
| `sigil init` | project config created |
| `sigil start --manual` | `draft -> intake_ready` |
| `sigil context import <file>` | `intake_ready -> context_ready` |
| `sigil plan` | `context_ready -> planning_ready` |
| `sigil contract import <file>` | `planning_ready -> contract_draft` |
| `sigil approve contract <version>` | `contract_draft -> contract_approved` |
| `sigil implement export --manual` | `contract_approved -> implementation_ready` |
| `sigil execution import <file>` | `implementation_ready -> implementation_reconciled` |
| `sigil checks run` | `implementation_reconciled -> checks_completed` |
| `sigil review prepare` | `checks_completed -> review_ready` |
| `sigil review import <file>` | `review_ready -> review_imported` |
| `sigil findings disposition ...` | `review_imported -> findings_dispositioned` |
| `sigil complete --check` | `findings_dispositioned/checks_completed -> completion_ready` |
| `sigil approve completion` | `completion_ready -> completed` |
| `sigil status/resume` | read/reconcile state |

## Required Data and Artifacts

| Step | Data | Artifact |
| --- | --- | --- |
| Start | title, objective, repo identity | manual task input, task brief |
| Context import | minimal sources/gaps/budgets | context manifest |
| Plan | task + context hashes | planning package |
| Contract import | required contract sections | implementation contract draft |
| Approval | actor, hash, timestamp | contract approval |
| Agent export | contract, rules, report schema | manual agent package |
| Execution import | simulated status, changed files, claims | execution report |
| Check | deterministic command result | check result |
| Review prepare | contract, run, check result | review package |
| Review import | summary/findings | review report, finding records |
| Disposition | finding decision/evidence | finding disposition |
| Completion | gates/evidence/approval | completion report |

## Minimal Deterministic Check

Walking skeleton check: `basic-session-integrity`.

Passes when:

- current session has approved contract;
- execution report exists;
- referenced artifact hashes verify;
- no unredacted secret fixture appears in generated package text.

Fails otherwise. This avoids requiring a real project build before Git/process integration exists.

## Acceptance Tests

| Test | Expected result |
| --- | --- |
| WS-001 Manual happy path | Full journey reaches `completed`; status/resume shows terminal evidence. |
| WS-002 Missing objective | `start --manual` leaves draft or exits validation error without session-ready state. |
| WS-003 Invalid context manifest | Rejected draft; planning blocked. |
| WS-004 Contract missing tests | Contract draft stored; approval blocked. |
| WS-005 Implement before approval | Exit code 4; no agent package generated. |
| WS-006 Simulated agent says done but check missing | Completion blocked. |
| WS-007 Review with blocking finding | Completion blocked until disposition. |
| WS-008 Stale artifact hash | Resume marks recovery required. |
| WS-009 Pause blocks forward transition | `plan/implement/complete` blocked while paused. |
| WS-010 Crash after DB commit before artifact promote | Resume promotes matching staged artifact or blocks with repair choice. |

## Demo Script

```text
1. Initialize a temp Git repository and run sigil init.
2. Start a manual task with title/objective.
3. Import a two-source context manifest.
4. Generate and inspect planning package.
5. Import a valid contract and approve it.
6. Export manual implementation package.
7. Import simulated execution result.
8. Run basic-session-integrity check.
9. Prepare review package.
10. Import a review report with one blocking finding.
11. Show completion blocked.
12. Resolve the finding with evidence.
13. Approve completion.
14. Close terminal, run sigil resume, show completed state and evidence.
```

## Failure Scenarios

| Scenario | Expected handling |
| --- | --- |
| Duplicate manual start with same title/session key | Offer resume or explicit new session; no duplicate by accident. |
| Artifact file deleted externally | Hash verification fails; dependent transition blocked. |
| Invalid review report | Stored as draft/rejected; no actionable findings created. |
| Completion approval stale after new execution import | Completion gate re-evaluates and previous draft invalidated. |
| User cancels session | Normal progression blocked; artifacts inspectable. |

## Definition of Done

- All walking-skeleton commands exist with text and JSON output.
- SQLite schema/migrations cover skeleton entities.
- Artifact writes are atomic and hash-verified.
- State machine rejects invalid transitions.
- Contract approval is explicit and immutable.
- Completion approval is explicit and terminal.
- `status` and `resume` work after process exit.
- Per-commit and PR test suites for skeleton pass on at least Windows, macOS, and Ubuntu CI before M1 expansion.

## Formal Readiness Assessment

### Decisions Approved by This Design

- TypeScript/Node CLI architecture.
- SQLite metadata plus immutable artifact files.
- Primary workflow state plus pause/archive/cancel overlays.
- Append-only audit events with mutable current state.
- Provider-neutral adapter contracts.
- Human-mediated ChatGPT handoffs.
- Non-destructive Git boundary.
- Direct process execution with argument arrays.
- Manual walking skeleton as the first vertical slice.

### Decisions Approved by Human Review

- Node 22 LTS and supported OS matrix.
- Exact user data directory and optional project mirror behavior.
- Root `sigil.config.json` plus ignored `sigil.local.json`.
- Markdown contract format with `sigil-metadata` block.
- Supported Claude Code and Codex version matrix.
- V1 product telemetry and analysis with strict privacy/content-exclusion controls.
- Default material-change categories.
- Visual evidence policy: user-supplied plus optional project screenshot commands.

### Feasibility Risks

- Future native keychain dependency behavior across Windows/macOS/Linux, and possible future native SQLite driver selection if `sql.js` does not meet release performance or locking needs.
- Agent CLI version drift and non-structured outputs.
- Context-discovery heuristics may need pilot tuning.
- Crash recovery across DB/file boundaries needs rigorous tests.

### Security Blockers

No known security blocker prevents the walking skeleton because it excludes remote credentials and direct agent execution. Full M1/M2 must not begin credentialed adapter work until keychain and redaction tests are implemented. Telemetry implementation must not ship until telemetry contract tests and privacy review verify that content-bearing fields are excluded.

### Integration Uncertainties

- Exact Claude Code and Codex invocation modes.
- Linear/GitHub/Figma API field availability in pilot accounts.
- Project-specific design-system scanner rules.

### Can M1 Implementation Begin?

M1 walking-skeleton implementation can begin now. The M0 human decisions are recorded in `M0_Review_Decisions.md`.

### First Ticket to Implement

Start with `M1-001: Workspace scaffold`, followed immediately by `M1-002`, `M1-003`, and `M1-006`. The first vertical user-visible ticket is `M1-010: Manual task start`.

### Work That Must Not Begin Yet

- Direct Claude Code or Codex invocation.
- Linear/GitHub/Figma authenticated adapters.
- Git branch creation.
- Visual comparison.
- Telemetry transport or analytics dashboards before telemetry schemas, privacy controls, and content-exclusion tests exist.
- Any destructive Git operation.
- PR creation/update or Linear writes.
- Browser automation or model API integration.

## Final Status

`M0 APPROVED FOR WALKING SKELETON`

This status means the architecture is sufficient to begin the manual walking skeleton without foundational invention. The M0 human decisions have been accepted, including the telemetry amendment. It does not approve full implementation of all integrations until the skeleton validates persistence, state transitions, artifacts, approvals, checks, review, completion, and recovery.
