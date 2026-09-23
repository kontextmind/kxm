# Harness routing: native harness or Pi aggregator

This guide helps you choose how KXM runs a model. Some vendors have their own harness: `claude`, `codex`, `grok`, `agy`, `kimi` and `deepseek`. Other routes go through Pi with a provider prefix, such as `openrouter/…` or `nous-portal/…`, or through one of the vendor-plan providers Pi also hosts. Many models can be reached both ways, and this guide covers that case too.

It explains how to pick a route and how to check which route KXM actually used. Field-by-field meanings of the files named here are in [config-reference.md](config-reference.md). This guide does not list what is admitted today. That list lives in **Tracking → Decided** in [`plans/implementation-plan.md`](../../plans/implementation-plan.md#tracking-working-tree-not-a-release) and in `kxm harness list` (`AGENTS.md:31-33`, `AGENTS.md:88-92`).

The command output in this guide was captured on 2026-09-23 on one operator machine, from a source checkout. Your output will differ. In a source checkout, `node scripts/kxm.mjs` is the same program as `kxm`.

## The rules this guide applies

These rules come from `AGENTS.md` and Tracking. The code enforces them in layers, and section 2 shows where each layer sits.

- **Native harness first.** "If the model's provider has its own harness and that harness is **installed and logged in**, use it — not Pi's copy of the same provider." (`AGENTS.md:86`). Tracking says the same (`plans/implementation-plan.md:284-289`).
- **Fail closed, never cross-bill.** "If the native harness is missing or logged out, do **not** silently bill through Pi's other-provider key. Fail closed or ask to log in." (`AGENTS.md:127`). "Never bill one vendor through another harness." (`AGENTS.md:38`).
- **Aggregators are Pi providers.** "Aggregators are Pi *providers*, not a second coding harness." Each one is used only after a fail-closed `pi auth check --provider <id>` (`AGENTS.md:103-125`).
- **Same model, prefer the subscription.** "Prefer an authenticated native subscription for the same model." (`AGENTS.md:55`, `plans/implementation-plan.md:343-344`).
- **Quota exhaustion is not a licence to cross-bill.** Take "the **next best** authenticated option by quality-then-cost from the report — not a silent Pi API key for the same vendor" (`AGENTS.md:137`, `plans/implementation-plan.md:391-396`).
- **A harness is not a model, and it is not a worker.** A harness runs only the models it hosts. Only Pi is a long-lived worker. `grok` and `agy` are one-shot CLIs (`AGENTS.md:129`, `AGENTS.md:147`, `plans/implementation-plan.md:279-283`).
- **Admission is a decision, not a config tweak.** A route that is not admitted is refused. Pi writer admission is exact-model: today only `openrouter/qwen/qwen3-coder-plus` (`plans/implementation-plan.md:337-343`).

## 1. Decision procedure: "I want model X"

1. **Name the vendor of X.** The vendor is the lab that trained the model, not whoever bills you for it. `x-ai/grok-4.6` is xAI. `qwen/qwen3-coder-plus` is Alibaba. `z-ai/glm-5.3` is Z.ai.
2. **Check whether the vendor has a native harness.** KXM maps `anthropic→claude`, `openai→codex`, `xai→grok`, `google→agy`, `moonshot→kimi` and `deepseek→deepseek` (`plugins/kxm/src/harness.ts:112-119`). Google has a decided exception (section 4). If the vendor is not in this list, go to step 6.
3. **Check that the native harness is installed and logged in.** In `kxm harness list`, the row must show `detected yes`, `auth yes` and `dispatch yes`. `no` and `unknown` are never eligible (`plans/implementation-plan.md:397-399`).
4. **Check that the harness hosts X.** `claude` runs only Anthropic models. `grok` runs only `grok-*`. `agy` runs only `gemini-*`. `kimi` runs only `kimi-*` or `moonshot-*`. `deepseek` runs only `deepseek-*`. `codex` refuses other vendors' model prefixes (`plugins/kxm/src/harness.ts:1009-1067`). To see the exact ids, use the harness's own catalog: `grok models`, `agy models` or `kimi provider list`.
5. **If steps 3 and 4 pass, use the native harness.** Do not use Pi's copy of that vendor. That rules out a direct Pi provider for the vendor (`anthropic/…`, `xai/…`, `google/…`), Pi's subscription providers (`openai-codex/…`, `kimi-coding/…`, `claude-bridge/…`) and any aggregator path to the vendor (`openrouter/<vendor>/…`, `nous-portal/<vendor>/…`).
   - If step 3 fails, ask the operator to log in, or fail closed.
   - If the subscription is exhausted, move to the next eligible entry in the role roster. That entry must be a different route, not the same vendor through Pi.
   - Go to step 8.
6. **If the vendor has no native harness, use Pi with a provider prefix.** Prefer the vendor's own plan provider when Pi has one authenticated, for example `qwen-token-plan/…` or `zai-coding-cn/…`. Otherwise use an allowlisted aggregator: `openrouter/…` or `nous-portal/…`.
7. **Check Pi readiness for that exact provider.** `pi auth check` must report `ready`. KXM runs this check itself before every Pi dispatch (`plugins/kxm/src/harness.ts:1186-1218`).
8. **Confirm admission before you dispatch.**
   - **Product runtime:** the selector must be under `admitted` in `.kxm/routes.yaml` and not under `disabled`. If `.kxm/roles/<role>.yaml` exists, the selector must also be in that roster (`plugins/kxm/src/engine.ts:1369-1390`).
   - **Developer runner (`just assign`):** the route must be in `.kxm/roster.yaml` and pass `scripts/roster-policy.mjs`.
   - If the route is not admitted, stop. Admission is decided in Tracking.

| Vendor has a native harness? | Native harness in `kxm harness list` | Harness hosts X? | Route KXM should take |
|---|---|---|---|
| Yes | detected, auth `yes`, dispatch `yes` | Yes | The native harness. Never Pi or an aggregator for this vendor. |
| Yes | detected, auth `yes` | No | No route for X in this harness. Choose another model. |
| Yes | auth `no` or `unknown`, or not detected | — | Fail closed. The operator logs in. Do not fall back to OpenRouter, Nous or Pi's own provider. |
| Yes, but the subscription is exhausted | auth `yes` | Yes | The next eligible roster route by quality, then cost. Record the exhaustion. Not the same vendor through Pi. |
| No (Qwen, GLM and others) | — | — | Pi with the vendor-plan provider or an allowlisted aggregator, after `pi auth check` reports `ready`. |
| Google | — | — | Exception: the `antigravity` Pi provider is the decided route. See section 4 for what the code does today. |
| Anthropic through `claude-bridge` | — | — | Experiment only. Never a writer. |

Every row still has to pass step 8.

The commands for the steps above:

```bash
kxm harness list
```

```bash
pi auth check --provider openrouter --json --no-refresh
```

```bash
kxm routes list
```

```bash
kxm role get writer
```

This is `kxm harness list` on the operator machine used for this guide:

```text
default harness: pi (omit agent harness: to use headless Pi)
enable/disable = Git YAML (.kxm/agents, .kxm/models) or the harness's own plugin CLI
governed kxm skills are not auto-updated
id        default  detected  auth     dispatch                   updates
pi        yes      yes       unknown  no (auth_context_required) self,extensions,models
claude    no       yes       no       no (not_authenticated)     self,extensions
kimi      no       yes       yes      yes                        self
codex     no       yes       yes      yes                        self
deepseek  no       no        no       no (not_detected)          self
grok      no       yes       yes      yes                        self
agy       no       yes       yes      yes                        self
```

`pi unknown (auth_context_required)` is expected. Pi has no single login. Its readiness is checked per provider (`plans/implementation-plan.md:399-405`). `kxm harness list --json` adds `authMethod`: `ChatGPT` for codex, `claude.ai` or `api-key` for claude, and `antigravity-oauth` for agy. `authMethod` decides whether KXM records a run as `unmetered` (section 2).

Here is how KXM probes each harness (`plugins/kxm/src/harness.ts:777-829`, `plugins/kxm/src/harness.ts:919-925`):

| Harness | Vendor | Probe KXM runs | Counts as logged in when |
|---|---|---|---|
| `claude` | anthropic | `claude auth status` | The JSON has `"loggedIn": true`. |
| `codex` | openai | `codex login status` | Output has `Logged in using ChatGPT`. `Logged in using an API key` also counts, but it adds issue `auth_api_key`, and the row shows `API key`. |
| `grok` | xai | `grok models` | Output has the line `You are logged in with grok.com.` |
| `agy` | google | `agy models` | Output lists model rows as `id<TAB>label`. |
| `kimi` | moonshot | `kimi provider list` | Output has `managed:kimi`, `type=kimi` or `Default model:`. |
| `deepseek` | deepseek | none | Never. Auth is always `unknown` (`plugins/kxm/src/harness.ts:103`). |
| `pi` | per provider | `pi auth check --model <provider>/<model> --json` | The JSON has `"status":"ready"`. |

`pi auth check` refreshes expired OAuth credentials unless you pass `--no-refresh`. Use `--no-refresh` when you only want to look. KXM's own probe does not pass it.

To see what KXM sees, run the probes yourself. They are read-only, and the model-listing ones double as each harness's catalog:

```bash
kxm harness list --json
```

```bash
claude auth status
```

```bash
codex login status
```

```bash
grok models
```

```bash
agy models
```

```bash
kimi provider list
```

```bash
pi auth check --model openrouter/qwen/qwen3-coder-plus --json --no-refresh
```

## 2. Which route will a config line use?

### How KXM builds a route

- **Selector.** The selector is `<model.provider>/<model.model>`, taken from the agent YAML. A workflow step's `model:` string overrides it (`plugins/kxm/src/engine.ts:1301-1342`). The provider must not contain `/`. The model id may, for example `qwen/qwen3-coder-plus` under `openrouter`.
- **Harness.** The harness is the agent's `harness:`, or the project's `defaultHarness` (Pi) when the agent omits it (`plugins/kxm/src/runtime-supervisor.ts:809-829`, `plugins/kxm/src/oneshot-producer.ts:75-86`). The selector string does not choose the harness, and neither does a roster entry.
- **Admission.** The selector must be admitted, and it must be in the role roster when that role file exists. Agent id `implementer` maps to role `writer` (`plugins/kxm/src/engine.ts:1369-1390`).
- **Dispatch probe.** Before spawning anything, the producer probes the exact harness, provider and model triple. It refuses unhosted pairs and the Pi brake (`plugins/kxm/src/oneshot-producer.ts:138-156`, `plugins/kxm/src/harness.ts:1101-1243`).

### Agent YAML

This is the native route, from `.kxm/agents/implementer.yaml`:

```yaml
harness: grok
model:
  provider: xai
  model: grok-4.6
```

The selector is `xai/grok-4.6` and the harness is `grok`. The live one-shot producer spawns `grok --model grok-4.6 … --output-format json --single <prompt>` (`plugins/kxm/src/oneshot-producer.ts:204-207`, `plugins/kxm/src/oneshot-producer.ts:252`).

This is the same model through Pi and OpenRouter:

```yaml
# harness omitted: Pi
model:
  provider: openrouter
  model: x-ai/grok-4.6
```

The selector is `openrouter/x-ai/grok-4.6` and the harness is `pi`. Pi is spawned with `--model openrouter/x-ai/grok-4.6 --no-tools --no-extensions … -p --mode json` (`plugins/kxm/src/oneshot-producer.ts:226-239`, `plugins/kxm/src/harness.ts:487`). Write `model.model` exactly as the provider names it. For OpenRouter that is the vendor slug, so `x-ai`, not `xai`.

The harness and the selector have to agree. Pi refuses `provider: xai`. `grok` refuses `provider: openrouter`. Section "What the brake refuses" has the exact messages.

### Role roster entries

This is `kxm role get writer` on this checkout:

```text
schema: kxm.role.v1
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

Every roster entry is a selector. When the engine checks the roster, it reads only `model` (`plugins/kxm/src/routes.ts:48-56`). The role schema accepts a `harness:` key on an entry (`plugins/kxm/src/role.ts:14-20`), but dispatch never reads it. The harness still comes from the agent that runs the step. `kxm role list` prints the first entry as `(harness:xai/grok-4.6)`. There, "harness" is a placeholder label, not a harness (`plugins/kxm/src/cli/roles.ts:113`).

```bash
kxm role list
```

The consequence matters when a roster mixes routes. The writer roster above mixes a native selector with Pi selectors. The implementer agent declares `harness: grok`, so only `xai/grok-4.6` can run under it. Under that agent, a Pi selector fails closed with `grok_not_authenticated: grok harness not detected (harness_unhosted_model)`. To run a Pi selector, create a separate agent with `harness:` omitted. The engine does not walk the roster to fail over on its own, and neither does `just assign` (`AGENTS.md:61-62`).

### routes.yaml ids

`kxm routes list` on this checkout:

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

The first segment of an id is the provider, and the rest is the model id. A route id does not name a harness. The first segment tells you which harness can run it:

| Selector prefix | What it is | Harness that can run it |
|---|---|---|
| `anthropic/` | Anthropic, native | `claude` only. Pi brakes it. |
| `openai/` | OpenAI, native | `codex` only. Pi brakes it. |
| `xai/` | xAI, native | `grok` only. Pi brakes it. |
| `google/` | Google, native | `agy` only. Pi brakes it. |
| `moonshot/` | Moonshot, native | `kimi` only. Pi brakes it. |
| `deepseek/` | DeepSeek, native | `deepseek` only. It is never eligible because its auth is always `unknown`. |
| `openrouter/` | OpenRouter credit | `pi` |
| `nous-portal/`, `nous/`, `nous-proxy/` | Nous Research | `pi`, through a Pi package or the KXM Pi extension |
| `antigravity/` | Google subscription through Pi | `pi`, through the KXM Pi extension |
| `claude-bridge/` | Claude subscription through Pi | `pi`, through the KXM Pi extension. Experiment only. |
| `qwen-token-plan/`, `zai-coding-cn/` | Vendor-plan API key configured in Pi | `pi` |
| `openai-codex/`, `kimi-coding/` | Pi's own copy of a native subscription | Do not use. See the GPT-5.6 Sol example and the last section. |

`kxm routes admit --model <id>` only takes an id that exists in `.kxm/models/inventory.yaml` (`plugins/kxm/src/cli/project.ts:667-686`). The inventory is a different namespace from these selectors (next section). Check with a dry run first:

```bash
kxm routes admit --model openrouter/qwen/qwen3-coder-plus --dry-run
```

```text
select a model from the refreshed inventory
```

It exits with code 2, even though that selector is already admitted. A bare OpenRouter slug is accepted, but it is not a dispatchable selector:

```bash
kxm routes admit --model x-ai/grok-4.6 --dry-run
```

```text
would admit x-ai/grok-4.6
```

If that id were admitted, an agent would need `provider: x-ai`. Pi has no provider called `x-ai`, so the Pi auth probe would fail closed. When a route needs a provider prefix that the inventory does not carry, admit it by a Git-reviewed edit of `.kxm/routes.yaml`, after the Tracking decision.

### The developer roster (`.kxm/roster.yaml`)

The issue-127 runner (`just assign`) uses its own policy file. Routes there name the harness, the model and the vendor explicitly:

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

`scripts/roster-policy.mjs:115-142` applies these rules:

- A native route uses a bare model id.
- A Pi route needs an allowlisted prefix: `openrouter`, `nous-portal` or `antigravity` (`scripts/harness-run.mjs:76`).
- An aggregator id needs at least three segments.
- The vendor segment of an aggregator id must not be a native vendor. `x-ai` counts as `xai` and `moonshotai` counts as `moonshot` (`scripts/roster-policy.mjs:15`).
- `antigravity` ids must be exactly `antigravity/gemini-…`.
- The writer and both critics must be three different vendors (`scripts/roster-policy.mjs:159-162`).

### Three namespaces that look alike

The same model shows up under different ids depending on the file:

| Where | Id for Grok 4.6 | What that id means |
|---|---|---|
| `.kxm/routes.yaml`, agent selector | `xai/grok-4.6` | Provider `xai`. Needs `harness: grok`. |
| `.kxm/routes.yaml`, agent selector | `openrouter/x-ai/grok-4.6` | OpenRouter through Pi. Not admitted. |
| `.kxm/models/inventory.yaml`, source `pi` | `xai/grok-4.6` | Pi's own `xai` provider. The brake refuses it. |
| `.kxm/models/inventory.yaml`, source `openrouter` | `x-ai/grok-4.6` | The OpenRouter catalog slug. The inventory stores OpenRouter ids without an `openrouter/` prefix (`plugins/kxm/src/model-inventory.ts:115-118`). |
| `.kxm/roster.yaml` | `harness: grok`, `model: grok-4.6` | The native route, with a bare model id. |
| `.kxm/prices.yaml` | `id: xai/grok-4.6`, `provider: xai`, alias `x-ai/grok-4.6` | A list price that applies only to provider `xai`. Price lookup filters by provider (`plugins/kxm/src/price-calc.ts:27-41`). |

GPT-5.6 Sol is the easiest to misread. In the inventory, `openai/gpt-5.6-sol` has sources `openrouter+nous` and carries OpenRouter prices. In `.kxm/routes.yaml`, the same string means provider `openai` through native `codex`.

### What the brake refuses

| Layer | Where | What it refuses | What you see |
|---|---|---|---|
| Pi native brake (product) | `plugins/kxm/src/harness.ts:130-137`, `plugins/kxm/src/harness.ts:1069-1085` | Pi with provider `anthropic`, `openai`, `xai`, `moonshot`, `google` or `deepseek` | Issue `pi_native_impersonation_blocked`, message `pi must not impersonate native provider xai; use the native harness`. At dispatch: `pi_not_authenticated: pi harness not detected (pi_native_impersonation_blocked)`. |
| Harness hosting (product) | `plugins/kxm/src/harness.ts:1009-1067` | A native harness given another vendor's provider or model | Issue `harness_unhosted_model`, for example `harness grok does not host provider openrouter`. At dispatch: `grok_not_authenticated: grok harness not detected (harness_unhosted_model)`. |
| Config load | `plugins/kxm/src/project-config.ts:1150-1161` | The two checks above, but only for agents that **declare** `harness:` | A config issue with the same code. An agent that omits `harness:` is checked only at dispatch. |
| Product admission | `plugins/kxm/src/engine.ts:1369-1390`, `plugins/kxm/src/runtime-supervisor.ts:824-826` | Any selector that is not admitted or not in the role roster | `producer_route_unsupported: model '<selector>' is not admitted`, or `… not in role '<role>' roster`, or `producer_route_not_admitted` |
| Dev helper | `scripts/harness-run.mjs:1533-1553` | A braked Pi provider; any Pi provider outside `openrouter`, `nous-portal` and `antigravity`; any Pi writer other than `openrouter/qwen/qwen3-coder-plus` | `pi brake: xai has a native harness; refusing Pi impersonation` |
| Developer roster | `scripts/roster-policy.mjs:115-142` | An aggregator route whose vendor segment is a native vendor | `Roster policy refused: native vendor cannot use Pi` |

The product brake checks only the first segment of the selector. The following ids were passed to `validateHarnessModelPair("pi", …)` on this checkout, and every one returned `{"valid":true}`:

- `openrouter/x-ai/grok-4.6`
- `openrouter/anthropic/claude-fable-5.1`
- `openai-codex/gpt-5.6-sol`
- `kimi-coding/kimi-for-coding`
- `claude-bridge/claude-fable-5`
- `antigravity/claude-sonnet-4-6`

In the product runtime, admission is the only thing that stops these ids. Keep them out of `.kxm/routes.yaml`. The developer roster refuses the aggregator and plan-provider forms. Given the same ids, `validateRosterDocument` answered `native vendor cannot use Pi` for `openrouter/x-ai/…` and `openrouter/anthropic/…`. It answered `unsupported Pi provider/model` for `qwen-token-plan/…`, `xai/…` and `antigravity/claude-…`.

To check agents that declare a harness, run the config-time validation. It is read-only:

```bash
kxm init --dry-run
```

```text
init plan: ready
```

### Confirming after a run

For each attempt, the engine appends a `kxm.routing-record.v2` record inside a `routing.attempt.recorded` run event (`plugins/kxm/src/engine.ts:2097-2110`). To see which route ran, read these fields:

- `harness`: `grok`, `codex`, `claude`, `agy`, `kimi` or `pi`. This is the fastest way to tell native from Pi.
- `provider`: for example `xai`, `openai` or `anthropic` for native routes, and `openrouter` or `qwen-token-plan` for Pi routes.
- `requestedModel`: the model id with the provider stripped, for example `grok-4.6` or `x-ai/grok-4.6`.
- `effectiveModel`: the model the CLI reported. It is `unknown` when the CLI output did not name a model.
- `costBasis`, `costUsd` and `priceRef`: see the table below.
- `providerMetadata`: `authMethod`, plus the list estimate `listCostUsd`, and `priceCatalogStale` or `priceCatalogUnavailable` when no estimate was made.

Today the producers write cost fields like this:

| Route | `costBasis` | `costUsd` | `priceRef` | Source |
|---|---|---|---|---|
| `claude` with `authMethod: claude.ai` | `unmetered` | `null` | `subscription:claude` | `plugins/kxm/src/oneshot-producer.ts:330-333` |
| `codex` with `authMethod: ChatGPT` | `unmetered` | `null` | `subscription:codex` | same |
| `agy` with `authMethod: antigravity-oauth` | `unmetered` | `null` | `subscription:agy` | same |
| `grok` | `unknown` | `null` | — | The grok probe sets no `authMethod` (`plugins/kxm/src/harness.ts:804-806`). |
| `claude` or `codex` with an API key | `unknown` | `null` | — | An API key is not a subscription. |
| `pi`, any provider (OpenRouter, Nous, plan providers) | `unknown` | `null` | — | `plugins/kxm/src/oneshot-producer.ts:331`, `plugins/kxm/src/pi-producer.ts:632-633` |

No product producer writes `metered` today. Subscription runs are `unmetered` because a flat plan has no per-call bill. Unmetered is not free, and missing is not zero (`docs/contracts/routing.md:135-137`). A list estimate is added to `providerMetadata.listCostUsd` only when all of these hold:

- `.kxm/prices.yaml` has a row whose `provider` matches the route's provider.
- The catalog `date` is today.
- On the live one-shot producer, which the Runtime uses for every harness including Pi, the harness is `claude` and the token counts are complete (`plugins/kxm/src/oneshot-producer.ts:319-355`). The long-lived Pi producer estimates for any provider (`plugins/kxm/src/pi-producer.ts:625-649`, `plugins/kxm/src/prices.ts:150-167`).

The catalog on this checkout is dated `2026-09-16`, so every current run records `priceCatalogStale: true` and no estimate.

`kxm routing report` groups records by harness, model, effort and role. It shows counts of unmetered and unknown attempts separately. It never ranks an unknown-cost route as the cheapest (`docs/contracts/routing.md:169-176`). It has no provider column, so the `Harness` column is what tells you native from Pi.

```bash
kxm routing report
```

```text
no routing records in telemetry
```

By default, from inside a KXM project, the report reads the project's Runtime event store first (`<state root>/runtime/projects/<key>/run-events.db`, read-only) and then `.kxm/logs/telemetry.jsonl`, so live `kxm run` attempts appear without an export (`loadRoutingSources` in `plugins/kxm/src/improve-sources.ts`). Each checkout reads only its own store. Attempts from simulated drives are excluded, and a Runtime attempt counts toward Pass% only when its run completed without the step being re-entered; a cancelled or still-running run leaves its attempts undecided. `--json` lists what was read under `sources`; the text output does not. An empty report after a simulated drive is therefore expected. `--file` reads only the named JSONL, which may hold `routing.attempt.recorded` events (`plugins/kxm/src/telemetry.ts:98-99`); the Runtime serves a run's events at `GET /v1/runs/<runId>/events`.

```bash
kxm routing report --json
kxm routing report --file ./run-events.jsonl --equivalent-list-cost
```

## 3. Worked examples: the same model, two routes

The list prices below come from `.kxm/models/inventory.yaml`, fetched `2026-09-16T14:54:53Z`. They are in USD per 1M tokens. Context sizes come from that inventory, or from `pi --list-models` where the native CLI does not print one. This checkout has no routing records yet, so none of the examples has recorded latency. For latency, run a bounded side-by-side experiment and compare p50 and p95 in `kxm routing report` (`AGENTS.md:135`).

Pi's model list shows context, max output, thinking and image support for each model. On this machine it showed no `openrouter` rows while OpenRouter had no credentials, so a missing provider is itself a readiness hint:

```bash
pi --list-models
```

The live one-shot producer runs every harness read-only:

- `grok`: `--sandbox read-only --permission-mode plan --tools Read,Glob,Grep`.
- `claude`: `--tools Read,Glob,Grep --safe-mode --permission-mode plan`.
- `codex`: `--sandbox read-only`.
- `agy`: `--mode plan --sandbox`.
- `pi`: `--no-tools --no-extensions`.

These flags come from `plugins/kxm/src/harness.ts:482-493`. Edit permission exists only in the dev helper, and only for admitted writer or experiment routes (`scripts/harness-run.mjs:132-176`). Only Pi can run as a long-lived worker.

### Grok 4.6

| | Native `grok` | Pi + OpenRouter |
|---|---|---|
| Agent YAML | `harness: grok`, `provider: xai`, `model: grok-4.6` | `harness:` omitted, `provider: openrouter`, `model: x-ai/grok-4.6` |
| Selector | `xai/grok-4.6`: admitted, and first in the writer roster | `openrouter/x-ai/grok-4.6`: not admitted |
| Developer roster | `grok-native`, the writer route with `edit` | Refused: `native vendor cannot use Pi` |
| Readiness | `grok` shows auth `yes` here | `pi auth check --provider openrouter` returns `not_ready` here |
| Billing | grok.com subscription (OAuth) | OpenRouter credit: $2.00 input, $6.00 output, $0.50 cached input |
| Recorded `costBasis` | `unknown` | `unknown`. There is no list estimate, because the price row is keyed to provider `xai`. |
| Context | 500K (Pi's `xai` row. `grok models` does not print one.) | 500,000 |
| Mode | One-shot `grok --single` or `--prompt-file`. Not a worker. | One-shot `pi -p --mode json`, or a long-lived Pi worker |

**KXM picks the native route.** xAI has a native harness, and it is logged in. If `grok` is logged out, fail closed and have the operator run `grok login --oauth`. Pi's own `xai` provider reports `ready` (OAuth) on this machine, and that is exactly what the brake exists to refuse. Tracking says it plainly: "Pi's `xai` provider is not a writer fallback" (`plans/implementation-plan.md:294-295`). When the grok quota runs out, the next writer in the lineup is `qwen-openrouter-pi`, a different vendor. It is not the OpenRouter copy of Grok.

```bash
pi auth check --provider xai --json --no-refresh
```

```text
{"status":"ready","provider":"xai","authType":"oauth"}
```

### GPT-5.6 Sol

| | Native `codex` | Pi + OpenRouter |
|---|---|---|
| Agent YAML | `harness: codex`, `provider: openai`, `model: gpt-5.6-sol` | `harness:` omitted, `provider: openrouter`, `model: openai/gpt-5.6-sol` |
| Selector | `openai/gpt-5.6-sol`: admitted, the CLI critic | `openrouter/openai/gpt-5.6-sol`: not admitted |
| Developer roster | `sol-codex`: `reviewer-cli`, `read-only` | Refused |
| Readiness | `codex` shows auth `yes`, `authMethod: ChatGPT` | `not_ready` here |
| Billing | ChatGPT subscription | $2.00 input, $10.00 output, $0.20 cached input |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:codex` | `unknown` |
| Context | Pi's `openai-codex` row, the same ChatGPT backend, lists 272K | 1,050,000 |
| Mode | One-shot `codex exec --json -` | Pi |

**KXM picks the native route.** Two traps apply here. The first is `openai-codex/gpt-5.6-sol`, which is the same ChatGPT subscription driven through Pi. `pi auth check --provider openai-codex` reports `ready` on this machine, and the product brake does not catch that provider id. Do not admit it. The second is a codex login made with an API key: the row shows `API key` and the run records `unknown`. The dev helper accepts only a ChatGPT login for codex (`docs/contracts/routing.md:83-88`).

```bash
pi auth check --provider openai-codex --json --no-refresh
```

```text
{"status":"ready","provider":"openai-codex","authType":"oauth"}
```

The larger OpenRouter context window does not make OpenRouter an allowed route. If a task needs more than the subscription route holds, raise an admission decision in Tracking.

### Claude Fable

| | Native `claude` | Pi + OpenRouter |
|---|---|---|
| Agent YAML | `harness: claude`, `provider: anthropic`, `model: fable` | `harness:` omitted, `provider: openrouter`, `model: anthropic/claude-fable-5.1` |
| Selector | `anthropic/fable`: admitted, planner and architecture critic | `openrouter/anthropic/claude-fable-5.1`: not admitted |
| Developer roster | `fable-claude`: `planner` and `reviewer-arch`, `read-only` | Refused |
| Readiness | Here: detected `yes`, auth `no`, dispatch `no (not_authenticated)` | `not_ready` here |
| Billing | claude.ai subscription | $10.00 input, $50.00 output, $0.25 cached input (`~anthropic/claude-fable-latest` costs the same) |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:claude`. The `anthropic/fable` row in `prices.yaml` gives a list estimate only when the catalog is dated today. | `unknown` |
| Context | 1M (Pi's `anthropic` row) | 1,000,000 |
| Mode | One-shot `claude -p --output-format json` | Pi |

**KXM picks the native route, which today means failing closed.** `claude` is logged out on this machine. Pi's `anthropic` provider reports `ready` (OAuth), and OpenRouter lists the same model. Neither may stand in. This is the motivating case for the whole rule (`plans/implementation-plan.md:369-371`). The operator runs `claude auth login`, and the run waits until then.

Vendor independence adds a second rule. Fable is the required architecture critic, so no Anthropic route can be the writer through any harness (`scripts/roster-policy.mjs:160-162`).

### Gemini 3.8 Flash

| | Native `agy` | `antigravity` Pi provider | Pi + OpenRouter |
|---|---|---|---|
| Agent YAML | `harness: agy`, `provider: google`, `model: gemini-3.8-flash-high` | `harness:` omitted, `provider: antigravity`, `model: gemini-3.8-flash` | `harness:` omitted, `provider: openrouter`, `model: google/gemini-3.8-flash` |
| Selector | `google/gemini-3.8-flash-high`: admitted, last in the writer roster | `antigravity/gemini-3.8-flash`: not admitted | `openrouter/google/gemini-3.8-flash`: not admitted |
| Readiness | `agy` shows auth `yes`, `antigravity-oauth` | Registered only inside the KXM Pi extension. From a plain shell, `pi auth check --provider antigravity` returns `provider_not_found`. | `not_ready` here |
| Billing | Google subscription | Google subscription | $0.75 input, $3.75 output, $0.075 cached input |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:agy` | `unknown` | `unknown` |
| Context | `agy` does not print it. The vendored catalog lists 1,048,576. | 1,048,576 | 1,048,576 |
| Effort | Part of the id: `-high`, `-medium` or `-low` | A thinking level: `low`, `medium` or `high` | The provider's reasoning parameter |

**Never OpenRouter for Gemini.** The decision and the code differ on the other two routes; see section 4. The admitted runtime route today is the `agy` selector.

```bash
pi auth check --provider antigravity --json --no-refresh
```

```text
{"status":"not_ready","provider":"antigravity","reason":"provider_not_found"}
```

## 4. Exceptions, and when OpenRouter is the right answer

### Google through the `antigravity` Pi provider

The decision reads: "Google integration is the `antigravity` Pi provider … never a shell-out to the agy CLI. The agy CLI stays a harness catalog/helper entry, not the admission path" (`plans/implementation-plan.md:238-244`, `AGENTS.md:97-100`). Pi's `google/*` provider stays braked. The developer-roster route and writer promotion are waiting on the operator's `/login antigravity` inside Pi and on a live witness (`plans/implementation-plan.md:247-248`). This exception applies only to Gemini ids. The dev helper and the roster policy accept only `antigravity/gemini-…` (`scripts/harness-run.mjs:82`).

The code today differs from that decision in three places:

- `.kxm/routes.yaml` admits `google/gemini-3.8-flash-*`, and Pi brakes the `google` provider, so that route can run only through `agy`.
- The provider is registered by the KXM Pi extension (`plugins/kxm/src/extension.ts:977`). The runtime's Pi one-shot runs with `--no-extensions`, so it cannot reach `antigravity/…`.
- Only an interactive Pi with KXM loaded, a long-lived Pi worker, or a dev-helper edit run can use it.

Until Tracking admits an antigravity route, do not add one on your own. Never use OpenRouter or Nous for Gemini.

### Claude bridge: experiment only

`claude-bridge` is a Pi provider, vendored into KXM, that reuses the Claude subscription login. "Roster admission stays experiment-only because a claude-bridge writer would collide with the fable-claude arch critic under vendor independence" (`plans/implementation-plan.md:256-262`). It grants no writer eligibility (`AGENTS.md:100-101`). The product brake does not refuse `claude-bridge/…`, so keep it out of `.kxm/routes.yaml` unless Tracking admits an experiment.

### Vendors with no native harness: Qwen, GLM and DeepSeek-through-plan

Pi is the right harness when the vendor has no native harness in KXM. The choice is then between the vendor's own plan provider in Pi and an aggregator.

| Model | Vendor-plan route | OpenRouter route | Notes |
|---|---|---|---|
| Qwen3.8 Flash | `qwen-token-plan/qwen3.8-flash`: admitted, in the writer roster. `pi auth check` reports `ready` (`api_key`). Context 1M, max output 131.1K. | `openrouter/qwen/qwen3.8-flash`: admitted. $0.15 input, $0.47 output, $0.016 cached input. Context 1,000,000. | `prices.yaml` gives both routes the same rates. Prefer the plan when it is authenticated (`AGENTS.md:55`). |
| Qwen3 Coder Plus | none | `openrouter/qwen/qwen3-coder-plus`: $0.65 input, $3.25 output, $0.13 cached input | The only admitted Pi writer: exact model, `edit` permission (`plans/implementation-plan.md:337-339`, `scripts/harness-run.mjs:88`). |
| GLM 5.3 and 5.3 Flash | `zai-coding-cn/glm-5.3` and `zai-coding-cn/glm-5.3-flash`: admitted. Failover critics and writer. | `openrouter/z-ai/glm-5.3-flash`: admitted. $0.09 input, $0.30 output. | Z.ai has no native harness here. |
| DeepSeek V4.1 Flash | `qwen-token-plan/deepseek-v4.1-flash`: admitted | `deepseek/deepseek-v4.1-flash` in the OpenRouter feed: $0.15 input, $0.60 output | DeepSeek does have a native harness entry, but its auth is always `unknown`, so it is never eligible. This admission bills a DeepSeek model through Alibaba's plan. Treat it as a Tracking question, not a precedent. |

The developer runner is stricter. Its only Pi writer is `openrouter/qwen/qwen3-coder-plus`, and it does not allowlist `qwen-token-plan` or `zai-coding-cn` (`scripts/harness-run.mjs:76`, `scripts/harness-run.mjs:1551-1553`).

### Nous

Nous is reachable through three Pi providers. The same native-vendor rule applies to all of them.

- **`nous-portal/…`** comes from the third-party Pi package `@jayteelabs/pi-nous-portal-provider`. Log in with `/login` inside Pi, or set `NOUS_API_KEY`. It bills the Portal, not OpenRouter. `nous-portal/tencent/hy4-preview` is the reviewed experiment example, and it is not a writer (`AGENTS.md:113-125`, `plans/implementation-plan.md:1323-1330`). Check live ids before you use them. Pi on this machine lists `nous-portal/tencent/hy3-preview`, not `hy4-preview`.
- **`nous/…`** is the direct API, and **`nous-proxy/…`** is the Hermes subscription proxy. Both are opt-in through `KXM_NOUS_PROVIDERS`, and both are registered by the KXM Pi extension. They carry "no writer/router admission" (`docs/configuration.md:329-362`). The dev helper does not allowlist them.
- The Portal also hosts `anthropic/…`, `openai/…`, `x-ai/…` and `google/…` models. Those are native vendors, so the roster policy refuses them just as it refuses the OpenRouter copies.

This installs the Portal provider (from `AGENTS.md:114-115`):

```bash
pi install npm:@jayteelabs/pi-nous-portal-provider
```

### When OpenRouter is the right answer

- The vendor has no native harness in KXM. No authenticated vendor-plan provider carries the model. The exact `openrouter/<vendor>/<model>` selector is admitted. Today that means Qwen3 Coder Plus, Qwen3.8 Flash and GLM 5.3 Flash.
- A bounded side-by-side experiment on a non-native vendor, where every arm is recorded in routing telemetry (`AGENTS.md:135`).

OpenRouter is **not** the answer in any of these cases:

- A native vendor whose harness is logged out.
- A native vendor whose subscription is exhausted.
- A native vendor listed at a lower price.
- A larger context window on a native vendor's model.

Each of those is a fail-closed stop, or a new Tracking decision.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `kxm harness list` shows `claude … auth no … dispatch no (not_authenticated)`. A run fails with `claude_not_authenticated: claude not authenticated (not_authenticated)`. | The native harness is logged out. | The operator runs `claude auth login`, then re-checks with `kxm harness list`. Do not switch to `openrouter/anthropic/…` or Pi's `anthropic/…`. |
| The codex row shows `API key`, or runs record `unknown` instead of `unmetered`. | `codex` is logged in with an API key, not ChatGPT. | Run `codex login` with the ChatGPT flow. The dev helper refuses the API-key path. |
| `grok` shows auth `unknown (auth_unparsed)`. | `grok models` did not print `You are logged in with grok.com.` | Run `grok login --oauth`, then `grok models`. |
| `pi` shows `unknown (auth_context_required)`. | This is normal. Pi auth is checked per provider. | Run `pi auth check --provider <id> --json --no-refresh` for the provider you need. |
| `pi auth check --provider openrouter` returns `{"status":"not_ready","provider":"openrouter","reason":"credentials_not_configured"}` and exits 1. | No OpenRouter credential in the environment that starts Pi or the Runtime. | Run `/login openrouter` inside Pi, or export `OPENROUTER_API_KEY` where the Runtime starts. Then re-check. |
| `pi auth check --provider nous-portal` or `--provider antigravity` returns `provider_not_found`. | The provider comes from a Pi package or from the KXM Pi extension, and that `pi auth check` process did not see it. `nous-portal` returns `provider_not_found` here even though `pi --list-models nous-portal` lists its models. | Confirm with `pi list` and `pi --list-models <id>`. Remember that the runtime's Pi one-shot runs with `--no-extensions`, so these providers are not reachable there either way. |
| A run hands off with `producer_route_unsupported: model '<selector>' is not admitted`, or a live drive fails with `producer_route_not_admitted`. | The selector is missing from `admitted` in `.kxm/routes.yaml`, or it is listed under `disabled`. | Check with `kxm routes list`. Admission follows a Tracking decision, then `kxm routes admit --model <id>`, or a Git-reviewed edit when the id is not in the inventory. |
| `producer_route_unsupported: model '<selector>' not in role '<role>' roster` | The role file exists and does not list the selector. | Add it to `.kxm/roles/<role>.yaml` by Git review, and check with `kxm role get <role>`. |
| `pi must not impersonate native provider xai; use the native harness`, or `pi_not_authenticated: pi harness not detected (pi_native_impersonation_blocked)`. | An agent with no `harness:` (so Pi) names a native vendor as its provider. | Set the native harness (`harness: grok` for `provider: xai`) and re-run `kxm init --dry-run`. |
| `grok_not_authenticated: grok harness not detected (harness_unhosted_model)`, or `harness grok does not host provider openrouter`. | A native-harness agent was given an aggregator or another vendor's selector, often from a mixed role roster. | Give that selector its own agent with `harness:` omitted. |
| `pi brake: xai has a native harness; refusing Pi impersonation` (dev helper) | A dev-helper request routed a native vendor through Pi. | Use the native harness recipe instead: `just impl`, `just plan`, `just review-arch` or `just review-cli`. |
| `Roster policy refused: native vendor cannot use Pi` | A `.kxm/roster.yaml` Pi route names a native vendor, as in `openrouter/x-ai/…` or `nous-portal/anthropic/…`. | Remove the route. Only a native harness route is valid for that vendor. |
| `routing report` shows every attempt under `Unk*`, and records carry `costBasis: unknown`. | Grok and every Pi route are recorded as `unknown` today. That is the design, not a missing price. | Nothing to fix per run. Compare quality and latency, and use list estimates for cost. |
| `providerMetadata.priceCatalogStale: true`, and there is no `listCostUsd`. | `.kxm/prices.yaml` is not dated today, or no row has a matching `provider` (`xai` does not price `openrouter/x-ai/…`). | Make a Git-reviewed edit to `.kxm/prices.yaml`: add a row for the route's provider, then update `date` and `sha256`. The loader refuses a hash mismatch (`plugins/kxm/src/prices.ts:120`). `kxm routing report --equivalent-list-cost` reads the catalog without the date gate. |
| `kxm routes admit --model <id> --dry-run` prints `select a model from the refreshed inventory`. | The id is not in `.kxm/models/inventory.yaml`, either because the inventory is stale or because the id is a selector the inventory never carries, such as `openrouter/…`. | Refresh with `kxm models refresh`. If the id still is not listed, admit it by a Git-reviewed edit. |
| A model your harness lists is missing from the inventory (for example `grok models` shows `grok-4.7`), or the inventory has ids like `You` and `Default`. | The inventory is from `2026-09-16`, and the `grok models` parser takes the first word of each line (`plugins/kxm/src/model-inventory.ts:103-109`). | Run `kxm models refresh`, then check the harness's own list (`grok models`). Do not treat inventory rows as auth or dispatch evidence (`plans/implementation-plan.md:2115-2116`). |

The fix commands referenced in the table:

```bash
claude auth login
```

```bash
codex login
```

```bash
grok login --oauth
```

```bash
grok models
```

```bash
pi auth check --provider nous-portal --json --no-refresh
```

```bash
pi list
```

```bash
pi --list-models nous-portal
```

```bash
kxm routes admit --model <id>
```

```bash
kxm models refresh
```

```bash
kxm routing report --equivalent-list-cost
```

```bash
just impl brief.md
```

## Where the code is looser than the rules

These are gaps between the rules in section "The rules this guide applies" and what the code enforces. Until they close, the rule is what you follow.

- **The product brake reads only the first segment.** `PI_NATIVE_BRAKE_PROVIDERS` (`plugins/kxm/src/harness.ts:130-137`) refuses `anthropic/…` but not `openai-codex/…`, `kimi-coding/…`, `claude-bridge/…`, `openrouter/<native vendor>/…` or `antigravity/claude-…`. Only the developer roster checks the vendor segment (`scripts/roster-policy.mjs:130-136`). In the product runtime, admission is the only backstop.
- **`PI_ALLOWED_PROVIDERS` in `plugins/kxm/src/harness.ts:122-127` is exported but gates nothing.** The dev helper's allowlist in `scripts/harness-run.mjs:76` is a different list: `openrouter`, `nous-portal` and `antigravity`.
- **The long-lived worker has no brake.** `kxm agent worker --model` and `--fallback-models` pass straight to Pi. The worker example in `docs/configuration.md:255-258` uses `--fallback-models xai/grok-4.6`, which is Pi's `xai` provider. Do not copy that example for a native vendor.
- **Config load checks harness/model pairs only for agents that declare `harness:`** (`plugins/kxm/src/project-config.ts:1151-1161`). An agent that omits `harness:` and names `provider: xai` passes `kxm init --dry-run` and fails only at dispatch.
