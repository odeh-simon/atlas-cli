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

## Visual QA

Start the target application, then capture a deterministic desktop or mobile snapshot. Atlas uses an installed Edge or Chrome browser and stores the PNG as immutable session evidence.

```sh
atlas visual capture --url http://127.0.0.1:3000/dashboard --viewport desktop
atlas visual capture --url http://127.0.0.1:3000/dashboard --viewport mobile --full-page
```

Compare a reference PNG with a file or a previously captured snapshot artifact:

```sh
atlas visual compare --reference baseline.png --actual current.png
atlas visual compare --reference baseline.png --actual-artifact art_snapshot_id
```

The command returns exit code `0` when the changed-pixel ratio is within the configured allowance and `1` when it fails or dimensions differ. Use `atlas artifacts show <snapshot-or-diff-id>` to print the stored PNG path.

Import a specific Figma node as the immutable reference. The URL must contain `node-id`; Atlas uses Figma's rendered-image endpoint when a token is configured. A manually exported PNG can be attached without an API call.

```sh
export FIGMA_API_KEY="your-token"
atlas auth add --provider figma --alias figma.default --value-env FIGMA_API_KEY
atlas figma evidence "https://www.figma.com/design/FILE_KEY/Product?node-id=1-2"

# Offline/manual export alternative
atlas figma evidence "https://www.figma.com/design/FILE_KEY/Product?node-id=1-2" --image figma-export.png
```

The command prints a `visual_reference` artifact ID. Compare that reference with a captured snapshot, then ask a vision-capable provider for a structured semantic review:

```sh
atlas visual compare --reference-artifact art_reference_id --actual-artifact art_snapshot_id
atlas visual review --comparison art_comparison_id --provider hetzner.default
atlas artifacts show art_visual_review_id
```

AI visual reviews classify observable findings as blocking, important, or suggestion and record provider/model identity, evidence IDs, confidence, and cloud-image consent.

### Visual Workflow Gates

Add a `visual` check to `atlas.config.json` to run capture, comparison, and optional semantic review through `atlas checks run`:

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
atlas checks run
atlas artifacts show art_check_result_id
atlas review prepare
```

Required visual failures reject the normal check gate; optional failures are recorded without blocking the check set. `aiReview.required` controls whether an unavailable or inconclusive AI review fails the visual check, while `failOn` controls which returned severities fail it. Review packages include all visual artifacts from the latest passing check. Atlas fingerprints the visual configuration and local baseline bytes, so changing the route, viewport, tolerance, AI policy, or baseline requires rerunning checks before completion.
