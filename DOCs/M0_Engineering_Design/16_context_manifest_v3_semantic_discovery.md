# Context Manifest and Content Pack v3

## Production invariant

Planning and implementation may proceed only from a current, immutable v3 context manifest and its matching v3 content pack. A legacy v1/v2 manifest remains readable for diagnosis, but it cannot claim semantic completeness and must be refreshed with `atlas context build`.

The deterministic discovery engine is authoritative for repository facts. An AI scout may rerank only repository candidates that Atlas actually indexed. Unknown AI paths are retained as visible warnings and never become evidence.

## Discovery pipeline

1. Resolve the real repository root and scan only bounded, safe regular files. Do not traverse symlinks, junctions, dependency directories, build output, binaries, or secret-sensitive paths.
2. Parse the task brief and acceptance criteria into normalized terms. Score path and TypeScript symbol matches with recorded score features and stable tie-breaking.
3. Parse TS, TSX, JS, JSX, MJS, and CJS through the TypeScript compiler API. Record declared/exported symbols, imports, re-exports, resolved local-module edges, package boundaries, reverse dependents, and test associations.
4. Expand from strong task seeds in both dependency directions within configured graph bounds. Unresolved repository imports become explicit warnings or blocking gaps according to policy.
5. Discover `AGENTS.override.md` before `AGENTS.md`, at most one active file per directory, accumulated from repository root to source scope. Lowercase or alternate filenames are inactive unless listed in `instructionFallbackFilenames`.
6. Apply pins, exclusions, required globs/categories, file/byte limits, graph limits, evidence-fragment limits, and a separate instruction budget. Any required evidence omitted for safety or budget reasons blocks readiness.
7. Emit stable relations and evidence fragments bound to source URI and SHA-256 with verified 1-based line ranges. A bounded excerpt is a prefix of its cited range and carries `excerpt_truncated=true` when it does not contain the full range.

## Manifest v3 fields

In addition to the legacy source/budget/gap fields, v3 records:

- repository and Git snapshot identity, task-brief hash, discovery algorithm/version, and effective configuration hashes;
- normalized task terms and explainable seed scores;
- selected sources with category, SHA-256, score features, selection reasons, graph relation reasons, package boundary, and required/pinned flags;
- the ordered applicable instruction chain with scope, precedence, hashes, byte use, truncation, and source applicability;
- typed symbols, import/re-export/test/instruction relations, and bounded evidence fragments;
- configured pins, exclusions, required globs/categories, semantic budget use, and deterministic invalidation inputs.

The v3 content pack binds the task and manifest artifact IDs/hashes and copies the semantic instruction, symbol, relation, and fragment evidence while resolving selected repository content within a hard pack limit. Required or pinned evidence may not be silently truncated.

## Freshness and recovery

Before planning or implementation-package export, Atlas revalidates:

- current task-brief hash;
- project context configuration hash;
- repository root, branch, base fingerprint, and HEAD when Git facts exist;
- every selected source and active instruction SHA-256;
- every evidence fragment's source binding, line range, and fact excerpt.

A mismatch blocks the gate and recommends `atlas context build`. Refresh is allowed from intake, context-ready, planning, contract-draft, and contract-approved states; it returns the workflow to context-ready so downstream planning and contract evidence must be regenerated. Refresh is intentionally unavailable after implementation starts because implementation changes selected sources by design; later gates use the immutable pre-execution pack and exact diff bindings instead.

## Project configuration

`atlas.config.json` may define a strict `context` object:

```json
{
  "context": {
    "maxFiles": 40,
    "maxBytes": 200000,
    "maxScannedFiles": 2000,
    "maxGraphNodes": 500,
    "maxGraphEdges": 1500,
    "maxEvidenceFragments": 200,
    "maxExcerptBytes": 1200,
    "instructionMaxBytes": 64000,
    "graphDepth": 2,
    "pinnedSources": [],
    "exclusions": ["generated/**"],
    "requiredSourceGlobs": [],
    "requiredCategories": [],
    "instructionFallbackFilenames": [],
    "requireResolvedImports": false
  }
}
```

Unknown fields, malformed values, missing required pins/categories/globs, and unsafe required inputs fail closed. `atlas context inspect --json` exposes the effective settings and hash; the normal inspect/status output summarizes instruction coverage, semantic evidence, gaps, exclusions, and budget pressure without dumping source content.

## Current limits

The v3 graph focuses on TypeScript/JavaScript compiler relationships plus deterministic path/content classification. It does not yet build language-server graphs for other languages, framework-specific runtime call graphs, GraphQL AST graphs, or a persistent cross-session index. Project references are surfaced and imports are followed where TypeScript can resolve explicit paths/package sources; unresolved referenced-package imports remain visible gaps rather than invented edges.
