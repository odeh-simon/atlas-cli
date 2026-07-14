# Deliverable E: Artifact and Schema Contracts

## Artifact Contract Principles

- Every primary artifact has human-readable Markdown and machine-readable JSON metadata unless it is inherently binary evidence.
- JSON metadata is canonicalized and hashed. Markdown includes a metadata block with artifact ID, schema version, session ID, parent artifact IDs, and hashes.
- Database metadata indexes artifact identity, type, status, hash, and dependencies; artifact files hold full content.
- Approved artifacts are immutable. Imported invalid artifacts may be stored as rejected drafts but cannot replace valid approved versions.

## Common Zod-Oriented Types

```ts
import { z } from "zod";

export const Id = z.string().min(1);
export const IsoDateTime = z.string().datetime();
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ArtifactType = z.enum([
  "task_brief",
  "linear_task_snapshot",
  "manual_task_input",
  "context_manifest",
  "context_source_record",
  "planning_package_metadata",
  "decision_record",
  "implementation_contract",
  "contract_approval",
  "contract_change_record",
  "agent_implementation_package",
  "execution_run",
  "execution_report",
  "command_result",
  "check_definition",
  "check_result",
  "review_package",
  "review_report",
  "finding",
  "finding_disposition",
  "fix_batch",
  "override",
  "completion_report",
  "session_export",
  "diagnostic_bundle_manifest"
]);

export const Sensitivity = z.enum(["public", "internal", "confidential", "secret-redacted"]);
export const ProducerType = z.enum(["atlas", "user", "adapter", "agent", "import"]);

export const ArtifactEnvelope = z.object({
  artifact_id: Id,
  session_id: Id,
  type: ArtifactType,
  schema_version: z.number().int().positive(),
  content_version: z.number().int().positive(),
  created_at: IsoDateTime,
  producer: z.object({
    type: ProducerType,
    id: z.string().optional()
  }),
  sensitivity: Sensitivity,
  parents: z.array(Id).default([]),
  replaces: Id.optional(),
  content_sha256: Sha256,
  metadata: z.record(z.string(), z.unknown()).default({})
});
```

## Artifact Registry

| Artifact | Purpose | Producer | Consumer | Required fields beyond envelope | Optional fields | Sensitivity | Immutability/invalidation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Task brief | Normalized task baseline | Atlas | Plan/context | title, objective, source, repo_id, references | acceptance_criteria | internal | Superseded when intake changes |
| Linear task snapshot | Raw/normalized Linear read | Linear adapter | Task brief | issue_id, url, fetched_at, fields_available | comments, labels | confidential | Stale after TTL/refresh |
| Manual task input | User-provided intake | User | Task brief | title, objective, repo_path | references | internal | Draft until validated |
| Context manifest | Traceable selected context | Context service | Plan/agent/review | sources, exclusions, budgets, fingerprints | gaps | confidential | Invalidated by source hash/TTL/git changes |
| Context source record | Per-source evidence | Context service | Manifest | uri, kind, reason, hash, size | excerpt, symbols | confidential | Immutable per source hash |
| Planning package metadata | Planning handoff index | Atlas | User/ChatGPT | package_path, input_artifacts, ready_label | clipboard_status | confidential | Invalidated by context/task change |
| Decision record | Approved/proposed decision | User/Atlas | Review/completion | status, rationale, affected_requirements | alternatives | internal | Superseded, not edited |
| Implementation contract | Authoritative intent | User import | Agent/review/gates | required sections, unresolved_questions, prohibitions, acceptance, tests | component_mappings | confidential | Approval freezes version |
| Contract approval | Approval evidence | Atlas | Gates/audit | contract_artifact_id, sha256, actor, approved_at | rationale | internal | Append-only |
| Contract change record | Semantic diff | Atlas | Approval gate | previous_contract, next_contract, materiality | section_diffs | internal | Immutable |
| Agent implementation package | Bounded agent input | Atlas | Agent/manual user | contract, git, rules, instructions, report_schema | referenced_artifacts | confidential | Invalidated by contract/git/context |
| Execution run | Process lifecycle facts | Atlas/adapter | Status/recovery | run_id, agent_kind, status, package | provider_metadata | internal | Status updates in DB; artifact snapshots immutable |
| Execution report | Run summary | Atlas/agent | Checks/review | contract, git_before_after, changed_files, claims, evidence | deviations | confidential | Invalidated by Git divergence |
| Command result | Command execution fact | Runner | Checks/audit | executable, args, cwd, exit, duration, log_refs | signal | internal | Immutable |
| Check definition | Configured check | Config | Check runner | name, command, args, required, timeout | dependencies | internal | Versioned by config hash |
| Check result | One check outcome | Check runner | Gates/review | check_definition, git_fingerprint, status, command_result | failure_summary | internal | Stale on git/config change |
| Review package | Contract-based review input | Atlas | User/ChatGPT | contract, diff, checks, rubric, stale_label | evidence | confidential | Invalidated by contract/git/check change |
| Review report | Imported review output | User import | Findings | review_package_hash, summary, findings | reviewer_notes | confidential | Draft if stale/malformed |
| Finding | Unit of review work | Atlas | Disposition/fix | severity, title, evidence, contract_link, action | affected_files | internal | Status via disposition only |
| Finding disposition | Developer decision | User | Fix/completion | finding_id, disposition, reason, actor | resolution_evidence | internal | Append-only |
| Fix batch | Approved fixes | Atlas | Agent | finding_ids, contract, git_head, instructions | excluded_findings | confidential | Invalidated by finding/git/contract change |
| Override | Gate exception | User/Atlas | Gates/audit | gate_id, scope, reason, actor | expiry | internal | Append-only; some gates non-overrideable |
| Completion report | Final evidence package | Atlas/User | Audit/export | contract, git, checks, findings, approvals | overrides | confidential | Append-only terminal artifact |
| Session export | Portable session bundle | Atlas | User/import | manifest, artifact_hashes, db_extract | include_logs flag | confidential | Immutable bundle |
| Diagnostic bundle manifest | Preview of diagnostics | Atlas | Support/user | included_records, excluded_sensitive, hashes | notes | secret-redacted | User approves bundle creation |

## Core Schemas

```ts
export const Reference = z.object({
  original_text: z.string(),
  canonical_url: z.string().url().optional(),
  kind: z.enum(["figma", "github", "linear", "file", "url", "unknown"]),
  source_location: z.string().optional(),
  status: z.enum(["parsed", "malformed", "inaccessible", "fetched"])
});

export const TaskBrief = ArtifactEnvelope.extend({
  type: z.literal("task_brief"),
  title: z.string().min(1),
  objective: z.string().min(1),
  source: z.enum(["linear", "manual"]),
  repo_id: Id,
  references: z.array(Reference),
  acceptance_criteria: z.array(z.string()).default([])
});

export const ContextSourceRecord = ArtifactEnvelope.extend({
  type: z.literal("context_source_record"),
  uri: z.string().min(1),
  kind: z.enum(["file", "symbol", "git", "figma", "github", "linear", "instruction", "test", "operation", "evidence"]),
  reason: z.string().min(1),
  fingerprint: z.object({ sha256: Sha256.optional(), git_sha: z.string().optional(), fetched_at: IsoDateTime.optional() }),
  byte_length: z.number().int().nonnegative(),
  included: z.boolean(),
  exclusion_reason: z.string().optional()
});

export const ContextManifest = ArtifactEnvelope.extend({
  type: z.literal("context_manifest"),
  sources: z.array(ContextSourceRecord),
  budgets: z.object({
    max_files: z.number().int().positive(),
    max_bytes: z.number().int().positive(),
    used_files: z.number().int().nonnegative(),
    used_bytes: z.number().int().nonnegative()
  }),
  gaps: z.array(z.object({
    id: Id,
    severity: z.enum(["blocking", "warning", "info"]),
    description: z.string()
  })).default([]),
  freshness: z.enum(["fresh", "stale", "partial"])
});

export const ContractSection = z.object({
  heading: z.string(),
  body_markdown: z.string(),
  not_applicable_reason: z.string().optional()
});

export const ImplementationContract = ArtifactEnvelope.extend({
  type: z.literal("implementation_contract"),
  status: z.enum(["draft", "valid", "approved", "rejected", "superseded"]),
  objective: ContractSection,
  scope: z.object({ in_scope: z.array(z.string()), out_of_scope: z.array(z.string()) }),
  approved_decisions: z.array(z.object({ id: Id, decision: z.string(), rationale: z.string() })),
  technical_approach: ContractSection,
  affected_subsystems: z.array(z.string()),
  reuse: z.array(z.string()),
  constraints: z.array(z.string()),
  data_state_permissions: ContractSection,
  required_states: z.array(z.string()),
  accessibility_observability: ContractSection,
  edge_cases: z.array(z.string()),
  acceptance_criteria: z.array(z.string()).min(1),
  tests_and_validation: z.array(z.string()).min(1),
  unresolved_questions: z.array(z.object({
    question: z.string(),
    blocking: z.boolean()
  })).default([]),
  prohibitions: z.array(z.string())
}).superRefine((contract, ctx) => {
  if (contract.unresolved_questions.some(q => q.blocking)) {
    ctx.addIssue({ code: "custom", message: "Blocking unresolved questions prevent approval" });
  }
});

export const Approval = ArtifactEnvelope.extend({
  type: z.literal("contract_approval"),
  approved_artifact_id: Id,
  approved_sha256: Sha256,
  actor_id: z.string().min(1),
  approved_at: IsoDateTime,
  rationale: z.string().optional()
});

export const CommandResult = ArtifactEnvelope.extend({
  type: z.literal("command_result"),
  command_kind: z.enum(["agent", "check", "git", "adapter"]),
  executable: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  exit_code: z.number().int().optional(),
  normalized_status: z.enum(["succeeded", "failed", "cancelled", "timeout", "interrupted"]),
  duration_ms: z.number().int().nonnegative(),
  stdout_log_artifact_id: Id.optional(),
  stderr_log_artifact_id: Id.optional()
});

export const Finding = ArtifactEnvelope.extend({
  type: z.literal("finding"),
  finding_id: Id,
  review_iteration: z.number().int().positive(),
  severity: z.enum(["blocking", "important", "suggestion", "question", "accepted_deviation"]),
  title: z.string().min(1),
  description: z.string().min(1),
  evidence: z.array(z.string()),
  affected_files: z.array(z.string()).default([]),
  requirement_ids: z.array(z.string()).default([]),
  proposed_action: z.string().optional(),
  status: z.enum(["open", "resolved", "accepted_deviation", "rejected", "deferred", "duplicate", "cannot_reproduce", "reopened"])
});
```

## Validation Rules by Artifact Type

| Artifact | Valid example | Invalid example |
| --- | --- | --- |
| Task brief | Title/objective non-empty, source `manual`, references normalized | Missing objective or repository identity |
| Linear snapshot | `fetched_at`, issue ID, unavailable fields explicit | Fabricated acceptance criteria without source |
| Manual task input | User title/objective/reference list | Empty title accepted as session-ready |
| Context manifest | Sources include reason/hash/size and overflow report | Omitted files disappear without exclusion reason |
| Context source record | File source has canonical path and SHA-256 | Secret file included without policy override |
| Planning metadata | Input hashes match current task/context | Clipboard success claimed when copy failed |
| Decision record | Status, rationale, affected requirements | Decision with no author/source |
| Implementation contract | All required PRD sections present; no blocking questions | Missing tests or "N/A" without reason |
| Contract approval | Approval references exact contract hash | Approval by artifact ID only with mismatched hash |
| Contract change record | Section diff and materiality flags | Silent replacement of approved contract |
| Agent package | Approved contract hash, Git refs, rules, report schema | Package based on stale/unapproved contract |
| Execution run | Run status and adapter capability recorded | Agent prose treated as completion |
| Execution report | Derived Git facts labeled separately from agent claims | Missing head-before/head-after marked as success |
| Command result | Executable/args/cwd/exit/duration/log refs | Shell string with interpolated untrusted path |
| Check definition | Args array, timeout, required flag | Unbounded command with implicit shell |
| Check result | Git fingerprint and config version | Result reused after HEAD changed |
| Review package | Diff range, contract, checks, rubric | Stale checks labeled review-ready |
| Review report | Findings tied to review package hash | Findings imported from wrong contract as actionable |
| Finding | Severity, evidence, contract link or reason | Anonymous vague comment with no action/evidence |
| Finding disposition | Actor, disposition, reason | Auto-resolved solely from agent claim |
| Fix batch | Approved actionable findings only | Includes rejected suggestions |
| Override | Gate ID, reason, actor, scope | Override for non-overrideable security corruption |
| Completion report | Current contract/checks/findings/evidence/approval | Completion without explicit user approval |
| Session export | Manifest with all hashes | Bundle missing approved contract bytes |
| Diagnostic manifest | Preview excludes secrets and content by default | Raw token or source diff included silently |

## Markdown, JSON, Database, and Hash Relationship

1. Markdown is the human handoff. It begins with a fenced `atlas-metadata` JSON block.
2. JSON is the machine contract. When Markdown is imported, Atlas extracts or reconstructs JSON and validates it.
3. Database metadata stores artifact identity, status, hash, dependency graph, and storage URI.
4. Hashes are calculated over the canonical artifact content file, not over database rows.
5. If Markdown and JSON are both generated for the same artifact, each has its own artifact row and both depend on a shared logical parent record.

## Example Implementation Contract Markdown

````markdown
```atlas-metadata
{
  "artifact_id": "art_contract_01",
  "session_id": "ses_123",
  "type": "implementation_contract",
  "schema_version": 1,
  "content_version": 1,
  "parents": ["art_plan_01"],
  "content_sha256": "<computed-after-write>"
}
```

# Implementation Contract

## Objective
...

## In Scope
...
````

Invalid: a contract with no `Tests and Validation` section, or one with `Unresolved Questions` containing a blocking item and `Status: Approved`.
