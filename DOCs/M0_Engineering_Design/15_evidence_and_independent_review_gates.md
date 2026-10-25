# Evidence Delivery and Independent Review Gates

## Status

Batch 1 production hardening. This document strengthens the V1 artifact chain without adding Linear issue writes, GitHub pull-request creation, or the Batch 2 semantic discovery graph.

## Normative evidence chain

Every implementation that can reach completion must have this current, hash-verified chain:

`task_brief -> context_manifest -> context_content_pack -> approved implementation_contract -> agent_implementation_package -> agent_run_log/manual import -> implementation_diff -> execution_report -> check_run_log/check_result -> review_package -> independent review_report -> completion_report`

Artifact IDs are provenance, not usable evidence by themselves. Planning, implementation, and review packages contain the bounded substantive inputs they require. Repository content remains untrusted data and never overrides Atlas instructions or the approved contract.

## Context content pack

The content pack is derived from the current manifest and contains the selected source URI, source kind, reason, discovered SHA-256, original and included byte lengths, redaction/truncation flags, and bounded source text. Sources must be regular files whose real paths remain inside the real repository root; lexical containment alone is insufficient because a symlink or junctioned parent can escape. Binary, secret-path, missing, non-regular, escaped, or hash-mismatched sources block both import and pack creation. Imported manifest envelope identity is discarded and rebuilt at the trusted Atlas boundary. Scout `missing_context` and `questions` become blocking manifest gaps. A blocked manifest and rejected pack are retained for diagnosis, while the session remains at intake.

Existing sessions with only a context manifest must rebuild or re-import context to generate a pack. V1 schemas continue to parse legacy artifacts, but completion never treats missing Batch 1 bindings as valid evidence.

## Implementation diff

Package export and agent invocation require the exact clean Git root, branch, HEAD, and snapshot recorded by a machine-readable v2 implementation package. The package also binds the current approved contract and context pack by ID and hash. These checks occur before an agent is invoked. Atlas captures an immutable, bounded working-tree patch and untracked text additions, then binds the execution report to the implementation package, contract, context pack, diff, and implementation run/actor. Secret-sensitive paths are omitted and the artifact is rejected. Binary or truncated patches are also rejected rather than passed to a reviewer as incomplete evidence. Manual execution import validates the recorded package base before attributing the current patch to the execution; legacy runs must export a new package and rerun.

## Independent review

The review package embeds the approved contract, exact diff artifact, check results and run logs, context references, Git fingerprint, visual evidence, and prior open/reopened findings. Review preparation rejects an execution whose package/contract/context bindings are no longer current. A review report records a trusted-boundary reviewer actor/run distinct from the implementation actor/run and is bound to the contract hash, diff artifact hash, and Git fingerprint. Manual import requires `atlas review import <file> --actor <trusted-reviewer-id>`; payload identity fields are not authoritative.

A generic clean review does not resolve prior findings. A finding closes only through:

1. explicit human disposition with a reason and resolution evidence; or
2. a fresh independent review that names the finding and supplies structured resolution references (`artifact_id`, with optional `claim`/`location`) to valid current diff/check artifacts. Free-form strings and substring matches never auto-resolve findings.

## Completion and checks

Completion requires the session's current approved contract, latest fresh passing required checks, a safely reviewable current diff, a fresh independent review bound to that contract/diff/check/Git state, and no open or reopened blocking findings. The completion report depends on the contract, checks, review, and diff. Human completion approval remains mandatory.

Affected-path skipping remains valid for targeted checks, but if configured required checks exist, at least one configured substantive required check must execute. The built-in integrity check cannot satisfy that requirement by itself. An `alwaysRun` check ignores affected-path matching; the built-in session-integrity check is always-run. A set in which every configured required check skips fails with `atlas/configured-required-validation-executed`; a project with only the built-in integrity check remains valid.

## Repair guidance

- Missing/legacy content pack: rerun `atlas context build` or import a manifest whose included sources exist and can be hashed.
- Stale pack: rebuild context against the current HEAD.
- Rejected diff: remove secret/binary changes or split the task, then rerun implementation.
- Stale checks/review: rerun checks, prepare a new review package, and import a fresh independent report.
- Prior blocker: supply explicit evidence through a human disposition or `resolved_findings` in the next independent report.

## Deferred

The symbol/import/API/schema discovery graph, work-package schema, isolated worktrees, specialized reviewer lanes, secure OS credential store, Linear/GitHub lifecycle writes, webhooks, and external reconciliation are later batches.
