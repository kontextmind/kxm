# Harness routing internals

This page records how the KXM repository applies [harness routing](../reference/harness-routing.md) to its own work: the routes this checkout admits, its writer roster, its price catalog, and the developer roster policy that `just assign` and the dev helper enforce. It is maintainer material. The snapshots were captured on 2026-09-23 on one operator machine, from a source checkout where `node scripts/kxm.mjs` is the same program as `kxm`; they change whenever an admission changes.

> [!IMPORTANT]
> The files are the authority, not this page: `.kxm/routes.yaml`, `.kxm/roles/`, `.kxm/roster.yaml` and `.kxm/prices.yaml`. Product routing decisions are recorded under Tracking → Decided in `plans/implementation-plan.md`.

## This checkout's routes and roster

`node scripts/kxm.mjs role get writer`:

```text
schema: kxm.role.v2
id: writer
description: ""
skills: []
roster:
  - model: xai/grok-4.6
    effort: medium
    enabled: true
  - model: openrouter/qwen/qwen3-coder-plus
    effort: medium
    enabled: true
  - model: zai-coding-cn/glm-5.3-flash
    effort: medium
    enabled: true
  - model: qwen-token-plan/qwen3.8-flash
    effort: medium
    enabled: true
  - model: google/gemini-3.8-flash-high
    enabled: true
```

The implementer agent declares `harness: grok`, so of this roster only `xai/grok-4.6` can run under it; the Pi selectors need an agent without `harness:`.

`node scripts/kxm.mjs routes list`:

```text
admitted anthropic/fable
admitted google/gemini-3.8-flash-high
admitted google/gemini-3.8-flash-medium
admitted openai/gpt-5.6-sol
admitted openrouter/qwen/qwen3-coder-plus
admitted openrouter/qwen/qwen3.8-flash
admitted openrouter/z-ai/glm-5.3-flash
admitted qwen-token-plan/deepseek-v4.1-flash
admitted qwen-token-plan/qwen3.8-flash
admitted qwen-token-plan/qwen3.8-max
admitted xai/grok-4.6
admitted zai-coding-cn/glm-5.3
admitted zai-coding-cn/glm-5.3-flash
```

`routes admit --model openrouter/qwen/qwen3-coder-plus --dry-run` exits 2 with `select a model from the refreshed inventory` even though that selector is already admitted, because the inventory never carries `openrouter/…` selectors. Selectors like these are admitted by a Git-reviewed edit of `.kxm/routes.yaml`.

On the capture machine, `kxm harness list` showed `claude` detected but logged out (`dispatch no (not_authenticated)`), `deepseek` not installed, and `grok`, `codex`, `kimi` and `agy` ready.

### Price catalog and inventory

`.kxm/prices.yaml` is dated `2026-09-16`, so every current run records `providerMetadata.priceCatalogStale: true` and no list estimate. The list prices below come from `.kxm/models/inventory.yaml`, fetched `2026-09-16T14:54:53Z`, in USD per 1M tokens. The checkout has no routing records yet, so none of the examples has recorded latency; for latency, run a bounded side-by-side experiment and compare p50 and p95 in `kxm routing report`.

## The developer roster (`.kxm/roster.yaml`)

The issue-127 runner (`just assign`, see the [assignment runner](assignment-runner.md)) uses its own policy file, [`kxm.developer-roster.v1`](../reference/config-reference.md#kxmrosteryaml-kxmdeveloper-rosterv1). Routes there name the harness, the model and the vendor explicitly:

```yaml
  grok-native:
    harness: grok
    model: grok-4.6
    vendor: xai
  qwen-openrouter-pi:
    harness: pi
    model: openrouter/qwen/qwen3-coder-plus
    vendor: alibaba
```

The developer roster policy (`scripts/roster-policy.mjs`) applies these rules:

- A native route uses a bare model id.
- A Pi route needs an allowlisted prefix: `openrouter`, `nous-portal` or `antigravity` (`scripts/harness-run.mjs`).
- An aggregator id needs at least three segments.
- The vendor segment of an aggregator id must not be a native vendor. `x-ai` counts as `xai` and `moonshotai` counts as `moonshot`.
- `antigravity` ids must be exactly `antigravity/gemini-…`.
- The writer and both critics must be three different vendors.

Vendor independence has a consequence for Anthropic: the architecture critic is an Anthropic model, so no Anthropic route can be the writer through any harness, and `claude-bridge` stays experiment-only.

### What the developer tools refuse

The product layers are in [What the brake refuses](../reference/harness-routing.md#what-the-brake-refuses). The developer tools add two more:

| Layer | Where | What it refuses | What you see |
|---|---|---|---|
| Dev helper | `scripts/harness-run.mjs` | A braked Pi provider, a Pi provider outside the allowlist, a Pi writer other than `openrouter/qwen/qwen3-coder-plus`, or an aggregator id whose vendor segment is a native vendor | `pi brake: xai has a native harness; refusing Pi impersonation`, or `… refusing to bill it through openrouter` |
| Developer roster | `scripts/roster-policy.mjs` | An aggregator route whose vendor segment is a native vendor | `Roster policy refused: native vendor cannot use Pi` |

The dev helper's allowlist (`openrouter`, `nous-portal`, `antigravity`) is a different list from `PI_ALLOWED_PROVIDERS` in `plugins/kxm/src/harness.ts`, which gates nothing. Which of the two should govern is an open decision (Tracking → Still open). Edit permission exists only in the dev helper, and only for admitted writer or experiment routes. The helper accepts only a ChatGPT login for codex, not an API key.

The product brake, the dev helper and the roster policy now agree on the vendor segment: all three refuse `openrouter/x-ai/…` and `openrouter/anthropic/…`. They refuse the other native-vendor ids for different reasons. The product brake names `openai-codex/…`, `kimi-coding/…`, `claude-bridge/…` and `antigravity/claude-…` as a native vendor's own Pi provider; the helper and `validateRosterDocument` refuse them as unsupported Pi routes, because the provider is off the helper allowlist or `antigravity` is given a non-Gemini id (`unsupported Pi provider/model` in the roster policy). The product brake accepts `qwen-token-plan/…` and `zai-coding-cn/…`, which the developer tools do not allowlist.

## Worked examples on this checkout

These extend the generic examples on the reference page with this checkout's admissions, developer-roster routes, readiness on the capture machine, and inventory prices.

### Grok 4.6

| | Native `grok` | Pi + OpenRouter |
|---|---|---|
| Selector | `xai/grok-4.6`: admitted, and first in the writer roster | `openrouter/x-ai/grok-4.6`: not admitted |
| Developer roster | `grok-native`, the writer route with `edit` | Refused: `native vendor cannot use Pi` |
| Readiness | `grok` shows auth `yes` | `pi auth check --provider openrouter` returned `not_ready` |
| Billing | grok.com subscription (OAuth) | $2.00 input, $6.00 output, $0.50 cached input |
| Context | 500K (Pi's `xai` row; `grok models` does not print one) | 500,000 |

Pi's own `xai` provider reported `ready` (OAuth) on the capture machine. When the grok quota runs out, the next writer in the lineup is `qwen-openrouter-pi`, a different vendor.

### GPT-5.6 Sol

| | Native `codex` | Pi + OpenRouter |
|---|---|---|
| Selector | `openai/gpt-5.6-sol`: admitted, the CLI critic | `openrouter/openai/gpt-5.6-sol`: not admitted |
| Developer roster | `sol-codex`: `reviewer-cli`, `read-only` | Refused |
| Billing | ChatGPT subscription | $2.00 input, $10.00 output, $0.20 cached input |
| Context | Pi's `openai-codex` row, the same ChatGPT backend, lists 272K | 1,050,000 |

In the inventory, `openai/gpt-5.6-sol` has sources `openrouter+nous` and carries OpenRouter prices. `pi auth check --provider openai-codex` reported `ready` on the capture machine.

### Claude Fable

| | Native `claude` | Pi + OpenRouter |
|---|---|---|
| Selector | `anthropic/fable`: admitted, planner and architecture critic | `openrouter/anthropic/claude-fable-5.1`: not admitted |
| Developer roster | `fable-claude`: `planner` and `reviewer-arch`, `read-only` | Refused |
| Readiness | Detected `yes`, auth `no`, dispatch `no (not_authenticated)` | `not_ready` |
| Billing | claude.ai subscription | $10.00 input, $50.00 output, $0.25 cached input |
| Context | 1M (Pi's `anthropic` row) | 1,000,000 |

`claude` was logged out on the capture machine, so the native route failed closed. Pi's `anthropic` provider reported `ready` (OAuth). The `anthropic/fable` row in `prices.yaml` gives a list estimate only when the catalog is dated today.

### Gemini 3.8 Flash

| | Native `agy` | `antigravity` Pi provider | Pi + OpenRouter |
|---|---|---|---|
| Selector | `google/gemini-3.8-flash-high`: admitted, last in the writer roster | `antigravity/gemini-3.8-flash`: not admitted | `openrouter/google/gemini-3.8-flash`: not admitted |
| Billing | Google subscription | Google subscription | $0.75 input, $3.75 output, $0.075 cached input |
| Context | `agy` does not print it; the vendored catalog lists 1,048,576 | 1,048,576 | 1,048,576 |

The admitted runtime route today is the `agy` selector.

## Routing decisions for this repository

### Google through `antigravity`

The decision is that Google models run through the `antigravity` Pi provider, never through a shell-out to the `agy` CLI; `agy` stays a harness catalog and helper entry, not the admission path. Pi's `google/*` provider stays braked, and an `antigravity` route needs a signed-in `/login antigravity` inside Pi before it can be admitted. The dev helper and the roster policy accept only `antigravity/gemini-…`.

The code differs from that decision: `.kxm/routes.yaml` admits `google/gemini-3.8-flash-*`, which can run only through `agy`, and the Runtime's Pi one-shot runs with `--no-extensions`, so it cannot reach `antigravity/…`. Until an antigravity route is admitted, do not add one on your own.

### Vendors with no native harness

| Model | Vendor-plan route | OpenRouter route | Notes |
|---|---|---|---|
| Qwen3.8 Flash | `qwen-token-plan/qwen3.8-flash`: admitted, in the writer roster; `ready` (`api_key`) | `openrouter/qwen/qwen3.8-flash`: admitted; $0.15 input, $0.47 output | `prices.yaml` gives both routes the same rates. Prefer the plan when it is authenticated. |
| Qwen3 Coder Plus | none | `openrouter/qwen/qwen3-coder-plus`: $0.65 input, $3.25 output | The only admitted Pi writer: exact model, `edit` permission. |
| GLM 5.3 and 5.3 Flash | `zai-coding-cn/glm-5.3` and `…/glm-5.3-flash`: admitted as failover critics and writer | `openrouter/z-ai/glm-5.3-flash`: admitted; $0.09 input, $0.30 output | Z.ai has no native harness. |
| DeepSeek V4.1 Flash | `qwen-token-plan/deepseek-v4.1-flash`: admitted | `deepseek/deepseek-v4.1-flash` in the OpenRouter feed: $0.15 input, $0.60 output | Bills a DeepSeek model through Alibaba's plan, and passes the product brake because it names no vendor segment. An open admission question, not a precedent. |

The developer runner is stricter. Its only Pi writer is `openrouter/qwen/qwen3-coder-plus`, and it does not allowlist `qwen-token-plan` or `zai-coding-cn`. Today OpenRouter is the right answer here for Qwen3 Coder Plus, Qwen3.8 Flash and GLM 5.3 Flash.

### Nous

`nous-portal/tencent/hy4-preview` is the reviewed experiment example, and it is not a writer. Pi on the capture machine listed `nous-portal/tencent/hy3-preview`, not `hy4-preview`, so check live ids before you use them. The dev helper does not allowlist `nous/…` or `nous-proxy/…`, and the roster policy refuses Portal routes to native vendors, just as it refuses the OpenRouter copies.

## Troubleshooting the developer tools

| Symptom | Cause | Fix |
|---|---|---|
| `pi brake: xai has a native harness; refusing Pi impersonation` | A dev-helper request routed a native vendor through Pi. | Use the native harness recipe instead: `just impl`, `just plan`, `just review-arch` or `just review-cli`. |
| `Roster policy refused: native vendor cannot use Pi` | A `.kxm/roster.yaml` Pi route names a native vendor, as in `openrouter/x-ai/…` or `nous-portal/anthropic/…`. | Remove the route. Only a native harness route is valid for that vendor. |
| The dev helper refuses a codex route. | `codex` is logged in with an API key. | Run `codex login` with the ChatGPT flow. |

For example, the native writer recipe:

```bash
just impl brief.md
```

## Related

- [Harness routing](../reference/harness-routing.md): the rules, the decision procedure and the generic examples
- [Assignment runner](assignment-runner.md): the loop that enforces the developer roster
- [Configuration file reference](../reference/config-reference.md#kxmrosteryaml-kxmdeveloper-rosterv1): the `kxm.developer-roster.v1` fields
- [Routing and cost telemetry contract](../contracts/routing.md): the routing record, cost basis and dev-helper telemetry
