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
atlas ai providers add hetzner --token-alias hetzner.default --allow-cloud-code --allow-cloud-images
atlas ai providers health
atlas ai vision test screenshot.png --provider hetzner.default
```

Omit `--allow-cloud-code` to keep cloud context transmission blocked. Image transmission has a separate `--allow-cloud-images` consent and remains blocked by default. Vision inputs are limited to PNG, JPEG, WebP, and GIF files under `ai.maxImageBytes` (5 MB by default).
