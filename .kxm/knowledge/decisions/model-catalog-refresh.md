---
title: Model catalog refresh
summary: Monday OpenRouter refresh of prices and inventory, the manual command, and the disappearance guard.
tags: [models, prices, inventory, ci]
updated: "2026-10-17"
sources:
  - .github/workflows/refresh-models.yml
  - scripts/refresh-model-catalog.mjs
  - plugins/kxm/src/model-catalog-refresh.ts
  - docs/reference/config-reference.md
  - docs/reference/harness-routing.md
  - docs/contributing/development.md
  - docs/reference/cli-reference.md
---

# Model catalog refresh

[PR #404](https://github.com/kontextmind/kxm/pull/404) added a weekly OpenRouter refresh so `.kxm/prices.yaml` and `.kxm/models/inventory.yaml` do not drift without a reviewed diff. The workflow is `.github/workflows/refresh-models.yml`.

## Schedule and token

The workflow runs at `0 13 * * 1` (Monday 13:00 UTC) and on `workflow_dispatch`. It checks out `main`, installs locked dependencies with `npm ci --ignore-scripts`, and runs `scripts/refresh-model-catalog.mjs`. Permissions are `contents`, `pull-requests`, `statuses`, and `actions` write. The only token is `GITHUB_TOKEN`.

An empty diff exits 0 and opens nothing. A non-empty diff is committed by `kxm-catalog[bot]` onto the fixed branch `automation/model-refresh` and force-with-lease pushed. The job opens or updates one pull request against `main`. Because a `GITHUB_TOKEN` push does not start pull-request CI, the job then dispatches `ci.yml` on that branch.

## What the refresh rewrites

The script fetches `https://openrouter.ai/api/v1/models` and updates the OpenRouter `standard` slice of the inventory plus matching single-tier rows in `.kxm/prices.yaml`. Sort order is stable. `prices.yaml` `date` and the inventory `fetchedAt` (midnight UTC of that date) change only when the catalog content changes. Float noise below a relative `1e-8` is not a rewrite (`plugins/kxm/src/model-catalog-refresh.ts`).

Nous `discount` rates and the `pi`, `grok`, and `agy` source blocks stay as the last full `kxm models inventory-refresh` left them. An empty OpenRouter payload throws `OpenRouter catalog is empty` and writes nothing.

Multi-tier price rows are not rewritten. `anthropic/fable` is matched through its aliases; when those OpenRouter rows disagree, the price row is left unchanged. A YAML anchor shared with a plan-price alias still moves when the OpenRouter owner row does.

## Guard

A model named by `.kxm/routes.yaml` (`admitted` or `disabled`) or by a roster `route:` is not deleted when it leaves OpenRouter. The previous inventory row stays, `missingUpstream` is set to `true`, and `guardFailed` is true when any such row was retained. The workflow posts a commit status `model-catalog-guard`: `failure` with description "A referenced model disappeared from OpenRouter", or `success` with "Referenced models are still in the catalog". The job then exits 1. A later run that finds the same already-marked row and no other change is a clean no-op.

Exit codes from the script, as the workflow treats them:

| Code | Meaning |
|---|---|
| 0 | Refresh finished and no referenced model disappeared |
| 2 | A referenced model was kept after leaving the catalog (`guardFailed`) |
| other | The workflow fails before it opens a pull request |

A referenced model whose input, output, cache-read, or cache-write rate moves by more than 20 percent (`ratio > 0.2`) is listed at the top of the pull request summary. Exactly 20 percent is not flagged. An infinite ratio (a rate appearing or disappearing) is flagged only for input and output (`isSignificant` in `plugins/kxm/src/model-catalog-refresh.ts`). That listing does not by itself set `guardFailed`. The summary also lists tiered rows that were left unchanged.

## Manual run

From the repository root (`docs/contributing/development.md`):

```bash
node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/refresh-model-catalog.mjs --dry-run
node --disable-warning=ExperimentalWarning --experimental-strip-types scripts/refresh-model-catalog.mjs
```

`--dry-run` prints the summary and writes nothing. Optional flags are `--date YYYY-MM-DD`, `--json`, and `--openrouter-file <path>` (`scripts/refresh-model-catalog.mjs`).

`kxm models inventory-refresh` (alias `kxm models refresh`) is the other command. It rewrites the whole inventory from `pi --list-models`, `grok models`, `agy models`, OpenRouter, and Nous, and it stamps `fetchedAt` to the current clock even when you only wanted a price check. It does not update `.kxm/prices.yaml`. `--dry-run` writes nothing. Exit 1 when any source failed (`docs/reference/cli-reference.md`).

`kxm prices acknowledge` stamps the existing `.kxm/prices.yaml` list as today's estimate. It does not fetch vendor rates.
