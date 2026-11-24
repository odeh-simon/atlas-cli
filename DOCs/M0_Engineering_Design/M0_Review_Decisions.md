# M0 Review Decisions

| Field | Value |
| --- | --- |
| Date | 12 July 2026 |
| Reviewer | Product/owner response in Codex session |
| Applies to | Sigil M0 Engineering Design Package |
| Status | Approved with telemetry amendment |

## Decisions

| # | Decision | Answer | Resulting design position |
| --- | --- | --- | --- |
| 1 | Node/runtime | Yes | Sigil V1 targets Node.js 22 LTS. |
| 2 | Supported OS | Yes | V1 officially supports Windows, macOS, and Ubuntu LTS from the start, validated by CI. |
| 3 | Local data storage | Yes | Canonical Sigil state lives in the OS user data directory, with optional project-local `.sigil/` mirrors or links. |
| 4 | Project config files | Yes | Sigil uses root-level `sigil.config.json` for secret-free project config and `sigil.local.json` for ignored local overrides. |
| 5 | Contract format | Yes | Contracts use Markdown with a `sigil-metadata` JSON block plus required headings. |
| 6 | Agent support | Yes | Claude Code and Codex support is limited to a tested version matrix, with manual export fallback for unsupported direct invocation. |
| 7 | Telemetry | No to local-diagnostics-only | V1 must include product telemetry and analysis, subject to explicit privacy, consent, redaction, and content-exclusion controls. |
| 8 | Material-change and visual evidence policy | Yes | Material changes are conservative by default; visual evidence is user-supplied plus optional project screenshot commands, with no pixel-perfect claims unless configured tooling proves them. |

## Telemetry Amendment

Telemetry is approved as a V1 product capability. It must remain privacy-preserving:

- no source code, prompts, diffs, secrets, filenames, repository URLs, raw issue text, raw design text, or artifact content;
- explicit user-visible configuration and documentation;
- local preview/export of telemetry categories;
- stable event taxonomy for product analysis;
- redaction tests and telemetry contract tests before release;
- ability to disable telemetry.

Whether telemetry is opt-in by default remains governed by PRD privacy language unless superseded by a later product decision.

## Implementation Implication

The walking skeleton may begin. Full credentialed integrations and direct agent invocation still wait until the skeleton validates persistence, state transitions, artifacts, approvals, checks, review, completion, and resume.
