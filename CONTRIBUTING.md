# Contributing to Sigil

Thanks for your interest in Sigil. This guide explains how to set up the project, what a good contribution looks like and how changes get reviewed.

## Ground rules

- **Keep humans in control.** Sigil exists to make AI-assisted development auditable. Changes must not remove, weaken or silently bypass an approval, review or completion gate. If a change affects a gate, say so in the pull request and explain why it is safe.
- **No secrets, ever.** Do not commit tokens, credentials, private issue or design links, or real customer data, including in tests and fixtures. Use obviously fake values such as `figd_test_secret`.
- **Be kind.** Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

Requirements: Node.js 22+, pnpm 9+ and Git.

```bash
git clone https://github.com/<your-username>/sigil.git
cd sigil
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

All tests should pass before you change anything. If they do not, open an issue with your OS, Node version and the failing output.

## Making a change

1. Find or open an issue first for anything larger than a small fix, so the approach can be agreed before you write code.
2. Create a branch from `main` with a descriptive name, for example `feat/jira-adapter` or `fix/context-budget-overflow`.
3. Keep the change focused. One pull request should do one thing.
4. Add or update tests. New behavior needs tests, and bug fixes should include a test that fails without the fix.
5. Run `pnpm check` and `pnpm test` before pushing.
6. Update the docs in `README.md` or `DOCs/` if you change commands, configuration or gates.

## Architecture rules

Sigil follows a hexagonal (ports-and-adapters) design:

- Core packages (`domain`, `workflow-engine`, `app-services`) must not import adapters or call external services directly.
- Every external system lives behind an adapter that implements the contracts in `adapter-contracts`.
- Validate data at boundaries with the schemas in `schemas` (Zod).
- Route external processes through `process-runner`, and pass anything that may contain secrets through `security` redaction before it is logged or stored.

### Adding an adapter

New adapters are one of the most useful contributions (for example Jira, GitLab or another coding agent CLI). A typical adapter:

1. Lives in its own package, `packages/adapters-<name>`.
2. Implements the relevant contract from `adapter-contracts`.
3. Reads credentials only through credential aliases, never from config values or hard-coded strings.
4. Supports a health check so `sigil adapters health` can report on it.
5. Has tests that run against fixtures, without network access or real credentials.

Look at an existing adapter such as `adapters-linear` or `adapters-github` as a reference.

## Commit messages

Use short, imperative subject lines, for example `Add Jira issue intake adapter` or `Fix token budget overflow in context build`. Explain the reason for the change in the body when it is not obvious.

## AI-assisted contributions

You may use AI tools to help write your contribution. You are responsible for every line you submit: make sure you understand it, that it is tested, and that it does not include code you are not allowed to share. Mention AI assistance in the pull request if it played a significant part.

## Review

A maintainer will review your pull request, may ask for changes, and will merge it once checks pass and the change fits the project's direction. Thank you for helping improve Sigil.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
