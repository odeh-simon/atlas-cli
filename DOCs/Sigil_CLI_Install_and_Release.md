# Sigil CLI Install, Release, And Full-Flow Runbook

## Supported Runtime

- Node.js 22 or newer
- pnpm 9 or newer for source builds
- Git available on `PATH` for repository safeguards
- Edge or Chrome installed for browser-based visual checks
- Current automated release environment: Windows 11 and PowerShell/Git Bash

Run `node --version` and `sigil doctor` before a workflow. Doctor fails on an unsupported Node runtime, invalid local storage, malformed configuration, missing artifacts, invalid AI defaults, or an interrupted database write. Credential and disabled-cloud-consent findings are warnings.

## Development Install

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
sigil --version
sigil --help
sigil doctor
```

Run Sigil from the root of the repository and worktree it should inspect. Sigil binds sessions, Git facts, context discovery, and checks to that path.

## Portable Release

Create a self-contained archive containing the CLI and production dependencies:

```bash
nvm use 22.23.1
pnpm release:bundle
pnpm release:smoke
```

The build writes `release/sigil-cli-<version>.tgz` and a matching `.sha256` file. The smoke test verifies the checksum, extracts the archive in isolation, and runs version, help, doctor, and status commands from the extracted distribution. After extraction, use `sigil.cmd` on Windows or `./sigil` on macOS/Linux.

The complete release gate is:

```bash
pnpm release:check
```

This runs TypeScript checks, the complete automated test suite, portable bundling, checksum validation, and the isolated release smoke test.

## Required Connections

Sigil works without remote services for manual intake, deterministic context, manual agent handoff, checks, review, and completion. Configure only the connections needed for a run.

| Connection | Purpose | Credential alias | Validation |
| --- | --- | --- | --- |
| Linear | Issue intake and optional completion comment | `linear.default` | `sigil adapters health` |
| GitHub | Repository/PR inspection and optional PR comment | `github.default` | `sigil adapters health` |
| Figma | Design inspection and visual reference images | `figma.default` | `sigil adapters health` |
| OpenRouter | Cloud context scouting, planning, and supported vision models | `openrouter.default` | `sigil ai providers health` |
| Codex | Implementation agent execution | installed `codex` executable | `sigil adapters health` |
| Claude Code | Alternative implementation agent | installed `claude` executable | `sigil adapters health` |
| Edge/Chrome | Deterministic page capture | no token | `sigil visual capture` |

Store tokens through aliases rather than writing secrets into `sigil.config.json`.

Git Bash:

```bash
export LINEAR_API_KEY="..."
export GITHUB_TOKEN="..."
export FIGMA_API_KEY="..."
export OPENROUTER_API_KEY="..."

sigil auth add --provider linear --alias linear.default --value-env LINEAR_API_KEY
sigil auth add --provider github --alias github.default --value-env GITHUB_TOKEN
sigil auth add --provider figma --alias figma.default --value-env FIGMA_API_KEY
sigil auth add --provider ai --alias openrouter.default --value-env OPENROUTER_API_KEY
```

PowerShell:

```powershell
$env:LINEAR_API_KEY = "..."
$env:GITHUB_TOKEN = "..."
$env:FIGMA_API_KEY = "..."
$env:OPENROUTER_API_KEY = "..."

sigil auth add --provider linear --alias linear.default --value-env LINEAR_API_KEY
sigil auth add --provider github --alias github.default --value-env GITHUB_TOKEN
sigil auth add --provider figma --alias figma.default --value-env FIGMA_API_KEY
sigil auth add --provider ai --alias openrouter.default --value-env OPENROUTER_API_KEY
```

## OpenRouter Consent

OpenRouter uses Sigil's generic `openai-compatible` provider. Cloud transmission is denied unless consent is explicit:

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

Set `allowCloudCodeContext` to `true` only when repository snippets may be sent to the configured provider. Set `allowCloudImages` independently when visual evidence may be sent. Secrets, excluded paths, and redacted values remain subject to Sigil's deterministic safeguards.

## Full Workflow Test

Run these commands from the target repository and branch:

```bash
sigil doctor
sigil git status
sigil git preflight --base <expected-base> --allow-dirty
sigil adapters health
sigil ai providers health

sigil start <LINEAR-ISSUE-KEY>
sigil context build --ai --max-files 80 --max-bytes 400000
sigil context inspect --included
sigil plan --ai
sigil artifacts show <AI-PLANNING-DRAFT-ID>

sigil contract import <approved-contract.json>
sigil approve contract --yes
sigil implement --agent codex
sigil checks run
sigil review prepare
sigil review import <review-report.json>
sigil complete --check
sigil approve completion --yes
sigil status
```

Use `sigil implement export --manual` and `sigil execution import <report.json>` when no coding-agent executable is connected. If review returns blocking findings, run `sigil fix prepare`, invoke/import the fix implementation, rerun checks, and repeat review. `sigil orchestrate run --until completion-ready` automates deterministic transitions but still stops at contract approval or any review step that needs an external decision.

For visual gates, start the target application before `sigil checks run`. A configured visual check captures the route, compares it with a local PNG or Figma node, optionally requests AI visual review, and attaches evidence to the review package.

## External Writebacks

Writebacks are opt-in and audited. Preview them first:

```bash
sigil writebacks run --provider linear --target CLI-103 --summary "Sigil run completed." --dry-run
sigil writebacks run --provider github --target https://github.com/acme/repo/pull/12 --summary "Sigil run completed." --dry-run
sigil writebacks run --provider figma --target https://figma.com/file/example --summary "Evidence reference captured." --dry-run
```

Real Linear and GitHub writes require `writebacks.enabled: true`, `--yes`, and the matching credential. Figma writeback records an evidence reference; it does not mutate the Figma file.

## Recovery

`sigil doctor` is read-only for repository files and artifact content. If it reports `storage.interrupted_write`, Sigil deliberately does not open the database or delete the sidecar. Preserve `sigil.db`, `sigil.db.tmp`, `sigil.db.failed`, and the `backups` directory before recovery. Artifact hash failures must be resolved before completion approval.

## Release Acceptance

Automated acceptance covers the complete manual CLI flow, migration rollback, artifact integrity, Git safeguards, agent and provider mocks, checks, visual evidence, review/fix orchestration, completion gates, dry-run writebacks, and portable archive execution. Before a public production release, also run live-provider smoke tests in a disposable repository and execute the release matrix on Windows, macOS, and Linux with scoped test credentials.
