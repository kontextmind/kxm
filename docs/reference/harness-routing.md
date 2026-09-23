# Harness routing: native harness or Pi aggregator

This page is the reference for how KXM chooses a route, the harness and model selector that run an agent step, and how to check which route a run actually used. Use it to choose between a vendor's native harness (`claude`, `codex`, `grok`, `agy`, `kimi` or `deepseek`) and Pi with a provider prefix such as `openrouter/…` or `nous-portal/…`. Field meanings are in the [configuration file reference](config-reference.md), and your project's admitted routes are in `.kxm/routes.yaml` (see [`kxm routes`](cli-reference.md#kxm-routes)).

## Routing rules

These are KXM's routing rules. The code enforces them in layers: [What the brake refuses](#what-the-brake-refuses) shows where each layer sits, and [Where the code is looser than the rules](#where-the-code-is-looser-than-the-rules) lists the gaps.

- **Native harness first.** If the model's provider has its own harness and that harness is **installed and logged in**, use it, not Pi's copy of the same provider.
- **Fail closed, never cross-bill.** If the native harness is missing or logged out, do **not** silently bill through Pi's other-provider key: fail closed or ask to log in. Never bill one vendor through another harness.
- **Aggregators are Pi providers.** Aggregators are Pi *providers*, not a second coding harness. Each one is used only after a fail-closed `pi auth check --provider <id>`.
- **Same model, prefer the subscription.** Prefer an authenticated native subscription for the same model.
- **Quota exhaustion is not a license to cross-bill.** Take the **next best** authenticated option by quality, then cost, from the report, not a silent Pi API key for the same vendor.
- **A harness is not a model, and it is not a worker.** A harness runs only the models it hosts. Only Pi is a long-lived worker. `grok` and `agy` are one-shot CLIs.
- **Admission is a decision, not a config tweak.** A route that is not admitted is refused. Admit one precise selector, such as `openrouter/qwen/qwen3-coder-plus`, never a whole provider.

## 1. Decision procedure: "I want model X"

1. **Name the vendor of X.** The vendor is the lab that trained the model, not whoever bills you for it. `x-ai/grok-4.6` is xAI. `qwen/qwen3-coder-plus` is Alibaba. `z-ai/glm-5.3` is Z.ai.
2. **Check whether the vendor has a native harness.** KXM maps `anthropic→claude`, `openai→codex`, `xai→grok`, `google→agy`, `moonshot→kimi` and `deepseek→deepseek`. Google is an exception (section 4). If the vendor is not in this list, go to step 6.
3. **Check that the native harness is installed and logged in.** In `kxm harness list`, the row must show `detected yes`, `auth yes` and `dispatch yes`. `no` and `unknown` are never eligible.
4. **Check that the harness hosts X.** `claude` runs only Anthropic models. `grok` runs only `grok-*`. `agy` runs only `gemini-*`. `kimi` runs only `kimi-*` or `moonshot-*`. `deepseek` runs only `deepseek-*`. `codex` refuses other vendors' model prefixes. To see the exact ids, use the harness's own catalog: `grok models`, `agy models` or `kimi provider list`.
5. **If steps 3 and 4 pass, use the native harness.** Do not use Pi's copy of that vendor. That rules out a direct Pi provider for the vendor (`anthropic/…`, `xai/…`, `google/…`), Pi's subscription providers (`openai-codex/…`, `kimi-coding/…`, `claude-bridge/…`) and any aggregator path to the vendor (`openrouter/<vendor>/…`, `nous-portal/<vendor>/…`).
   - If step 3 fails, ask the operator to log in, or fail closed.
   - If the subscription is exhausted, move to the next eligible entry in the role roster. That entry must be a different route, not the same vendor through Pi.
   - Go to step 8.
6. **If the vendor has no native harness, use Pi with a provider prefix.** Prefer the vendor's own plan provider when Pi has one authenticated, for example `qwen-token-plan/…` or `zai-coding-cn/…`. Otherwise use an allowlisted aggregator: `openrouter/…` or `nous-portal/…`.
7. **Check Pi readiness for that exact provider.** `pi auth check` must report `ready`. KXM runs this check itself before every Pi dispatch.
8. **Confirm admission before you dispatch.** The selector must be under `admitted` in `.kxm/routes.yaml` and not under `disabled`. If `.kxm/roles/<role>.yaml` exists, the selector must also be in that roster. If the route is not admitted, stop: admission is a reviewed project decision, recorded in `.kxm/routes.yaml`.

| Vendor has a native harness? | Native harness in `kxm harness list` | Harness hosts X? | Route KXM should take |
|---|---|---|---|
| Yes | detected, auth `yes`, dispatch `yes` | Yes | The native harness. Never Pi or an aggregator for this vendor. |
| Yes | detected, auth `yes` | No | No route for X in this harness. Choose another model. |
| Yes | auth `no` or `unknown`, or not detected | — | Fail closed. The operator logs in. Do not fall back to OpenRouter, Nous or Pi's own provider. |
| Yes, but the subscription is exhausted | auth `yes` | Yes | The next eligible roster route by quality, then cost. Record the exhaustion. Not the same vendor through Pi. |
| No (Qwen, GLM and others) | — | — | Pi with the vendor-plan provider or an allowlisted aggregator, after `pi auth check` reports `ready`. |
| Google | — | — | Exception: see section 4 for the `antigravity` Pi provider and what the code does today. |
| Anthropic through `claude-bridge` | — | — | Experiment only. Never a writer. |

Every row still has to pass step 8. The commands for the steps above:

```bash
# Which harnesses are installed, signed in and dispatchable
kxm harness list
# Pi readiness for one provider, without refreshing OAuth credentials
pi auth check --provider openrouter --json --no-refresh
# Admitted and disabled routes
kxm routes list
# One role's roster
kxm role get writer
```

Example `kxm harness list` output from one machine (your rows differ):

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

`pi unknown (auth_context_required)` is expected. Pi has no single login, so its readiness is checked per provider. `kxm harness list --json` adds `authMethod`: `ChatGPT` for codex, `claude.ai` or `api-key` for claude, and `antigravity-oauth` for agy. `authMethod` decides whether KXM records a run as `unmetered` (section 2).

Here is how KXM probes each harness:

| Harness | Vendor | Probe KXM runs | Counts as logged in when |
|---|---|---|---|
| `claude` | anthropic | `claude auth status` | The JSON has `"loggedIn": true`. |
| `codex` | openai | `codex login status` | Output has `Logged in using ChatGPT`. An API-key login also counts, but adds issue `auth_api_key`. |
| `grok` | xai | `grok models` | Output has the line `You are logged in with grok.com.` |
| `agy` | google | `agy models` | Output lists model rows as `id<TAB>label`. |
| `kimi` | moonshot | `kimi provider list` | Output has `managed:kimi`, `type=kimi` or `Default model:`. |
| `deepseek` | deepseek | none | Never. Auth is always `unknown`, and a detected `deepseek` shows `dispatch no (permission_profile_unaudited)`. |
| `pi` | per provider | `pi auth check --model <provider>/<model> --json` | The JSON has `"status":"ready"`. |

`pi auth check` refreshes expired OAuth credentials unless you pass `--no-refresh`. Use `--no-refresh` when you only want to look. KXM's own probe does not pass it.

To see what KXM sees, run the probes yourself. They are read-only, and the model-listing ones double as each harness's catalog:

```bash
kxm harness list --json
claude auth status
codex login status
grok models
agy models
kimi provider list
pi auth check --model openrouter/qwen/qwen3-coder-plus --json --no-refresh
```

## 2. Which route will a config line use?

### How KXM builds a route

- **Selector.** The selector is `<model.provider>/<model.model>`, taken from the agent YAML. The provider must not contain `/`. The model id may, for example `qwen/qwen3-coder-plus` under `openrouter`.
- **Harness.** The harness is the agent's `harness:`, or the project's `defaultHarness` (Pi) when the agent omits it. The selector string does not choose the harness, and neither does a roster entry.
- **Admission.** The selector must be admitted, and it must be in the role roster when that role file exists. Agent id `implementer` maps to role `writer`.
- **Dispatch probe.** Before spawning anything, the producer probes the exact harness, provider and model triple. It refuses unhosted pairs and the Pi brake.
- **Effort.** The Runtime sets the thinking effort per attempt: the first attempt of a step runs at `low`, and any later attempt of the same step at `medium`. The live producer passes it as `--effort` to `claude`, as `model_reasoning_effort` to `codex` and as `--reasoning-effort` to `grok`. `agy`, `kimi` and `pi` get no effort flag. A roster entry's `effort` is display-only.

### Agent YAML

This is the native route, from `.kxm/agents/implementer.yaml`:

```yaml
harness: grok
model:
  provider: xai
  model: grok-4.6
```

The selector is `xai/grok-4.6` and the harness is `grok`. The live one-shot producer spawns `grok --model grok-4.6 … --output-format json --single <prompt>`.

This is the same model through Pi and OpenRouter:

```yaml
# harness omitted: Pi
model:
  provider: openrouter
  model: x-ai/grok-4.6
```

The selector is `openrouter/x-ai/grok-4.6` and the harness is `pi`. Pi is spawned with `--model openrouter/x-ai/grok-4.6`, its read-only flags (section 3) and `-p --mode json`. Write `model.model` exactly as the provider names it. For OpenRouter that is the vendor slug, so `x-ai`, not `xai`.

The harness and the selector have to agree. Pi refuses `provider: xai`. `grok` refuses `provider: openrouter`. [What the brake refuses](#what-the-brake-refuses) has the exact messages.

### Role roster entries

A role file lists the selectors a role may run. For example, `.kxm/roles/writer.yaml`:

```yaml
schema: kxm.role.v1
id: writer
roster:
  - model: xai/grok-4.6
    enabled: true
  - model: openrouter/qwen/qwen3-coder-plus
    enabled: true
```

Every roster entry is a selector. When the engine checks the roster, it reads only `model`. The role schema accepts a `harness:` key on an entry, but dispatch never reads it: the harness still comes from the agent that runs the step. `kxm role list` prints the first entry as `(harness:xai/grok-4.6)`; there, "harness" is a placeholder label, not a harness.

The consequence matters when a roster mixes routes, as this one does. If the implementer agent declares `harness: grok`, only `xai/grok-4.6` can run under it. Under that agent, a Pi selector fails closed with `grok_not_authenticated: grok harness not detected (harness_unhosted_model)`. To run a Pi selector, create a separate agent with `harness:` omitted. The engine does not walk the roster to fail over on its own.

### Route ids in `.kxm/routes.yaml`

`kxm routes list` prints one line per decision, for example:

```text
admitted openrouter/qwen/qwen3-coder-plus
admitted xai/grok-4.6
disabled openrouter/x-ai/grok-4.6
```

The first segment of an id is the provider, and the rest is the model id. A route id does not name a harness. The first segment tells you which harness can run it:

| Selector prefix | What it is | Harness that can run it |
|---|---|---|
| `anthropic/` | Anthropic, native | `claude` only. Pi brakes it. |
| `openai/` | OpenAI, native | `codex` only. Pi brakes it. |
| `xai/` | xAI, native | `grok` only. Pi brakes it. |
| `google/` | Google, native | `agy` only. Pi brakes it. |
| `moonshot/` | Moonshot, native | `kimi` only. Pi brakes it. |
| `deepseek/` | DeepSeek, native | `deepseek` only, which is never eligible. |
| `openrouter/` | OpenRouter credit | `pi` |
| `nous-portal/`, `nous/`, `nous-proxy/` | Nous Research | `pi`, through a Pi package or the KXM Pi extension |
| `antigravity/` | Google subscription through Pi | `pi`, through the KXM Pi extension |
| `claude-bridge/` | Claude subscription through Pi | `pi`, through the KXM Pi extension. Experiment only. |
| `qwen-token-plan/`, `zai-coding-cn/` | Vendor-plan API key configured in Pi | `pi` |
| `openai-codex/`, `kimi-coding/` | Pi's own copy of a native subscription | Do not use. See the GPT-5.6 Sol example and the last section. |

`kxm routes admit --model <id>` only takes an id that exists in `.kxm/models/inventory.yaml`. The inventory is a different namespace from these selectors (next section), and it never carries an `openrouter/…` selector, so a dry run refuses one:

```bash
kxm routes admit --model openrouter/qwen/qwen3-coder-plus --dry-run
```

```text
select a model from the refreshed inventory
```

It exits with code 2. A bare OpenRouter slug is accepted, but it is not a dispatchable selector:

```bash
kxm routes admit --model x-ai/grok-4.6 --dry-run
```

```text
would admit x-ai/grok-4.6
```

If that id were admitted, an agent would need `provider: x-ai`. Pi has no provider called `x-ai`, so the Pi auth probe would fail closed. When a route needs a provider prefix that the inventory does not carry, admit it by a Git-reviewed edit of `.kxm/routes.yaml`, after the admission decision is reviewed.

### Three namespaces that look alike

The same model shows up under different ids depending on the file:

| Where | Id for Grok 4.6 | What that id means |
|---|---|---|
| `.kxm/routes.yaml`, agent selector | `xai/grok-4.6` | Provider `xai`. Needs `harness: grok`. |
| `.kxm/routes.yaml`, agent selector | `openrouter/x-ai/grok-4.6` | OpenRouter through Pi. |
| `.kxm/models/inventory.yaml`, source `pi` | `xai/grok-4.6` | Pi's own `xai` provider. The brake refuses it. |
| `.kxm/models/inventory.yaml`, source `openrouter` | `x-ai/grok-4.6` | The OpenRouter catalog slug. The inventory stores OpenRouter ids without an `openrouter/` prefix. |
| `.kxm/prices.yaml` | `id: xai/grok-4.6`, `provider: xai`, alias `x-ai/grok-4.6` | A list price that applies only to provider `xai`, because price lookup filters by provider. |

An inventory id can also mean something else in `.kxm/routes.yaml`. For example, the inventory can list `openai/gpt-5.6-sol` from the OpenRouter feed with OpenRouter prices, while in `.kxm/routes.yaml` the same string means provider `openai` through native `codex`.

### What the brake refuses

| Layer | What it refuses | What you see |
|---|---|---|
| Pi native brake | Pi with provider `anthropic`, `openai`, `xai`, `moonshot`, `google` or `deepseek` | Issue `pi_native_impersonation_blocked`; at dispatch, `pi_not_authenticated: pi harness not detected (pi_native_impersonation_blocked)`. |
| Harness hosting | A native harness given another vendor's provider or model | Issue `harness_unhosted_model`, for example `harness grok does not host provider openrouter`. |
| Config load | The two checks above, only for agents that declare `harness:` and select a model through a profile or tag | A config issue with the same code. A direct `{provider, model}` selector is checked only at dispatch. |
| Product admission | Any selector that is not admitted or not in the role roster | `producer_route_unsupported: model '<selector>' is not admitted`, `… not in role '<role>' roster`, or `producer_route_not_admitted`. |

The Pi brake message reads `pi must not impersonate native provider xai; use the native harness`. The hosting refusal at dispatch reads `grok_not_authenticated: grok harness not detected (harness_unhosted_model)`.

The product brake checks only the first segment of the selector. `validateHarnessModelPair("pi", …)` accepts every one of these ids:

- `openrouter/x-ai/grok-4.6`
- `openrouter/anthropic/claude-fable-5.1`
- `openai-codex/gpt-5.6-sol`
- `kimi-coding/kimi-for-coding`
- `claude-bridge/claude-fable-5`
- `antigravity/claude-sonnet-4-6`

In the product runtime, admission is the only thing that stops these ids. Keep them out of `.kxm/routes.yaml`.

To run the load-time check, which covers only agents that declare a harness and select a profile or tag, run the read-only validation:

```bash
kxm init --dry-run
```

```text
init plan: ready
```

### Confirming after a run

For each attempt, the engine appends a `kxm.routing-record.v2` record inside a `routing.attempt.recorded` run event. To see which route ran, read these fields:

- `harness`: `grok`, `codex`, `claude`, `agy`, `kimi` or `pi`. This is the fastest way to tell native from Pi.
- `provider`: for example `xai`, `openai` or `anthropic` for native routes, and `openrouter` or `qwen-token-plan` for Pi routes.
- `requestedModel`: the model id with the provider stripped, for example `grok-4.6` or `x-ai/grok-4.6`.
- `effectiveModel`: the model the CLI reported. It is `unknown` when the CLI output did not name a model.
- `thinking`: the effort the attempt ran at (`low` or `medium`).
- `costBasis`, `costUsd` and `priceRef`: see the table below.
- `providerMetadata`: `authMethod`; the list estimate `listCostUsd`, or `priceCatalogStale` or `priceCatalogUnavailable` when no estimate was made; and the process-integrity fields below.

The one-shot producer also records how the harness process ended, in `providerMetadata`:

- `processStatus` (`completed`, `failed` or `aborted`), plus `processExitCode` or `processSignal`.
- `processStarted`, `observedChildExit` and `terminationRequested`, which say whether KXM saw the process start and exit, and whether it had to stop it.
- `processError`: one of `process_timeout`, `process_output_limit`, `process_aborted`, `process_stdin_error`, `process_stdio_error`, `process_stdio_unclosed`, `process_exit_unobserved`, or `process_error`.
- `descendantEffects: unverified` when KXM could not confirm that every process the harness started has exited. The attempt then settles as `failed` (or `cancelled` when it was aborted). Check for side effects before you retry.

Today the producers write cost fields like this:

| Route | `costBasis` | `costUsd` | `priceRef` |
|---|---|---|---|
| `claude` with `authMethod: claude.ai` | `unmetered` | `null` | `subscription:claude` |
| `codex` with `authMethod: ChatGPT` | `unmetered` | `null` | `subscription:codex` |
| `agy` with `authMethod: antigravity-oauth` | `unmetered` | `null` | `subscription:agy` |
| `grok`, whose probe sets no `authMethod` | `unknown` | `null` | — |
| `claude` or `codex` with an API key | `unknown` | `null` | — |
| `pi`, any provider (OpenRouter, Nous, plan providers) | `unknown` | `null` | — |

No product producer writes `metered` today. Subscription runs are `unmetered` because a flat plan has no per-call bill. Unmetered is not free, and missing is not zero ([routing contract](../contracts/routing.md)). A list estimate is added to `providerMetadata.listCostUsd` only when all of these hold:

- `.kxm/prices.yaml` has a row whose `provider` matches the route's provider.
- The catalog `date` is today.
- The harness is `claude` and the token counts are complete. The Runtime runs every harness, Pi included, through the one-shot producer, which estimates only for `claude`. The package also ships a long-lived Pi producer that estimates for any provider, but nothing in the Runtime calls it today.

`kxm routing report` groups records by harness, model, effort and role. It ranks routes by quality first (Pass%, then Rwk%), then by cost per accepted attempt. Only a route whose attempts are all unknown-cost ranks last among routes of equal quality. A route that mixes unmetered and unknown-cost attempts shows `$0` per accepted attempt, so it can rank first. Read the `Unm` and `Unk` columns before you trust `$/Acc`.

The `Quota` column counts attempts whose metadata looks quota-exhausted. Nothing fails over on it. The report has no provider column, so the `Harness` column is what tells you native from Pi.

```bash
kxm routing report
```

```text
no routing records in telemetry
```

By default, from inside a KXM project, the report reads the project's Runtime event store first (`<state root>/runtime/projects/<key>/run-events.db`, read-only) and then `.kxm/logs/telemetry.jsonl`, so live `kxm run` attempts appear without an export. Each checkout reads only its own store.

Attempts from simulated drives are excluded, so an empty report after a simulated drive is expected. A Runtime attempt counts toward Pass% only when its run completed without the step being re-entered; a cancelled or still-running run leaves its attempts undecided. `--json` lists what was read under `sources`; the text output does not. `--file` reads only the named JSONL, which may hold `routing.attempt.recorded` events; the Runtime serves a run's events at `GET /v1/runs/<runId>/events`.

```bash
kxm routing report --json
kxm routing report --file ./run-events.jsonl --equivalent-list-cost
```

## 3. Examples: the same model, two routes

Each example shows the agent YAML for the native route and for the same model through Pi, and which one the rules pick. Whether a route is admitted is in your `.kxm/routes.yaml`. List prices and context sizes are in `.kxm/models/inventory.yaml` after `kxm models inventory-refresh`, and `pi --list-models` shows context, max output, thinking and image support per model. A provider missing from `pi --list-models` usually has no credentials, which is itself a readiness hint.

### How the live producer runs each harness

The live one-shot producer runs every harness read-only, with a 120-second process timeout. These are the flags it adds:

| Harness | Read-only flags |
|---|---|
| `claude` | `--tools Read,Glob,Grep --restricted --safe-mode --permission-mode plan --permission-prompts none --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --no-session-persistence` |
| `codex` | `--sandbox read-only --ignore-user-config -c approval_policy="never"` |
| `grok` | `--sandbox read-only --permission-mode plan --tools Read,Glob,Grep --no-subagents --disable-web-search` |
| `agy` | `--mode plan --sandbox --disable-slash-commands` |
| `kimi` | `--plan` |
| `pi` | `--no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-session` |
| `deepseek` | None audited, so the producer refuses it (`permission_profile_unaudited`) |

The Runtime does not run a step live when it has `write` access to a repository; it hands the run off with `step_unsupported`. Only Pi runs as a long-lived worker.

### Grok 4.6

| | Native `grok` | Pi + OpenRouter |
|---|---|---|
| Agent YAML | `harness: grok`, `provider: xai`, `model: grok-4.6` | `harness:` omitted, `provider: openrouter`, `model: x-ai/grok-4.6` |
| Selector | `xai/grok-4.6` | `openrouter/x-ai/grok-4.6` |
| Billing | grok.com subscription (OAuth) | OpenRouter credit |
| Recorded `costBasis` | `unknown` | `unknown`, and no list estimate, because a price row for `xai` does not match provider `openrouter` |
| Mode | One-shot `grok --single`. Not a worker. | One-shot `pi -p --mode json`, or a long-lived Pi worker |

**KXM picks the native route.** xAI has a native harness. If `grok` is logged out, fail closed and have the operator run `grok login --oauth`. Pi's own `xai` provider can report `ready` (OAuth), and that is exactly what the brake exists to refuse. When the grok quota runs out, the next route is a different vendor's roster entry, not the OpenRouter copy of Grok.

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
| Selector | `openai/gpt-5.6-sol` | `openrouter/openai/gpt-5.6-sol` |
| Readiness | Needs `codex` auth `yes` with `authMethod: ChatGPT` | Needs `pi auth check --provider openrouter` to report `ready` |
| Billing | ChatGPT subscription | OpenRouter credit |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:codex` | `unknown` |
| Mode | One-shot `codex exec --json -` | Pi |

**KXM picks the native route.** Two traps apply here. The first is `openai-codex/gpt-5.6-sol`, which is the same ChatGPT subscription driven through Pi. `pi auth check --provider openai-codex` can report `ready`, and the product brake does not catch that provider id, so do not admit it. The second is a codex login made with an API key: the row shows `API key`, and the run records `unknown`.

```bash
pi auth check --provider openai-codex --json --no-refresh
```

```text
{"status":"ready","provider":"openai-codex","authType":"oauth"}
```

A larger context window on the OpenRouter route does not make OpenRouter an allowed route. If a task needs more than the subscription route holds, raise an admission decision.

### Claude Fable

| | Native `claude` | Pi + OpenRouter |
|---|---|---|
| Agent YAML | `harness: claude`, `provider: anthropic`, `model: fable` | `harness:` omitted, `provider: openrouter`, `model: anthropic/claude-fable-5.1` |
| Selector | `anthropic/fable` | `openrouter/anthropic/claude-fable-5.1` |
| Billing | claude.ai subscription | OpenRouter credit |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:claude`, plus a list estimate when `prices.yaml` has an `anthropic` row dated today | `unknown` |
| Mode | One-shot `claude -p --output-format json` | Pi |

**KXM picks the native route, and fails closed when `claude` is logged out.** Pi's `anthropic` provider may report `ready`, and OpenRouter lists the same model. Neither may stand in. This is the motivating case for the whole rule. The operator runs `claude auth login`, and the run waits until then.

### Gemini 3.8 Flash

| | Native `agy` | `antigravity` Pi provider | Pi + OpenRouter |
|---|---|---|---|
| Agent YAML | `harness: agy`, `provider: google`, `model: gemini-3.8-flash-high` | `harness:` omitted, `provider: antigravity`, `model: gemini-3.8-flash` | `harness:` omitted, `provider: openrouter`, `model: google/gemini-3.8-flash` |
| Selector | `google/gemini-3.8-flash-high` | `antigravity/gemini-3.8-flash` | `openrouter/google/gemini-3.8-flash` |
| Readiness | Needs `agy` auth `yes` (`antigravity-oauth`) | Registered only inside the KXM Pi extension. From a plain shell, `pi auth check --provider antigravity` returns `provider_not_found`. | Needs `pi auth check --provider openrouter` to report `ready` |
| Billing | Google subscription | Google subscription | OpenRouter credit |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:agy` | `unknown` | `unknown` |
| Effort | Part of the id: `-high`, `-medium` or `-low` | A thinking level: `low`, `medium` or `high` | The provider's reasoning parameter |

**Never OpenRouter for Gemini.** The Runtime can run the `agy` selector today; section 4 explains why it cannot reach `antigravity/…`.

```bash
pi auth check --provider antigravity --json --no-refresh
```

```text
{"status":"not_ready","provider":"antigravity","reason":"provider_not_found"}
```

## 4. Exceptions, and when OpenRouter is the right answer

### Google through the `antigravity` Pi provider

Google is the one native vendor whose preferred subscription route is a Pi provider: `antigravity/gemini-…`, which reuses a Google subscription login. It applies only to Gemini ids and needs a signed-in `/login antigravity` inside Pi. Never use OpenRouter or Nous for Gemini.

The code today limits where that route can run:

- Pi brakes the `google` provider, so a `google/gemini-…` selector can run only through `agy`.
- The KXM Pi extension registers the `antigravity` provider. The Runtime's Pi one-shot runs with `--no-extensions`, so it cannot reach `antigravity/…`.
- Only an interactive Pi with KXM loaded, or a long-lived Pi worker, can use it.

Admit an `antigravity/…` route only through a reviewed admission decision.

### Claude bridge: experiment only

`claude-bridge` is a Pi provider, vendored into KXM and registered by the KXM Pi extension, that reuses the Claude subscription login. It runs Anthropic models through Pi, which the native-harness rule forbids for normal work, so treat it as an experiment and never as a writer. The product brake does not refuse `claude-bridge/…`, so keep it out of `.kxm/routes.yaml` unless an experiment is admitted.

### Vendors with no native harness

Pi is the right harness when the vendor has no native harness in KXM, for example Qwen (Alibaba) and GLM (Z.ai). The choice is then between the vendor's own plan provider in Pi and an aggregator:

- Prefer the vendor-plan provider when `pi auth check` reports it `ready`, for example `qwen-token-plan/qwen3.8-flash` or `zai-coding-cn/glm-5.3`.
- Otherwise use an aggregator selector, such as `openrouter/qwen/qwen3-coder-plus`.
- Admit the exact selector, with the permission it needs, never a whole provider.

DeepSeek has a native harness entry, but it is never eligible: its auth is always `unknown`, and it has no audited read-only profile. A DeepSeek model billed through another vendor's plan, such as `qwen-token-plan/deepseek-…`, is an admission question, not a precedent.

### Nous

Nous is reachable through three Pi providers. The same native-vendor rule applies to all of them.

- **`nous-portal/…`** comes from the third-party Pi package `@jayteelabs/pi-nous-portal-provider`. Log in with `/login` inside Pi, or set `NOUS_API_KEY`. It bills the Portal, not OpenRouter. Check live ids with `pi --list-models nous-portal` before you use them.
- **`nous/…`** is the direct API, and **`nous-proxy/…`** is the Hermes subscription proxy. Both are opt-in through `KXM_NOUS_PROVIDERS`, and both are registered by the KXM Pi extension. They carry no writer or router admission; see [Nous providers](../guides/nous-providers.md).
- The Portal also hosts `anthropic/…`, `openai/…`, `x-ai/…` and `google/…` models. Those are native vendors, so do not route them through the Portal, just as you would not route them through OpenRouter.

This installs the Portal provider:

```bash
pi install npm:@jayteelabs/pi-nous-portal-provider
```

### When OpenRouter is the right answer

- The vendor has no native harness in KXM, no authenticated vendor-plan provider carries the model, and the exact `openrouter/<vendor>/<model>` selector is admitted.
- A bounded side-by-side experiment on a non-native vendor, where every arm is recorded in routing telemetry.

OpenRouter is **not** the answer in any of these cases:

- A native vendor whose harness is logged out.
- A native vendor whose subscription is exhausted.
- A native vendor listed at a lower price.
- A larger context window on a native vendor's model.

Each of those is a fail-closed stop, or a new admission decision.

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `claude … auth no … dispatch no (not_authenticated)`, or a run fails with `claude_not_authenticated`. | The native harness is logged out. | Run `claude auth login`, then `kxm harness list`. Do not switch to `openrouter/anthropic/…` or Pi's `anthropic/…`. |
| The codex row shows `API key`, or runs record `unknown` instead of `unmetered`. | `codex` is logged in with an API key, not ChatGPT. | Run `codex login` with the ChatGPT flow. |
| `grok` shows auth `unknown (auth_unparsed)`. | `grok models` did not print `You are logged in with grok.com.` | Run `grok login --oauth`, then `grok models`. |
| `pi` shows `unknown (auth_context_required)`. | This is normal. Pi auth is checked per provider. | Run `pi auth check --provider <id> --json --no-refresh` for the provider you need. |
| `pi auth check --provider openrouter` returns `not_ready` with `credentials_not_configured` and exits 1. | No OpenRouter credential where Pi or the Runtime starts. | Run `/login openrouter` inside Pi, or export `OPENROUTER_API_KEY` where the Runtime starts. Then re-check. |
| `pi auth check --provider nous-portal` or `--provider antigravity` returns `provider_not_found`. | The provider comes from a Pi package or the KXM Pi extension, which that process did not load. | Confirm with `pi list` and `pi --list-models <id>`. The Runtime's Pi one-shot runs with `--no-extensions`, so it cannot reach extension providers. |
| `producer_route_unsupported: model '<selector>' is not admitted`, or `producer_route_not_admitted`. | The selector is missing from `admitted` in `.kxm/routes.yaml`, or it is under `disabled`. | Check with `kxm routes list`. After a reviewed decision, run `kxm routes admit --model <id>`, or edit the file when the inventory lacks the id. |
| `producer_route_unsupported: model '<selector>' not in role '<role>' roster` | The role file exists and does not list the selector. | Add it to `.kxm/roles/<role>.yaml` by Git review, and check with `kxm role get <role>`. |
| `pi must not impersonate native provider xai`, or `pi_native_impersonation_blocked` at dispatch. | An agent with no `harness:` (so Pi) names a native vendor as its provider. | Set the native harness (`harness: grok` for `provider: xai`) and re-run `kxm init --dry-run`. |
| `grok_not_authenticated: grok harness not detected (harness_unhosted_model)`, or `harness grok does not host provider openrouter`. | A native-harness agent was given an aggregator or another vendor's selector, often from a mixed role roster. | Give that selector its own agent with `harness:` omitted. |
| `routing report` shows every attempt under `Unk*`, and records carry `costBasis: unknown`. | Grok and every Pi route are recorded as `unknown` today. That is the design, not a missing price. | Nothing to fix per run. Compare quality and latency, and use list estimates for cost. |
| `providerMetadata.priceCatalogStale: true`, and there is no `listCostUsd`. | `.kxm/prices.yaml` is not dated today, or no row matches the route's provider. | Edit `.kxm/prices.yaml` by Git review: add a row for the provider, then update `date` and `sha256`. The loader refuses a hash mismatch. |
| `kxm routing report --equivalent-list-cost` shows list prices although runs record `priceCatalogStale`. | The report loads the catalog without the date check, so it can price with a stale catalog. | Check the catalog `date` before you rely on the `ListEquiv($)` column. |
| `kxm routes admit --model <id> --dry-run` prints `select a model from the refreshed inventory`. | The id is not in `.kxm/models/inventory.yaml`: the inventory is stale, or the id is a selector it never carries. | Refresh with `kxm models refresh`. If the id still is not listed, admit it by a Git-reviewed edit. |
| A model your harness lists is missing from the inventory, or the inventory has ids like `You` and `Default`. | The inventory is old, or the `grok models` parser took the first word of a non-model line. | Run `kxm models refresh`, then check the harness's own list. Do not treat inventory rows as auth or dispatch evidence. |

The fix commands referenced in the table:

```bash
claude auth login
codex login
grok login --oauth
grok models
pi auth check --provider nous-portal --json --no-refresh
pi list
pi --list-models nous-portal
kxm routes admit --model <id>
kxm models refresh
kxm routing report --equivalent-list-cost
```

## Where the code is looser than the rules

These are gaps between the [routing rules](#routing-rules) and what the code enforces. Until they close, the rule is what you follow.

- **The product brake reads only the first segment.** `PI_NATIVE_BRAKE_PROVIDERS` refuses `anthropic/…` but not `openai-codex/…`, `kimi-coding/…`, `claude-bridge/…`, `openrouter/<native vendor>/…` or `antigravity/claude-…`. In the product runtime, admission is the only backstop.
- **`PI_ALLOWED_PROVIDERS` is exported but gates nothing.** No product code path checks a Pi provider against an allowlist.
- **The long-lived worker has no brake.** `kxm agent worker --model` and `--fallback-models` pass straight to Pi, so a selector such as `xai/grok-4.6` runs through Pi's own `xai` provider rather than the native `grok` harness. Do not pass a native vendor's Pi provider there.
- **Config load checks harness/model pairs only for agents that declare `harness:` and select their model through a profile or tag.** An agent with a direct `{provider, model}` selector, or one that omits `harness:` and names `provider: xai`, passes `kxm init --dry-run` and fails only at dispatch.

## Related

- [Configuration file reference](config-reference.md): agent, role, route and price files
- [CLI reference](cli-reference.md): `kxm harness`, `kxm routes`, `kxm models` and `kxm routing`
- [Workflow catalog](workflow-catalog.md): dated model candidates per role
- [Nous providers](../guides/nous-providers.md): the opt-in Nous providers for Pi
- [Routing and cost telemetry contract](../contracts/routing.md): the routing record and cost-basis rules
- [Harness routing internals](../contributing/harness-routing-internals.md): how the KXM repository applies these rules to its own routes, roster and developer roster
