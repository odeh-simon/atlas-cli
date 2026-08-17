# Atlas CLI Install, Release, And Full-Flow Runbook

## Supported Runtime

- Node.js 22 or newer
- pnpm 9 or newer for source builds
- Git available on `PATH` for repository safeguards
- Edge or Chrome installed for browser-based visual checks
- Current automated release environment: Windows 11 and PowerShell/Git Bash

Run `node --version` and `atlas doctor` before a workflow. Doctor fails on an unsupported Node runtime, invalid local storage, malformed configuration, missing artifacts, invalid AI defaults, or an interrupted database write. Credential and disabled-cloud-consent findings are warnings.

## Development Install

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
atlas --version
atlas --help
atlas doctor
```

Run Atlas from the root of the repository and worktree it should inspect. Atlas binds sessions, Git facts, context discovery, and checks to that path.

## Portable Release

Create a self-contained archive containing the CLI and production dependencies:

```bash
nvm use 22.23.1
pnpm release:bundle
pnpm release:smoke
```

The build writes `release/atlas-cli-<version>.tgz` and a matching `.sha256` file. The smoke test verifies the checksum, extracts the archive in isolation, and runs version, help, doctor, and status commands from the extracted distribution. After extraction, use `atlas.cmd` on Windows or `./atlas` on macOS/Linux.

The complete release gate is:

```bash
pnpm release:check
```

This runs TypeScript checks, the complete automated test suite, portable bundling, checksum validation, and the isolated release smoke test.

## Required Connections

Atlas works without remote services for manual intake, deterministic context, manual agent handoff, checks, review, and completion. Configure only the connections needed for a run.

| Connection | Purpose | Credential alias | Validation |
| --- | --- | --- | --- |
| Linear | Issue intake and optional completion comment | `linear.default` | `atlas adapters health` |
| GitHub | Repository/PR inspection and optional PR comment | `github.default` | `atlas adapters health` |
| Figma | Design inspection and visual reference images | `figma.default` | `atlas adapters health` |
| OpenRouter | Cloud context scouting, planning, and supported vision models | `openrouter.default` | `atlas ai providers health` |
| Codex | Implementation agent execution | installed `codex` executable | `atlas adapters health` |
| Claude Code | Alternative implementation agent | installed `claude` executable | `atlas adapters health` |
| Edge/Chrome | Deterministic page capture | no token | `atlas visual capture` |

Store tokens through aliases rather than writing secrets into `atlas.config.json`.

Git Bash:

```bash
export LINEAR_API_KEY="..."
export GITHUB_TOKEN="..."
export FIGMA_API_KEY="..."
export OPENROUTER_API_KEY="..."

atlas auth add --provider linear --alias linear.default --value-env LINEAR_API_KEY
atlas auth add --provider github --alias github.default --value-env GITHUB_TOKEN
atlas auth add --provider figma --alias figma.default --value-env FIGMA_API_KEY
atlas auth add --provider ai --alias openrouter.default --value-env OPENROUTER_API_KEY
```

PowerShell:

```powershell
$env:LINEAR_API_KEY = "..."
$env:GITHUB_TOKEN = "..."
$env:FIGMA_API_KEY = "..."
$env:OPENROUTER_API_KEY = "..."

atlas auth add --provider linear --alias linear.default --value-env LINEAR_API_KEY
atlas auth add --provider github --alias github.default --value-env GITHUB_TOKEN
atlas auth add --provider figma --alias figma.default --value-env FIGMA_API_KEY
atlas auth add --provider ai --alias openrouter.default --value-env OPENROUTER_API_KEY
```

## OpenRouter Consent

OpenRouter uses Atlas's generic `openai-compatible` provider. Cloud transmission is denied unless consent is explicit:

```json
{
  "ai": {
    "defaultProviderAlias": "openrouter.free",
    "allowCloudCodeContext": true,
    "allowCloudImages": false,
    "providers": [
      {
        "alias": "openrouter.free",
        "provider": "openai-compatible",
        "baseUrl": "https://openrouter.ai/api/v1",
        "model": "openrouter/free",
        "tokenAlias": "openrouter.default",
        "timeoutMs": 120000,
        "maxInputTokens": 12000
      }
    ]
  }
}
```

Set `allowCloudCodeContext` to `true` only when repository snippets may be sent to the configured provider. Set `allowCloudImages` independently when visual evidence may be sent. Secrets, excluded paths, and redacted values remain subject to Atlas's deterministic safeguards.

## Full Workflow Test

Run these commands from the target repository and branch:

```bash
atlas doctor
atlas git status
atlas git preflight --base <expected-base> --allow-dirty
atlas adapters health
atlas ai providers health

atlas start <LINEAR-ISSUE-KEY>
atlas context build --ai --max-files 80 --max-bytes 400000
atlas context inspect --included
atlas plan --ai
atlas artifacts show <AI-PLANNING-DRAFT-ID>

atlas contract import <approved-contract.json>
atlas approve contract --yes
atlas implement --agent codex
atlas checks run
atlas review prepare
atlas review import <review-report.json>
atlas complete --check
atlas approve completion --yes
atlas status
```

Use `atlas implement export --manual` and `atlas execution import <report.json>` when no coding-agent executable is connected. If review returns blocking findings, run `atlas fix prepare`, invoke/import the fix implementation, rerun checks, and repeat review. `atlas orchestrate run --until completion-ready` automates deterministic transitions but still stops at contract approval or any review step that needs an external decision.

For visual gates, start the target application before `atlas checks run`. A configured visual check captures the route, compares it with a local PNG or Figma node, optionally requests AI visual review, and attaches evidence to the review package.

## External Writebacks

Writebacks are opt-in and audited. Preview them first:

```bash
atlas writebacks run --provider linear --target CLI-103 --summary "Atlas run completed." --dry-run
atlas writebacks run --provider github --target https://github.com/acme/repo/pull/12 --summary "Atlas run completed." --dry-run
atlas writebacks run --provider figma --target https://figma.com/file/example --summary "Evidence reference captured." --dry-run
```

Real Linear and GitHub writes require `writebacks.enabled: true`, `--yes`, and the matching credential. Figma writeback records an evidence reference; it does not mutate the Figma file.

## Recovery

`atlas doctor` is read-only for repository files and artifact content. If it reports `storage.interrupted_write`, Atlas deliberately does not open the database or delete the sidecar. Preserve `atlas.db`, `atlas.db.tmp`, `atlas.db.failed`, and the `backups` directory before recovery. Artifact hash failures must be resolved before completion approval.

## Release Acceptance

Automated acceptance covers the complete manual CLI flow, migration rollback, artifact integrity, Git safeguards, agent and provider mocks, checks, visual evidence, review/fix orchestration, completion gates, dry-run writebacks, and portable archive execution. Before a public production release, also run live-provider smoke tests in a disposable repository and execute the release matrix on Windows, macOS, and Linux with scoped test credentials.
