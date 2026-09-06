# Routing and cost telemetry

> **Status.** `kxm.routing-record.v1` is **shipped and parse-only**. Dev-helper
> telemetry (`kxm.harness-request.v1` / `kxm.harness-result.v2` from
> `scripts/harness-run.mjs`) is a **shipped development tool**, not a product
> producer of routing records. **Planned and unimplemented:** v2 records,
> engine event-settle write, ranked `kxm routing report`, and a dated hashed
> price catalog.

This document describes what the tree does today versus what Tracking still
plans. It does not invent prices or close product enums.

## Implemented: v1 record

Schema id: `kxm.routing-record.v1` (`plugins/kxm/src/routing.ts`).

Always present or defaulted by `parseRoutingRecord`: `schema`,
`behavioralHashVersion`, `behavioralSha256`, `skills` (default `[]`),
`contextItemIds` (default `[]`), `retries` / `transitions` /
`humanInterventions` (default `0`).

Optional when present and valid: `workflowRunId`, `stageId`, `attempt`,
`requestedModel`, `effectiveModel`, `reasoningEffort`, `agentRole`,
`rolePromptSha256`, `contextPolicyVersion`, `toolPolicyVersion`,
`workflowDefinitionSha256`, `verifierConfigSha256`, `tokensIn`, `tokensOut`,
`cacheReadTokens`, `costUsd`, `verifierOutcome`, `finalOutcome`, bounded
`providerMetadata`.

The behavioral hash covers the configuration tuple (normalized models, role,
prompt/skill/tool/workflow/verifier hashes). Outcome telemetry (tokens, cost,
retries, outcomes) is outside the hash.

**No built-in product producer.** The worker envelope validates a `routing`
field when present. Nothing in `plugins/kxm/src` or `scripts/kxm-worker.mjs`
writes a record. Repo records are test-built. External JSONL can be ingested.

v1 has **no dedicated fields** for harness, provider, latency, cost basis,
cache-write tokens, or context occupancy. Bounded `providerMetadata` may
carry extra keys (at most 32; values are strings, numbers, or booleans;
`prompt`/`body`/`content`/`message` keys are rejected), but those keys are
**not standardized** and `kxm routing report` does not read them.

`kxm routing report` reads `telemetry.jsonl`, groups by behavioral hash, sorts
by run count (then hash), and sums missing `costUsd` as **zero**. That silent
underquote is why the report is **not** a ranking source.

## Implemented: dev helper telemetry

`scripts/harness-run.mjs` emits `kxm.harness-result.v2` after a
`kxm.harness-request.v1`. It is not a Phase 11 adapter and is not persisted as
a routing record. Helper `status` is transport-only (`completed`, `failed`,
`interrupted`) and must not be read as product `routing-record.v1`
`finalOutcome`. Obsolete `kxm.harness-result.v1` files are diagnosed (file,
observed known schema or `unrecognized`, obsolete schema id) and left
untouched; there is no v1 parser or upgrade lane. Public result fields are
a closed allowlist with type checks (no arbitrary objects in scalar
positions); raw model/stdio text is not copied into metadata.

Observed normalization (not an invoice; none of these paths reconcile
against an invoice or usage API):

- Token basis is `cumulative`. Context occupancy is always `unknown`.
  Values above the routing v1 int cap stay in metadata and are not clamped.
- Helper cost-basis labels are `provider-reported`, `list`, `unmetered`, and
  `unknown`. `billed` is reserved for invoice provenance and is **not**
  emitted here. `just runs` can still print a `billed` label if a v2 file
  already has that string.
- Claude/Grok (`normalizeClaudeOrGrok`): when the payload has a provider
  cost, that number is copied into **both** `costUsd` and
  `providerReportedCostUsd`. Explicit `modelUsage` `costBasis: "list"` stays
  `list`. Grok `total_cost_usd` without that list basis is
  `provider-reported`. After parse, subscription Claude
  (`authStatus.method === "claude.ai"`) sets `costBasis` to `unmetered` and
  **clears `costUsd`**, leaving `providerReportedCostUsd` when it was present.
- Pi (`normalizePi`): sums `usage.cost.total` from assistant
  `message_end` events into `costUsd` only. Basis is `list` when that
  aggregate exists, otherwise `unknown`. There is **no**
  `providerReportedCostUsd` field on this path.
- Codex (`normalizeCodex`): emits `costBasis: "unmetered"` (empty payload
  is `unknown`). Root-verified helper auth preflight permits Codex
  **ChatGPT only** (`scripts/harness-run.mjs` ChatGPT login parse). The
  post-normalize ChatGPT branch also clears `costUsd`. Do not invent an
  API-key billing path here; B3 inventory of other Codex surfaces is a
  **separate** product/inventory question, not this helper.
- Formatter `formatRunCost` still prints `billed $…` when a listing file
  already has `costBasis: "billed"`. The helper itself does not emit that
  label. That is display of a supplied label, not invoice reconciliation.

Do not relabel provider-reported or list-basis amounts as billed. Partial
usage after failure or interruption is kept and marked `usagePartial`;
missing counters stay absent, not zero.

## Planned: v2 record

Proposed (from the 2026-09-04 review field list; **unimplemented**): schema,
`recordedAt`; project/run/stage/assignment/attempt; harness, provider;
requested/effective model; thinking (`none` when unset); agentRole;
behavioralSha256; context tokens actually sent; tokens in/out; cache read/write
(null when not reported); latencyMs; costBasis; `costUsd` only when metered;
optional `priceRef`; outcomes; retries; humanInterventions; bounded
providerMetadata.

Engine settle-transaction write (`routing.attempt.recorded`) is planned with
the engine. Harness plus cost fields remain the Phase 4 “Still this phase”
item. This is **not** a Phase 3 gate.

**Unresolved proposal:** product routing-record v2 cost-basis vocabulary.
Review D10 proposed `metered | unmetered | unknown`. The shipped helper now
emits `provider-reported | list | unmetered | unknown` and does not emit
`billed`. That helper set is not the product enum. Neither candidate is
invoice-reconciled. Product vocabulary stays open until a later D5 design
choice. No new prices or enums are chosen here.

## Planned: report and catalog

Until v2 and separated cost populations land:

- Helper cost populations today: provider-reported, list, unmetered,
  unknown; billed is not a helper emission. Product ranking still waits
  for v2 records. `unknown` is never cheapest.
- Dated hashed catalog for model ids and list prices; until that feed exists,
  list prices are `unknown`. Do not invent prices.
- Ranking is catalog ∩ authenticated harnesses plus real spend/quality/latency
  from a future report — not v1 run-count sort.
- API budgets and rollover remain later, not this phase.

## Precedence

[AGENTS.md](../../AGENTS.md) and
[Tracking](implementation-plan.md#tracking-working-tree-not-a-release)
win where they differ from historical 2026-09-04 reviews.
Issue 86 stays open for later-phase remainder (see Tracking).
