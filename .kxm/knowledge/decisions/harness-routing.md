---
title: Harness routing and rosters
summary: Writer, planner, CLI-reviewer, and architecture-reviewer rosters as of the 2026-10-20 planner fallback.
tags: [routing, roster, writer, reviewer, planner]
updated: "2026-10-20"
sources:
  - .kxm/roles/writer.yaml
  - .kxm/roles/reviewer-cli.yaml
  - .kxm/roles/reviewer-arch.yaml
  - .kxm/roles/planner.yaml
  - .kxm/routes.yaml
  - .kxm/models/grok-grok-4-7.yaml
  - .kxm/models/pi-qwen3-7-plus-openrouter.yaml
  - .kxm/models/pi-qwen3-coder-plus-openrouter.yaml
  - .kxm/models/agy-gemini-4-argon-high.yaml
  - .kxm/models/agy-gemini-4-argon-medium.yaml
  - .kxm/models/agy-gemini-3-8-flash-medium.yaml
  - .kxm/models/agy-gemini-3-8-flash-high.yaml
  - .kxm/models/codex-gpt-6-1-sol.yaml
  - .kxm/models/codex-gpt-5-6-sol.yaml
  - .kxm/models/pi-qwen3-8-flash-openrouter.yaml
  - .kxm/models/claude-fable.yaml
  - .kxm/models/claude-claude-sonnet-5-5.yaml
  - .kxm/models/pi-glm-5-3-flash-openrouter.yaml
  - docs/reference/harness-routing.md
  - docs/evals/planner-bakeoff-2026-10.md
  - plugins/kxm/src/workforce-names.mjs
---

# Harness routing and rosters

A live step walks the role roster in order and uses the first admitted route whose model file is readable. The selector must be under `admitted` in `.kxm/routes.yaml` and not under `disabled`. A missing model file is a refusal, not a skip. Native harness first, and do not bill one vendor through another harness. Aggregators are Pi providers. The procedure is `docs/reference/harness-routing.md`.

Route ids are `<harness>-<model-slug>`, with `.` written as `-`. Selectors in `.kxm/routes.yaml` are `<vendor>/<model>` or `openrouter/<vendor>/<model>`.

Pull requests that set the current rosters:

- [PR #401](https://github.com/kontextmind/kxm/pull/401) admitted Gemini 4 Argon on the agy writer roster.
- [PR #402](https://github.com/kontextmind/kxm/pull/402) made Codex GPT-6.1 Sol the CLI reviewer.
- [PR #403](https://github.com/kontextmind/kxm/pull/403) replaced the retired Qwen coder route with Qwen3.7 Plus.
- [PR #404](https://github.com/kontextmind/kxm/pull/404) added the weekly OpenRouter catalog refresh. Roster membership did not change in that pull request. See [Model catalog refresh](model-catalog-refresh.md).

## Writer

From `.kxm/roles/writer.yaml`. Permission is `edit`. Effort on every entry is `medium`.

| Order | Route | File |
|---|---|---|
| 1 | `grok-grok-4-7` | `.kxm/models/grok-grok-4-7.yaml` |
| 2 | `pi-qwen3-7-plus-openrouter` | `.kxm/models/pi-qwen3-7-plus-openrouter.yaml` |
| 3 | `agy-gemini-4-argon-high` | `.kxm/models/agy-gemini-4-argon-high.yaml` |
| 4 | `agy-gemini-4-argon-medium` | `.kxm/models/agy-gemini-4-argon-medium.yaml` |
| 5 | `agy-gemini-3-8-flash-medium` | `.kxm/models/agy-gemini-3-8-flash-medium.yaml` |
| 6 | `agy-gemini-3-8-flash-high` | `.kxm/models/agy-gemini-3-8-flash-high.yaml` |

`grok-grok-4-7` is harness `grok`, model `grok-4.7`, vendor `xai`, status `admitted`. Alias `grok-native`.

`pi-qwen3-7-plus-openrouter` is harness `pi`, model `openrouter/qwen/qwen3.7-plus`, vendor `alibaba`. [PR #403](https://github.com/kontextmind/kxm/pull/403) replaced writer 2 because OpenRouter no longer lists `qwen/qwen3-coder-plus` (catalog 404). `.kxm/routes.yaml` admits `openrouter/qwen/qwen3.7-plus`. The old file `.kxm/models/pi-qwen3-coder-plus-openrouter.yaml` stays with `status: retired` and is on no roster. The alias `qwen-openrouter-pi` does not resolve to the new id (`docs/reference/harness-routing.md`).

Argon is harness `agy`, vendor `google`. `agy-gemini-4-argon-high` is the alias target of `gemini-agy`. The role comment says Argon needs a paid Google AI Pro, Ultra, or Enterprise plan, and `agy -p` exits when a pinned model is unavailable, so Flash medium stays as the safety net. Flash high stays last so that admitted model file remains on a roster. Workforce lint fails an admitted model file that no roster names (`plugins/kxm/src/workforce-names.mjs`).

`.kxm/routes.yaml` admits `google/gemini-4-argon-high`, `google/gemini-4-argon-medium`, `google/gemini-3.8-flash-high`, and `google/gemini-3.8-flash-medium`. The same routing page notes that the written Google rule names the `antigravity` Pi provider, while a `google/gemini-…` selector on this checkout still runs through `agy`.

## reviewer-cli

From `.kxm/roles/reviewer-cli.yaml`. Permission is `read-only`. Effort on every entry is `low`.

| Order | Route | File |
|---|---|---|
| 1 | `codex-gpt-6-1-sol` | `.kxm/models/codex-gpt-6-1-sol.yaml` |
| 2 | `pi-qwen3-8-flash-openrouter` | `.kxm/models/pi-qwen3-8-flash-openrouter.yaml` |
| 3 | `codex-gpt-5-6-sol` | `.kxm/models/codex-gpt-5-6-sol.yaml` |

[PR #402](https://github.com/kontextmind/kxm/pull/402) switched the primary from Codex GPT-5.6 Sol to GPT-6.1 Sol. `codex-gpt-6-1-sol` is harness `codex`, model `gpt-6.1-sol`, vendor `openai`. The Pi fallback is a different vendor: `openrouter/qwen/qwen3.8-flash`. `codex-gpt-5-6-sol` stays admitted as the last fallback (alias `sol-codex`).

Pro is not a separate route. It is `gpt-6.1-sol` with reasoning mode `pro`. OpenRouter lists that mode as `openai/gpt-6.1-sol-pro` at the same per-token price. Role `effort` has no `pro` value, and the codex harness ceiling is `reviewer-cli` only (`docs/reference/harness-routing.md`).

## reviewer-arch

From `.kxm/roles/reviewer-arch.yaml`. Permission is `read-only`. Effort is `medium`.

| Order | Route | File |
|---|---|---|
| 1 | `claude-fable` | `.kxm/models/claude-fable.yaml` |
| 2 | `pi-glm-5-3-flash-openrouter` | `.kxm/models/pi-glm-5-3-flash-openrouter.yaml` |

`claude-fable` is harness `claude`, model `fable`, vendor `anthropic`. Aliases include `fable-claude`. The fallback is a different vendor: harness `pi`, model `openrouter/z-ai/glm-5.3-flash`. `.kxm/routes.yaml` admits `anthropic/fable` and `openrouter/z-ai/glm-5.3-flash`.

## Planner

From `.kxm/roles/planner.yaml`. Permission is `read-only`. Effort on every entry is `medium`.

| Order | Route | File |
|---|---|---|
| 1 | `claude-fable` | `.kxm/models/claude-fable.yaml` |
| 2 | `claude-claude-sonnet-5-5` | `.kxm/models/claude-claude-sonnet-5-5.yaml` |
| 3 | `pi-qwen3-8-flash-openrouter` | `.kxm/models/pi-qwen3-8-flash-openrouter.yaml` |

`claude-fable` stays the primary. [PR #401](https://github.com/kontextmind/kxm/pull/401) left that primary unchanged. `claude-claude-sonnet-5-5` is harness `claude`, model `claude-sonnet-5.5`, vendor `anthropic`. `.kxm/routes.yaml` admits `anthropic/claude-sonnet-5.5`. It is the same-vendor fallback, placed immediately after Fable. `pi-qwen3-8-flash-openrouter` stays the other-vendor fallback. Argon is not on this roster.

The [October 2026 planner bake-off](../../../docs/evals/planner-bakeoff-2026-10.md) scored Sonnet 5.5 at 126 and Fable at 110 out of 150. Sonnet won four of six tasks. List price is about one fifth of Fable ($2 / $10 versus $10 / $50 per 1M tokens). That sample kept Fable as primary and is the reason Sonnet is the fallback. OpenRouter's live catalog on 2026-10-20 listed `anthropic/claude-sonnet-5.5` at those rates (cache read $0.10, cache write $2.50). The `.kxm/prices.yaml` row uses that standard tier.
