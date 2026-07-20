# Atlas CLI Install And Release Notes

## Supported Runtime

- Node.js: 22 or newer
- Package manager: pnpm 9 or newer
- Platforms covered by smoke tests: Windows shell execution and Node package bin metadata

## Local Development Install

```bash
pnpm install
pnpm build
pnpm link --global
atlas --help
atlas doctor
```

## Release Smoke Test

Run before publishing or handing Atlas to another repo:

```bash
pnpm build
pnpm test
atlas --version
atlas --help
atlas doctor
atlas ai providers health
atlas git status
```

## External Writebacks

Adapter writebacks are opt-in and audited. Use `--dry-run` to create an `adapter_writeback` artifact without sending anything externally.

```bash
atlas writebacks run --provider linear --target CLI-103 --summary "Atlas run completed." --dry-run
atlas writebacks run --provider github --target https://github.com/acme/repo/pull/12 --summary "Atlas run completed." --dry-run
atlas writebacks run --provider figma --target https://figma.com/file/example --summary "Evidence reference captured." --dry-run
```

Real Linear and GitHub writes require `--yes` and the matching stored credential alias. Figma writeback currently records evidence references only.
