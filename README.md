# Atlas CLI

**Auditable, human-gated orchestration for AI-assisted software development.**

Atlas is a local-first command-line tool that coordinates the work around AI coding agents: issue intake, context selection, planning, implementation contracts, agent runs, checks, review and completion. It connects Linear, Git, GitHub, Figma, Claude Code and Codex, and keeps one durable, resumable session per task built from versioned artifacts.

Atlas is not an autonomous agent swarm. A human approves every material decision, and every claim Atlas makes about the code can be traced back to evidence in the repository.

> **Status:** pre-release (`0.0.0`). Atlas is under active development, interfaces may change, and it has not had a public release yet. Feedback and contributions are welcome.

## Why Atlas

Engineers who use several AI tools spend a lot of time copying context between issue trackers, planning chats, coding agents and review sessions, and it gets easy to lose track of which plan was approved and which code is actually being reviewed. Atlas replaces that with a single auditable workflow:

- **Explainable, deterministic context.** Context is selected from repository evidence: TypeScript symbols, module relationships and test-to-code links, within token budgets. Every input is hash-verified. AI may re-rank candidates but cannot invent facts.
- **Human-approved contracts.** Implementation starts only after a person approves an explicit contract for the task.
- **Immutable diffs and independent review.** Each agent run produces an immutable diff. Findings are tracked and fixed in a loop, and completion requires a fresh, independent review against the current contract, diff, checks and Git state.
- **Provider-neutral AI.** Works with Ollama, any OpenAI-compatible API and vision-capable models.
- **Visual QA.** Captures pages with Playwright, compares them pixel by pixel, runs AI visual review and pulls design references from Figma.
- **Safe by default.** Secret redaction, Git branch and freshness safeguards, credential aliases instead of raw tokens, audited agent invocations and a recovery `doctor` command.

## Requirements

- Node.js 22 or newer
- pnpm 9 or newer
- Git on your `PATH`
- Optional, depending on what you use: Edge or Chrome (visual capture), the `codex` or `claude` CLI (agent execution), and tokens for Linear, GitHub, Figma or an AI provider

## Quick start (from source)

```bash
git clone https://github.com/odeh-simon/atlas-cli.git
cd atlas-cli
pnpm install --frozen-lockfile
pnpm build
pnpm link --global

atlas --version
atlas doctor
```

Copy the example configuration and adjust it for your project:

```bash
cp atlas.config.example.json atlas.config.json
```

`atlas.config.json` is ignored by Git. Never put tokens in it; register them as aliases instead:

```bash
export LINEAR_API_KEY="..."
atlas auth add --provider linear --alias linear.default --value-env LINEAR_API_KEY
atlas adapters health
```

Atlas works without any remote service for manual intake, deterministic context, manual agent handoff, checks, review and completion. Configure only the connections a run needs.

| Connection | Used for | Credential |
| --- | --- | --- |
| Linear | Issue intake, optional completion comment | alias, e.g. `linear.default` |
| GitHub | Repository and PR inspection, optional PR comment | alias, e.g. `github.default` |
| Figma | Design inspection and visual reference images | alias, e.g. `figma.default` |
| AI provider | Context re-ranking, planning, vision | alias, e.g. `openrouter.default` |
| Codex / Claude Code | Implementation agent | installed `codex` or `claude` executable |
| Edge / Chrome | Page capture for visual checks | none |

## A typical run

```bash
atlas git preflight --base main
atlas start <ISSUE-KEY>                 # or: atlas start --manual --title "..." --objective "..."
atlas context build --max-files 80
atlas context inspect --included
atlas plan --ai
atlas contract import approved-contract.json
atlas approve contract --yes            # human gate
atlas implement --agent codex           # or --agent claude
atlas checks run
atlas review prepare
atlas review import review-report.json
atlas complete --check
atlas approve completion --yes          # human gate
atlas status
```

Writebacks to Linear, GitHub or Figma are opt-in and support `--dry-run`. See [`DOCs/Atlas_CLI_Install_and_Release.md`](DOCs/Atlas_CLI_Install_and_Release.md) for the full runbook, recovery steps and release process.

## Architecture

Atlas uses a hexagonal (ports-and-adapters) design in a pnpm monorepo of 25 TypeScript packages. The core never talks to an external system directly; each system has its own adapter behind a shared adapter-contract layer.

| Area | Packages |
| --- | --- |
| Core | `domain`, `workflow-engine`, `app-services`, `schemas`, `config` |
| Evidence and context | `artifacts`, `context-discovery`, `evidence-index`, `persistence` |
| Quality | `checks`, `visual-qa`, `diagnostics` |
| Infrastructure | `process-runner`, `security`, `git`, `llm` |
| Adapters | `adapter-contracts`, `adapters-linear`, `adapters-github`, `adapters-figma`, `adapters-codex`, `adapters-claude-code`, `adapters-os` |
| Entry point | `cli` |

Design documents live in [`DOCs/`](DOCs/): the product requirements document plus engineering specs covering architecture decisions, the workflow state machine, persistence, schema and adapter contracts, the security threat model, testing strategy, and evidence and review gates.

## Development

```bash
pnpm check           # TypeScript project build
pnpm test            # full Vitest suite
pnpm release:check   # check, test, bundle and smoke-test a portable release
```

## How Atlas was built

Atlas was designed by its author, who wrote the requirements, architecture and design specs and directed the implementation. AI coding agents (Codex and Claude Code) helped write much of the code, under that direction and through the same contract, check and review discipline Atlas itself enforces.

## Contributing

Contributions are welcome, especially new adapters, platform testing and documentation. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Simon Odeh
