# Nous providers

Reach Nous Research models from Pi through one of three opt-in provider routes, and check that KXM will actually dispatch them before you depend on one. This page is for operators who run Pi agents and want Nous Portal, the Nous direct API, or a Hermes subscription proxy. None of these routes is a writer route, and none is enabled by default.

Nous routes are Pi *providers*, not a separate harness: there is no Nous `kxm agent worker`, and Pi stays the only long-lived worker. See [Supervised Pi workers](pi-workers.md).

## Before you begin

- Pi installed. For the `nous/` and `nous-proxy/` routes, Pi must also load the KXM extension. See [Install](../start/install.md).
- A Nous Portal subscription or a Nous API key.
- For the proxy route only: the Hermes CLI, which you install and log in to yourself. KXM never installs it, logs in, starts the proxy, or makes paid requests for you.

## Choose a route

| Route | Model ids | Registered by | Authenticates with |
|---|---|---|---|
| Nous Portal | `nous-portal/<model>` | The third-party Pi package `@jayteelabs/pi-nous-portal-provider` | Pi `/login`, or `NOUS_API_KEY` |
| Direct API | `nous/<model>` | The KXM Pi extension, when `KXM_NOUS_PROVIDERS` includes `direct` | `NOUS_API_KEY` only |
| Hermes proxy | `nous-proxy/<model>` | The KXM Pi extension, when `KXM_NOUS_PROVIDERS` includes `proxy` | Your Hermes login, through a loopback proxy |

The Portal route bills your Portal account, not OpenRouter. With `KXM_NOUS_PROVIDERS` unset, the KXM extension starts synchronously and offline: no fetch, no provider registration, no notice.

## Set up Nous Portal

1. Install the provider package into Pi:

   ```bash
   pi install npm:@jayteelabs/pi-nous-portal-provider
   ```

2. Log in. In Pi, run `/login`, choose subscription or API key, then Nous Research Portal. Alternatively, export `NOUS_API_KEY` in the shell or supervisor that starts Pi.

   In Pi:

   ```text
   /login
   ```

3. Optionally override the endpoints. The package documents `NOUS_PORTAL_BASE_URL` (default `https://portal.nousresearch.com`) and `NOUS_INFERENCE_BASE_URL` (default `https://inference-api.nousresearch.com/v1`).

## Verify the Portal route

Check both that Pi lists the models and that Pi reports the provider ready. KXM trusts only the second check.

```bash
# Which Portal model ids does this install expose?
pi --list-models nous-portal
# Is the provider authenticated? KXM runs this same check before it dispatches.
pi auth check --provider nous-portal --json
```

The route is usable only when `status` is `ready`. Model ids change: the reviewed experiment example is `nous-portal/tencent/hy4-preview`, and some installs list `tencent/hy3-preview` instead. Use the ids your install prints.

> [!IMPORTANT]
> In some installs `pi auth check --provider nous-portal` reports `provider_not_found` even though `pi --list-models` lists Portal models:
>
> `{"status":"not_ready","provider":"nous-portal","reason":"provider_not_found"}`
>
> KXM treats that answer as not authenticated. `kxm harness list` shows the Pi route as not authenticated, and the Runtime refuses to dispatch it. There is no override: fix the Pi install until the check reports `ready`.

Run a Portal model interactively:

```bash
pi --model nous-portal/<model-id>
```

## Enable the direct API

1. Export `NOUS_API_KEY` in the shell or supervisor that starts Pi. The direct route reads only this variable; it does not use credentials stored by Pi `/login`.
2. Export `KXM_NOUS_PROVIDERS=direct`.
3. Optionally point `KXM_NOUS_CATALOG_FILE` at a dated price pin. See [Pin a price catalog](#pin-a-price-catalog).
4. Start Pi. Models appear as `nous/<id>` only when their capacity and verified numeric rates are known, from the live `/v1/models` catalog or from the pin.

```bash
export NOUS_API_KEY="replace-with-nous-api-key"
export KXM_NOUS_PROVIDERS=direct
pi --list-models nous/
```

## Enable the Hermes proxy

1. Install Hermes if it is missing, then log in: `hermes login --provider nous`. Newer Hermes docs also mention `hermes setup --portal`; that flow is not verified on every CLI.
2. Start the proxy with `hermes proxy start`, and check it with `hermes proxy status`. The default base URL is `http://127.0.0.1:8645/v1`.
3. Export `KXM_NOUS_PROVIDERS=proxy`, or `direct,proxy` for both routes.
4. Start Pi. Models appear as `nous-proxy/<id>`, with `subscription proxy, market ref` in their display name.

If the proxy is down, the extension tells you to run `hermes proxy start`. If it answers unauthorized, the extension tells you to log in again.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `KXM_NOUS_PROVIDERS` | unset (off) | Comma list of `direct` and `proxy`. An unknown token fails closed: nothing is registered |
| `NOUS_API_KEY` | unset | API key for the direct route; also accepted by the Portal package |
| `KXM_NOUS_PROXY_URL` | `http://127.0.0.1:8645/v1` | Proxy base URL. Must be loopback (`127.0.0.1`, `localhost` or `::1`) over `http` or `https`; anything else fails closed |
| `KXM_NOUS_DISCOVERY_TIMEOUT_MS` | `5000` | Timeout for the `GET /v1/models` discovery request. Must be a positive number |
| `KXM_NOUS_CATALOG_FILE` | unset | Path to a `kxm.nous-catalog.v1` price pin |
| `KXM_NOUS_MODELS_URL` | Nous public catalog | Catalog URL that `kxm models refresh` reads for the model inventory |

## Pin a price catalog

A pin supplies capacity and rates when the live catalog is incomplete, so a model is registered with known prices instead of guessed ones.

```json
{
  "schema": "kxm.nous-catalog.v1",
  "recordedAt": "2026-09-20T00:00:00.000Z",
  "source": "Nous Portal pricing page, checked by the operator",
  "units": "usd_per_million_tokens",
  "hash": "sha256:<64 hex characters>",
  "models": {
    "<model-id>": {
      "contextWindow": 131072,
      "maxTokens": 8192,
      "cost": { "input": 0.8, "output": 2.4, "cacheRead": 0.08, "cacheWrite": 0.8 },
      "priceBasis": "list",
      "billing": "metered",
      "verified": true
    }
  }
}
```

`priceBasis` is `list` or `upper-bound`, and `billing` is `metered`, `subscription` or `subscription_plus_usage`. A model may add `tiers`, each with `inputTokensAbove` and its own four rates; the highest rate per component becomes the price, labelled as an upper bound. `hash` is the SHA-256 of the canonical JSON (sorted keys, no whitespace) of `recordedAt`, `source`, `units` and `models`. Compute it with Node:

```bash
node -e '
const { createHash } = require("node:crypto");
const pin = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const canon = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
const { recordedAt, units, models } = pin;
const source = pin.source.trim();
console.log("sha256:" + createHash("sha256").update(canon({ recordedAt, source, units, models })).digest("hex"));
' nous-pin.json
```

The whole pin is ignored when its hash does not match, its units are missing, it is dated in the future, it is older than 30 days, or any model entry is invalid. An unverified zero rate makes an entry invalid; verified zeros are allowed.

## How prices are read

From the public `GET https://inference-api.nousresearch.com/v1/models` catalog, KXM reads `context_length`, `top_provider.max_completion_tokens`, `architecture.input_modalities`, `supported_parameters` (`tools`, `reasoning`), and the `pricing.prompt`, `completion`, `input_cache_read` and `input_cache_write` per-token prices plus `pricing.overrides[]`. It converts them once to US dollars per million tokens. It never applies `pricing.original` or a blanket discount.

Incomplete or malformed live rates exclude the model rather than drop a costly tier or guess zero, unless a matching pin supplies verified rates and capacity. Context tiers collapse to the highest rate per component, and that upper bound is what Pi's cost calculation sees, so a price never underquotes at a tier threshold. Upper-bound estimates are labelled in `nous/*` and `nous-proxy/*` display names.

## What has been verified

At the last compatibility check (2026-09-07), tests verified one streamed tool call with usage on `qwen/qwen3-coder-plus`, through both the direct API and an OAuth-backed Hermes proxy. Both reported usage.

Still unknown or unverified:

- How much included subscription quota a request consumes, and any extra billed amount.
- Every other model, and automatic auth refresh.
- Claude to Nous to Qwen: Nous documents native Messages support for `anthropic/*` only, and Qwen uses chat completions, so that path is unsupported.
- A mocked bearer token proves header support, not that OAuth credentials are interchangeable.

## Admission and routing rules

A route that Pi can reach is not a route KXM will dispatch. Admission decides that, and it is a reviewed decision, not a configuration tweak.

- **No Nous route is a writer.** `nous-portal/tencent/hy4-preview` is a reviewed read-only experiment example, not a writer. Any other `nous-portal` writer route needs its own reviewed admission.
- **`nous/` and `nous-proxy/` carry no admission.** Registering them adds models to Pi's list; it grants no writer or router role, and the developer assignment helper does not allowlist them.
- **Native vendors are refused.** The Portal also hosts `anthropic/…`, `openai/…`, `x-ai/…` and `google/…` models. Those vendors have native harnesses, so KXM uses the native harness and refuses the aggregator copy.
- **Auth fails closed.** When `pi auth check` does not report `ready`, KXM refuses the route rather than billing another provider.
- **The product Runtime dispatches only admitted selectors**, listed under `admitted` in `.kxm/routes.yaml` and, when a role file exists, in that role's roster.

See [Harness routing](../reference/harness-routing.md#nous) for the full decision procedure.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `nous/` models appear | `KXM_NOUS_PROVIDERS` is unset, `NOUS_API_KEY` is unset, or no model has verified rates | Export both, or add a valid price pin |
| Nothing registers and Pi shows an error | `KXM_NOUS_PROVIDERS` has an unknown token, or the discovery timeout is not a positive number | Use only `direct` and `proxy`, and fix the timeout |
| No `nous-proxy/` models appear | The proxy is down, not logged in, or `KXM_NOUS_PROXY_URL` is not loopback | Run `hermes proxy status`, log in, and use a loopback URL |
| A pinned model is still missing | The pin's hash, units or date failed, or one entry is invalid, such as an unverified zero rate | Fix the entry, recompute the hash, and refresh the pin within 30 days |
| KXM refuses a `nous-portal` route that Pi lists | `pi auth check` does not report `ready` | See the `provider_not_found` note above |
| A route is refused as not admitted | The selector is not in `.kxm/routes.yaml` or the role roster | Admission is a reviewed decision; see [Harness routing](../reference/harness-routing.md) |

## Next steps

- Pick a route for a model reachable more than one way: [Harness routing](../reference/harness-routing.md)
- Run Pi agents under supervision: [Supervised Pi workers](pi-workers.md)
- Refresh the model inventory: [`kxm models`](../reference/cli-reference.md#kxm-models)
- All configuration layers and variables: [Configuration](../reference/configuration.md)
