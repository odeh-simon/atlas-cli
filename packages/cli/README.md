# Atlas CLI

Atlas is a local-first workflow orchestration CLI for planning, implementation, review, fix, and completion gates.

## Local Install

```sh
pnpm install
pnpm build
pnpm link --global
atlas --help
```

For development without linking:

```sh
pnpm atlas --help
```

## Hetzner Inference

Hetzner's inference service is experimental. Register its OpenAI-compatible preset and explicitly opt in before Atlas sends repository context to it:

```sh
export HETZNER_INFERENCE_API_KEY="your-token"
atlas auth add --provider ai --alias hetzner.default --value-env HETZNER_INFERENCE_API_KEY
atlas ai providers add hetzner --token-alias hetzner.default --allow-cloud-code
atlas ai providers health
```

Omit `--allow-cloud-code` to keep cloud context transmission blocked. Image transmission has a separate `ai.allowCloudImages` setting and remains blocked by default.
