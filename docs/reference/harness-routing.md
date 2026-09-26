# Harness routing: native harness or Pi aggregator

This page is the reference for how KXM chooses a route, the harness and model selector that run an agent step, and how to check which route a run actually used. Use it to choose between a vendor's native harness (`claude`, `codex`, `grok`, `agy`, `kimi` or `deepseek`) and Pi with a provider prefix such as `openrouter/…` or `nous-portal/…`. Field meanings are in the [configuration file reference](config-reference.md), and your project's admitted routes are in `.kxm/routes.yaml` (see [`kxm routes`](cli-reference.md#kxm-routes)).

## Routing rules

These are KXM's routing rules. The code enforces them in layers: the Pi native-vendor brake, the harness hosting check and route admission. [What the brake refuses](#what-the-brake-refuses) shows where each layer sits, and [Where the code is looser than the rules](#where-the-code-is-looser-than-the-rules) lists the cases the code still leaves to operator policy.

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
5. **If steps 3 and 4 pass, use the native harness.** Do not use Pi's copy of that vendor. That rules out a direct Pi provider for the vendor (`anthropic/…`, `xai/…`, `google/…`), Pi's subscription providers (`openai-codex/…`, `kimi-coding/…`, `claude-bridge/…`) and any aggregator path to the vendor (`openrouter/<vendor>/…`, `nous-portal/<vendor>/…`). The Pi brake refuses all three.
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

- **Selector.** The selector is `<vendor>/<model>` from the selected `.kxm/models/<route>.yaml`. The agent names a `role`, `.kxm/roles/<role>.yaml` lists route ids, and the chosen roster entry names that model file. The model id may contain `/`, for example `openrouter/qwen/qwen3-coder-plus`.
- **Harness.** The harness is the `harness` field on that model file. An agent file does not select it.
- **Admission.** The selector must be admitted. The engine uses the first roster entry whose model file is readable and whose route is admitted.
- **Dispatch probe.** Before spawning anything, the producer probes the exact harness, provider and model triple. It refuses unhosted pairs and the Pi brake.
- **Effort.** The Runtime sets the thinking effort per attempt: the first attempt of a step runs at `low`, and any later attempt of the same step at `medium`. The live producer passes it as `--effort` to `claude`, as `model_reasoning_effort` to `codex` and as `--reasoning-effort` to `grok`. `agy`, `kimi` and `pi` get no effort flag. A roster entry's `effort` is display-only.

### Agent YAML

An agent names a role and nothing else about the route:

```yaml
role: writer
```

`harness` and `model` on an agent file are refused at load (`retired_agent_routing_fields`). A step `model` is refused at load and again at dispatch (`producer_route_unsupported`).

### Model file

This is the native route, from `.kxm/models/grok-native.yaml`:

```yaml
harness: grok
model: grok-4.7
vendor: xai
```

The selector is `xai/grok-4.7` and the harness is `grok`. The live one-shot producer spawns `grok --model grok-4.7 … --output-format json --single <prompt>`.

This is the same vendor through Pi and OpenRouter, which the brake refuses:

```yaml
harness: pi
model: openrouter/x-ai/grok-4.6
vendor: xai
```

The selector is `openrouter/x-ai/grok-4.6` and the harness is `pi`. The Pi brake refuses it before Pi starts, because the vendor segment `x-ai` is xAI, which has a native harness. A vendor with no native harness runs in the same shape: with `model: openrouter/qwen/qwen3-coder-plus`, Pi is spawned with `--model openrouter/qwen/qwen3-coder-plus`, its read-only flags (section 3) and `-p --mode json`. Write `model` exactly as the provider names it. For OpenRouter that is the vendor slug, so `x-ai`, not `xai`.

The harness and the selector have to agree. Pi refuses `provider: xai` and `openrouter/x-ai/…`. `grok` refuses `provider: openrouter`. [What the brake refuses](#what-the-brake-refuses) has the exact messages.

### Role roster entries

A `kxm.role.v2` role file lists route ids, not selectors. Each `roster[].route` is resolved through `.kxm/models/<route-id>.yaml`, which carries `harness`, `model`, `vendor`, `status`, and `permissions`. The entry itself may set `effort` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) and `mode` (`headless`, `interactive`, or `either`). This checkout's writer role is `.kxm/roles/writer.yaml`:

```yaml
schema: kxm.role.v2
id: writer
purpose: writer
permission: edit
description: Primary implementation agent.
# Rotation priority = order. Effort default: medium for implementation.
roster:
  - route: grok-native
    effort: medium
  - route: qwen-openrouter-pi
    effort: medium
  - route: gemini-agy
```

`grok-native` resolves to `.kxm/models/grok-native.yaml`: harness `grok`, model `grok-4.7`, vendor `xai`, status `admitted`, permission `edit`. `qwen-openrouter-pi` is harness `pi`, model `openrouter/qwen/qwen3-coder-plus`, vendor `alibaba`. `gemini-agy` is harness `agy`, model `gemini-3.8-flash-high`, vendor `google`. `kxm role list` prints the first route id as the primary, for example `(grok-native)`.

Dispatch resolves a step from the agent `role`, then `.kxm/roles/<role>.yaml`, then the selected `.kxm/models/<route>.yaml`. That model file carries `harness`, `model`, `vendor`, `status`, and `permissions`. The engine walks the roster in order and uses the first admitted route whose model file is readable. A missing or unreadable model file is a refusal (`roster_model_unreadable` at load, `producer_route_unsupported` at dispatch), not a skip to the next entry. A route file that names a harness the model cannot run on still fails closed with `harness_unhosted_model`.

Role files are what `kxm role` and the Runtime membership check use.

### Route ids in `.kxm/routes.yaml`

`kxm routes list` prints one line per decision, for example:

```text
admitted openrouter/qwen/qwen3-coder-plus
admitted xai/grok-4.6
disabled openrouter/x-ai/grok-4.6
```

The first segment of an id is the provider, and the rest is the model id. A route id does not name a harness. The first segment tells you which harness can run it. For an aggregator, the next segment names the vendor, and the Pi brake reads that too:

| Selector prefix | What it is | Harness that can run it |
|---|---|---|
| `anthropic/` | Anthropic, native | `claude` only. Pi brakes it. |
| `openai/` | OpenAI, native | `codex` only. Pi brakes it. |
| `xai/` | xAI, native | `grok` only. Pi brakes it. |
| `google/` | Google, native | `agy` only. Pi brakes it. |
| `moonshot/` | Moonshot, native | `kimi` only. Pi brakes it. |
| `deepseek/` | DeepSeek, native | `deepseek` only, which is never eligible. |
| `openrouter/` | OpenRouter credit | `pi`, except a native vendor's model such as `openrouter/x-ai/…`, which Pi brakes |
| `nous-portal/`, `nous/`, `nous-proxy/` | Nous Research | `pi`, through a Pi package or the KXM Pi extension. Pi brakes native vendors' models here too. |
| `antigravity/` | Google subscription through Pi | `pi`, through the KXM Pi extension, for `gemini-…` ids only. Pi brakes any other model. |
| `claude-bridge/` | Claude subscription through Pi | None in the product. Pi brakes it; see [Claude bridge](#claude-bridge-experiment-only). |
| `qwen-token-plan/`, `zai-coding-cn/` | Vendor-plan API key configured in Pi | `pi` |
| `openai-codex/`, `kimi-coding/`, `moonshotai/`, `moonshotai-cn/`, `google-vertex/` | Pi's own provider for a native vendor | None. Pi brakes them; use the native harness. |

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
| `.kxm/routes.yaml`, agent selector | `openrouter/x-ai/grok-4.6` | OpenRouter through Pi. The brake refuses it. |
| `.kxm/models/inventory.yaml`, source `pi` | `xai/grok-4.6` | Pi's own `xai` provider. The brake refuses it. |
| `.kxm/models/inventory.yaml`, source `openrouter` | `x-ai/grok-4.6` | The OpenRouter catalog slug. The inventory stores OpenRouter ids without an `openrouter/` prefix. |
| `.kxm/prices.yaml` | `id: xai/grok-4.6`, `provider: xai`, alias `x-ai/grok-4.6` | A list price that applies only to provider `xai`, because price lookup filters by provider. |

An inventory id can also mean something else in `.kxm/routes.yaml`. For example, the inventory can list `openai/gpt-5.6-sol` from the OpenRouter feed with OpenRouter prices, while in `.kxm/routes.yaml` the same string means provider `openai` through native `codex`.

### What the brake refuses

| Layer | What it refuses | What you see |
|---|---|---|
| Pi native brake | Pi running a model whose vendor has a native harness, named directly, through the vendor's Pi provider or behind an aggregator (next table) | Issue `pi_native_impersonation_blocked`; at dispatch, `pi_not_authenticated: pi harness not detected (pi_native_impersonation_blocked)`. |
| Worker start | The same brake, on `--model` and every `--fallback-models` entry, before Pi starts | `kxm agent worker` exits 1 with `pi_native_impersonation_blocked: <message>` on stderr. `--dry-run` does not check. |
| Harness hosting | A native harness given another vendor's provider or model | Issue `harness_unhosted_model`, for example `harness grok does not host provider openrouter`. |
| Config load | The Pi brake and the hosting check, only for agents that declare `harness:` and select a model through a profile or tag | A config issue with the same code. A direct `{provider, model}` selector is checked only at dispatch. |
| Product admission | Any selector that is not admitted or not in the role roster | `producer_route_unsupported: model '<selector>' is not admitted`, `… not in role '<role>' roster`, or `producer_route_not_admitted`. |

The brake runs wherever KXM starts Pi on a model: in the dispatch probe that each producer runs before it spawns a harness, at config load within the limits above, and in `kxm agent worker`. It works out the model's vendor in three ways, and refuses the id when that vendor has a native harness (Anthropic, OpenAI, xAI, Moonshot, Google or DeepSeek):

| How the id names the vendor | Refused examples | Message |
|---|---|---|
| The provider is the vendor | `anthropic/…`, `openai/…`, `xai/…`, `moonshot/…`, `google/…`, `deepseek/…` | `pi must not impersonate native provider xai; use the native harness` |
| A Pi provider that belongs to the vendor | `openai-codex/…`, `moonshotai/…`, `moonshotai-cn/…`, `kimi-coding/…`, `google-vertex/…`, `claude-bridge/…`, and `antigravity/…` except Gemini ids | `pi provider openai-codex bills native vendor openai for gpt-5.6-sol; use the native harness` |
| The vendor segment of an aggregator id, including the aliases `x-ai`, `moonshotai` and `google-ai` | `openrouter/x-ai/grok-4.6`, `openrouter/anthropic/claude-fable-5.1`, `nous-portal/google/…` | `pi must not bill native vendor xai through openrouter; use the native harness` |

The brake accepts `antigravity/gemini-…` and any id whose vendor has no native harness, such as `openrouter/qwen/qwen3-coder-plus`, `zai-coding-cn/glm-5.3` or `qwen-token-plan/qwen3.8-flash`. Passing the brake is not admission: the route must still be admitted. The hosting refusal at dispatch reads `grok_not_authenticated: grok harness not detected (harness_unhosted_model)`.

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

`kxm routing report` groups records by harness, model, effort and role. It ranks routes by quality first (Pass%, then Rwk%), then by cost per accepted attempt. Among routes of equal quality, a route with any unknown-cost attempt ranks after every route without one, because its cost is unknown. Its `$/Acc` prints `-` instead of a partial sum, and the `*` in the `Unk` column marks it. Read `Unm` and `Unk` before you trust `$/Acc`.

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

Each example shows the model file for the native route and for the same model through Pi, and which one the rules pick. For a native vendor, the Pi brake refuses the Pi column; it is shown so that you recognize the id. Whether a route is admitted is in your `.kxm/routes.yaml`. List prices and context sizes are in `.kxm/models/inventory.yaml` after `kxm models inventory-refresh`, and `pi --list-models` shows context, max output, thinking and image support per model. A provider missing from `pi --list-models` usually has no credentials, which is itself a readiness hint.

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
| Model file | `harness: grok`, `model: grok-4.6`, `vendor: xai` | `harness: pi`, `model: openrouter/x-ai/grok-4.6`, `vendor: xai` |
| Selector | `xai/grok-4.6` | `openrouter/x-ai/grok-4.6` |
| Billing | grok.com subscription (OAuth) | OpenRouter credit |
| Recorded `costBasis` | `unknown` | None: the brake refuses it before dispatch |
| Mode | One-shot `grok --single`. Not a worker. | Refused as a one-shot and as a worker model |

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
| Model file | `harness: codex`, `model: gpt-5.6-sol`, `vendor: openai` | `harness: pi`, `model: openrouter/openai/gpt-5.6-sol`, `vendor: openai` |
| Selector | `openai/gpt-5.6-sol` | `openrouter/openai/gpt-5.6-sol` |
| Readiness | Needs `codex` auth `yes` with `authMethod: ChatGPT` | Never reached: the brake refuses it first |
| Billing | ChatGPT subscription | OpenRouter credit |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:codex` | None: refused before dispatch |
| Mode | One-shot `codex exec --json -` | Refused |

**KXM picks the native route.** Two traps apply here. The first is `openai-codex/gpt-5.6-sol`, which is the same ChatGPT subscription driven through Pi. `pi auth check --provider openai-codex` can report `ready`, but readiness is not permission: the brake refuses `openai-codex` as OpenAI's own Pi provider. The second is a codex login made with an API key: the row shows `API key`, and the run records `unknown`.

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
| Model file | `harness: claude`, `model: fable`, `vendor: anthropic` | `harness: pi`, `model: openrouter/anthropic/claude-fable-5.1`, `vendor: anthropic` |
| Selector | `anthropic/fable` | `openrouter/anthropic/claude-fable-5.1` |
| Billing | claude.ai subscription | OpenRouter credit |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:claude`, plus a list estimate when `prices.yaml` has an `anthropic` row dated today | None: refused before dispatch |
| Mode | One-shot `claude -p --output-format json` | Refused |

**KXM picks the native route, and fails closed when `claude` is logged out.** Pi's `anthropic` provider may report `ready`, and OpenRouter lists the same model. Neither may stand in, and the brake refuses both. This is the motivating case for the whole rule. The operator runs `claude auth login`, and the run waits until then.

### Gemini 3.8 Flash

| | Native `agy` | `antigravity` Pi provider | Pi + OpenRouter |
|---|---|---|---|
| Model file | `harness: agy`, `model: gemini-3.8-flash-high`, `vendor: google` | `harness: pi`, `model: antigravity/gemini-3.8-flash`, `vendor: google` | `harness: pi`, `model: openrouter/google/gemini-3.8-flash`, `vendor: google` |
| Selector | `google/gemini-3.8-flash-high` | `antigravity/gemini-3.8-flash` | `openrouter/google/gemini-3.8-flash` |
| Readiness | Needs `agy` auth `yes` (`antigravity-oauth`) | Registered only by the KXM Pi extension. `pi auth check` never loads extensions, so `pi auth check --provider antigravity` returns `provider_not_found`. | Never reached: the brake refuses it (vendor segment `google`) |
| Billing | Google subscription | Google subscription | OpenRouter credit |
| Recorded `costBasis` | `unmetered`, `priceRef: subscription:agy` | `unknown` | None: refused before dispatch |
| Effort | Part of the id: `-high`, `-medium` or `-low` | A thinking level: `low`, `medium` or `high` | — |

**Never OpenRouter for Gemini**, and the brake refuses it. The Runtime can run the `agy` selector today; section 4 explains why it cannot reach `antigravity/…`.

```bash
pi auth check --provider antigravity --json --no-refresh
```

```text
{"status":"not_ready","provider":"antigravity","reason":"provider_not_found"}
```

## 4. Exceptions, and when OpenRouter is the right answer

### Google through the `antigravity` Pi provider

Google is the one native vendor whose preferred subscription route is a Pi provider: `antigravity/gemini-…`, which reuses a Google subscription login. It applies only to Gemini ids, which the brake enforces by refusing `antigravity/claude-…`, and it needs a signed-in `/login antigravity` inside Pi. Never use OpenRouter or Nous for Gemini.

The code today limits where that route can run:

- Pi brakes the `google` and `google-vertex` providers, so a `google/gemini-…` selector can run only through `agy`.
- The KXM Pi extension registers the `antigravity` provider. The Runtime's Pi one-shot runs with `--no-extensions`, and its readiness check, `pi auth check`, never loads extensions, so it cannot reach `antigravity/…`.
- Only an interactive Pi with KXM loaded, or a long-lived Pi worker, can use it.

Admit an `antigravity/…` route only through a reviewed admission decision. The guided setup in `kxm init` does not admit one: it skips every Google guide candidate, so a role falls to its next reviewed candidate or is not written. Whether Google work should use `agy` or `antigravity` today is still an operator decision; see [Where the code is looser than the rules](#where-the-code-is-looser-than-the-rules).

### Claude bridge: experiment only

`claude-bridge` is a Pi provider, vendored into KXM and registered by the KXM Pi extension, that reuses the Claude subscription login. It runs Anthropic models through Pi, which the native-harness rule forbids for normal work, so treat it as an experiment and never as a writer. The Pi brake refuses `claude-bridge/…` on every product path, Runtime dispatch and `kxm agent worker` alike, even when the route is admitted. Only a model that a person selects inside an interactive Pi session escapes the brake. A product-path experiment would need its own, role-aware admission decision.

### Vendors with no native harness

Pi is the right harness when the vendor has no native harness in KXM, for example Qwen (Alibaba) and GLM (Z.ai). The choice is then between the vendor's own plan provider in Pi and an aggregator:

- Prefer the vendor-plan provider when `pi auth check` reports it `ready`, for example `qwen-token-plan/qwen3.8-flash` or `zai-coding-cn/glm-5.3`.
- Otherwise use an aggregator selector, such as `openrouter/qwen/qwen3-coder-plus`.
- Admit the exact selector, with the permission it needs, never a whole provider.

DeepSeek has a native harness entry, but it is never eligible: its auth is always `unknown`, and it has no audited read-only profile. A DeepSeek model billed through another vendor's plan, such as `qwen-token-plan/deepseek-…`, passes the brake because its id names no vendor segment. It is an admission question, not a precedent.

### Nous

Nous is reachable through three Pi providers. The same native-vendor rule applies to all of them.

- **`nous-portal/…`** comes from the third-party Pi package `@jayteelabs/pi-nous-portal-provider`. Log in with `/login` inside Pi, or set `NOUS_API_KEY`. It bills the Portal, not OpenRouter. Check live ids with `pi --list-models nous-portal` before you use them.
- **`nous/…`** is the direct API, and **`nous-proxy/…`** is the Hermes subscription proxy. Both are opt-in through `KXM_NOUS_PROVIDERS`, and both are registered by the KXM Pi extension. They carry no writer or router admission; see [Nous providers](../guides/nous-providers.md).
- The Portal also hosts `anthropic/…`, `openai/…`, `x-ai/…` and `google/…` models. Those are native vendors, so do not route them through the Portal, just as you would not route them through OpenRouter. The brake refuses those Portal ids.

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
| `claude … auth no … dispatch no (not_authenticated)`, or a run fails with `claude_not_authenticated`. | The native harness is logged out. | Run `claude auth login`, then `kxm harness list`. Do not switch to `openrouter/anthropic/…` or Pi's `anthropic/…`, which the brake refuses. |
| The codex row shows `API key`, or runs record `unknown` instead of `unmetered`. | `codex` is logged in with an API key, not ChatGPT. | Run `codex login` with the ChatGPT flow. |
| `grok` shows auth `unknown (auth_unparsed)`. | `grok models` did not print `You are logged in with grok.com.` | Run `grok login --oauth`, then `grok models`. |
| `pi` shows `unknown (auth_context_required)`. | This is normal. Pi auth is checked per provider. | Run `pi auth check --provider <id> --json --no-refresh` for the provider you need. |
| `pi auth check --provider openrouter` returns `not_ready` with `credentials_not_configured` and exits 1. | No OpenRouter credential where Pi or the Runtime starts. | Run `/login openrouter` inside Pi, or export `OPENROUTER_API_KEY` where the Runtime starts. Then re-check. |
| `pi auth check --provider nous-portal` or `--provider antigravity` returns `provider_not_found`. | The provider comes from a Pi package or the KXM Pi extension, and `pi auth check` never loads extensions, not even one passed with `-e`. | Confirm with `pi list` and `pi --list-models <id>`. The Runtime's Pi one-shot runs with `--no-extensions` and checks readiness with `pi auth check`, so it cannot reach extension providers. |
| `producer_route_unsupported: model '<selector>' is not admitted`, or `producer_route_not_admitted`. | The selector is missing from `admitted` in `.kxm/routes.yaml`, or it is under `disabled`. | Check with `kxm routes list`. After a reviewed decision, run `kxm routes admit --model <id>`, or edit the file when the inventory lacks the id. |
| `producer_route_unsupported: model '<selector>' not in role '<role>' roster` | The role file exists and does not list the selector. | Add it to `.kxm/roles/<role>.yaml` by Git review, and check with `kxm role get <role>`. |
| `pi_native_impersonation_blocked`, at dispatch or when a worker starts. | A Pi agent or worker names a native vendor's model: directly, through that vendor's Pi provider, or behind an aggregator. | Use the native harness (`harness: grok` for `provider: xai`), or an admitted Pi route whose vendor has no native harness, such as `openrouter/qwen/qwen3-coder-plus`. |
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

These are places where the code decides less than the [routing rules](#routing-rules) say. Each one is an open operator policy question, not a defect with an obvious fix. Until it is decided, follow the rule.

- **Reseller ids without a vendor segment.** Pi also serves native vendors' models under a reseller's own provider id, for example `github-copilot/claude-…`, `amazon-bedrock/anthropic.…` or `azure-openai-responses/gpt-…`. The brake reads the provider and the vendor segment, not the model name, so it accepts these ids. Keep them out of `.kxm/routes.yaml`.
- **Open-weight models on a third-party plan.** A DeepSeek model billed through Alibaba's plan, such as `qwen-token-plan/deepseek-v4.1-flash`, passes the brake although DeepSeek is a braked vendor. The reverse also happens: an open-weight model filed under a native vendor's namespace, such as `groq/openai/gpt-oss-120b`, is refused. Whether a third-party plan bill counts as billing the vendor is not decided.
- **Selectors the brake cannot see.** A worker started without `--model` runs Pi's default model, and a bare model id lets Pi choose the provider. Neither names a vendor, so neither is checked. A model that a person selects inside an interactive Pi session is not checked either.
- **The Google route.** The rules name the `antigravity` Pi provider as Google's route, but the Runtime's Pi one-shot cannot reach `antigravity/…` (section 4), and a `google/gemini-…` selector still runs only through `agy`. The guided setup in `kxm init` skips Google guide candidates instead of choosing between the two.
- **Two Pi provider allowlists.** `PI_ALLOWED_PROVIDERS` in `plugins/kxm/src/harness.ts` is exported but gates nothing; on the product path, the brake and admission in `.kxm/routes.yaml` decide. The developer helper keeps a different list of its own.
- **`limits.maxModelCost` cannot trip on a live run.** The engine counts only `metered` cost toward the cap, and no producer records `metered` today (section 2). The Runtime caps `unmetered` and `unknown` attempts at 100 per run instead; see [Cost basis and staleness](config-reference.md#cost-basis-and-staleness).
- **Config load checks harness/model pairs only for agents that declare `harness:` and select their model through a profile or tag.** An agent with a direct `{provider, model}` selector, or one that omits `harness:` and names `provider: xai`, passes `kxm init --dry-run` and fails only at dispatch.

## Related

- [Configuration file reference](config-reference.md): agent, role, route and price files
- [CLI reference](cli-reference.md): `kxm harness`, `kxm routes`, `kxm models` and `kxm routing`
- [Workflow catalog](workflow-catalog.md): dated model candidates per role
- [Nous providers](../guides/nous-providers.md): the opt-in Nous providers for Pi
- [Routing and cost telemetry contract](../contracts/routing.md): the routing record and cost-basis rules
- [Harness routing internals](../contributing/harness-routing-internals.md): how the KXM repository applies these rules to its own routes, roster and developer roster
