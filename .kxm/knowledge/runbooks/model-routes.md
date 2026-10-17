---
title: Add or retire a model route
summary: Admit a route onto a roster, or retire one so workforce lint stays clean.
tags: [runbook, routing, models]
updated: "2026-10-17"
sources:
  - .kxm/routes.yaml
  - .kxm/roles/writer.yaml
  - .kxm/models/pi-qwen3-coder-plus-openrouter.yaml
  - .kxm/README.md
  - docs/reference/cli-reference.md
  - docs/reference/harness-routing.md
  - docs/contributing/harness-routing-internals.md
  - plugins/kxm/src/workforce-names.mjs
---

# Add or retire a model route

Admission is a reviewed Git change. A route that is not under `admitted` in `.kxm/routes.yaml` is refused at dispatch with `producer_route_not_admitted`. The current roster decisions are on [Harness routing and rosters](../decisions/harness-routing.md).

## Add a route

1. Add `.kxm/models/<route-id>.yaml` with `schema: kxm.model.v2`. The id is `<harness>-<model-slug>`, with `.` written as `-` (`.kxm/README.md`). Set `harness`, `model`, `vendor`, `status: admitted`, and `permissions`. The harness must be one that can run that model (`docs/reference/harness-routing.md`).
2. Put the selector under `admitted` in `.kxm/routes.yaml` and set `updatedAt`. `kxm routes admit --model <id>` writes that file when the id is in `.kxm/models/inventory.yaml`. If the inventory never carries the selector, the command exits 2 with `select a model from the refreshed inventory`. Admit those selectors by editing `.kxm/routes.yaml` (`docs/contributing/harness-routing-internals.md`).
3. Append `{route: <route-id>, effort: ...}` to the role file under `.kxm/roles/`. Order is the rotation. `kxm role` can append a binding when a `kxm.model.v2` file matches the inventory id.
4. Add a `.kxm/prices.yaml` row when list estimates should resolve, then update `date` and `sha256`. The loader refuses a hash mismatch. The weekly refresh rewrites single-tier OpenRouter rows. See [Model catalog refresh](../decisions/model-catalog-refresh.md).
5. Run `node scripts/workforce-lint.mjs`. An admitted model file that no roster names is a warning. A retired id that is still on a roster is an error (`route_not_admitted`).

`kxm trust diff` does not read `routes.yaml`, role files, or `prices.yaml`. Review those diffs by hand (`docs/reference/cli-reference.md`).

## Retire a route

The pattern from `openrouter/qwen/qwen3-coder-plus` in [PR #403](https://github.com/kontextmind/kxm/pull/403):

1. Set `status: retired` on the model file. Leave the file so the old id still has a definition. `.kxm/models/pi-qwen3-coder-plus-openrouter.yaml` is the example.
2. Remove the selector from `admitted`. A comment in `.kxm/routes.yaml` may record why. The `prices.yaml` row can stay. The coder-plus comment says the prices row stays.
3. Remove the route from every `.kxm/roles/*.yaml` roster. Workforce lint errors with `retired route '<id>' is still on a role roster` if it remains.
4. Do not point the old alias at the replacement. `qwen-openrouter-pi` is not an alias of `pi-qwen3-7-plus-openrouter`. A roster or step that still cites a deprecated id is a `deprecated_id` warning. Alias declarations themselves are not uses (`plugins/kxm/src/workforce-names.mjs`).
5. If OpenRouter drops an id that a route or roster still names, the Monday refresh keeps the inventory row, sets `missingUpstream: true`, and fails `model-catalog-guard`. Retire the reference or restore the model. Do not delete that inventory row to silence the guard while the roster still names it.

`kxm routes disable --model <id>` moves an inventory id to `disabled`. That blocks dispatch. It is not the same as `status: retired` on the model file. A disabled selector is still a reference for the catalog guard.
