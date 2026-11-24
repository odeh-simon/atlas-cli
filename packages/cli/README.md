# Sigil CLI

Sigil is a local-first workflow orchestration CLI for planning, implementation, review, fix, and completion gates.

## Local Install

```sh
pnpm install
pnpm build
pnpm link --global
sigil --help
```

For development without linking:

```sh
pnpm sigil --help
```

## OpenRouter

OpenRouter is supported through the generic OpenAI-compatible provider. Store the API key under the configured alias and explicitly allow cloud code context before using AI context discovery or planning:

```sh
export OPENROUTER_API_KEY="your-token"
sigil auth add --provider ai --alias openrouter.default --value-env OPENROUTER_API_KEY
sigil ai providers health
sigil context build --ai
sigil plan --ai
```

The provider configuration is shown in `sigil.config.example.json`. `ai.allowCloudCodeContext` and `ai.allowCloudImages` are independent, deny-by-default permissions.

## Hetzner Inference

Hetzner's inference service is experimental. Register its OpenAI-compatible preset and explicitly opt in before Sigil sends repository context to it:

```sh
export HETZNER_INFERENCE_API_KEY="your-token"
sigil auth add --provider ai --alias hetzner.default --value-env HETZNER_INFERENCE_API_KEY
sigil ai providers add hetzner --token-alias hetzner.default --allow-cloud-code --allow-cloud-images
sigil ai providers health
sigil ai vision test screenshot.png --provider hetzner.default
```

Omit `--allow-cloud-code` to keep cloud context transmission blocked. Image transmission has a separate `--allow-cloud-images` consent and remains blocked by default. Vision inputs are limited to PNG, JPEG, WebP, and GIF files under `ai.maxImageBytes` (5 MB by default).

## Visual QA

Start the target application, then capture a deterministic desktop or mobile snapshot. Sigil uses an installed Edge or Chrome browser and stores the PNG as immutable session evidence.

```sh
sigil visual capture --url http://127.0.0.1:3000/dashboard --viewport desktop
sigil visual capture --url http://127.0.0.1:3000/dashboard --viewport mobile --full-page
```

Compare a reference PNG with a file or a previously captured snapshot artifact:

```sh
sigil visual compare --reference baseline.png --actual current.png
sigil visual compare --reference baseline.png --actual-artifact art_snapshot_id
```

The command returns exit code `0` when the changed-pixel ratio is within the configured allowance and `1` when it fails or dimensions differ. Use `sigil artifacts show <snapshot-or-diff-id>` to print the stored PNG path.

Import a specific Figma node as the immutable reference. The URL must contain `node-id`; Sigil uses Figma's rendered-image endpoint when a token is configured. A manually exported PNG can be attached without an API call.

```sh
export FIGMA_API_KEY="your-token"
sigil auth add --provider figma --alias figma.default --value-env FIGMA_API_KEY
sigil figma evidence "https://www.figma.com/design/FILE_KEY/Product?node-id=1-2"

# Offline/manual export alternative
sigil figma evidence "https://www.figma.com/design/FILE_KEY/Product?node-id=1-2" --image figma-export.png
```

The command prints a `visual_reference` artifact ID. Compare that reference with a captured snapshot, then ask a vision-capable provider for a structured semantic review:

```sh
sigil visual compare --reference-artifact art_reference_id --actual-artifact art_snapshot_id
sigil visual review --comparison art_comparison_id --provider hetzner.default
sigil artifacts show art_visual_review_id
```

AI visual reviews classify observable findings as blocking, important, or suggestion and record provider/model identity, evidence IDs, confidence, and cloud-image consent.

### Visual Workflow Gates

Add a `visual` check to `sigil.config.json` to run capture, comparison, and optional semantic review through `sigil checks run`:

```json
{
  "checks": [
    {
      "name": "dashboard-visual",
      "kind": "visual",
      "required": true,
      "dependsOn": ["basic-session-integrity"],
      "affected": ["app/dashboard/**", "components/**"],
      "url": "http://127.0.0.1:3000/dashboard",
      "referencePath": "test/visual/dashboard.png",
      "viewport": "desktop",
      "fullPage": false,
      "pixelThreshold": 0.1,
      "allowedDiffRatio": 0.01,
      "aiReview": {
        "providerAlias": "hetzner.default",
        "required": false,
        "failOn": ["blocking", "important"]
      }
    }
  ]
}
```

Use `figmaUrl` instead of `referencePath` to fetch a node-specific Figma PNG during each run. The target application must be running before checks begin.

```sh
sigil checks run
sigil artifacts show art_check_result_id
sigil review prepare
```

Required visual failures reject the normal check gate; optional failures are recorded without blocking the check set. `aiReview.required` controls whether an unavailable or inconclusive AI review fails the visual check, while `failOn` controls which returned severities fail it. Review packages include all visual artifacts from the latest passing check. Sigil fingerprints the visual configuration and local baseline bytes, so changing the route, viewport, tolerance, AI policy, or baseline requires rerunning checks before completion.
