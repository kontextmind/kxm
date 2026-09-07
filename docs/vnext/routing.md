# Routing and cost telemetry

> **Status.** `kxm.routing-record.v1` is **shipped and parse-only**. Dev-helper
> telemetry (`kxm.harness-request.v1` / `kxm.harness-result.v2` from
> `scripts/harness-run.mjs`) is a **shipped development tool**, not a product
> producer of routing records. The issue 127 assignment runner
> (`scripts/assignment-run.mjs`, `just assign`) is **implemented/unreleased**:
> it writes helper telemetry and a bookkeeping routing record per assignment,
> not product event-settle. **Planned and unimplemented:** v2 records,
> engine event-settle write, ranked `kxm routing report`, and a dated hashed
> price catalog. M5 docs/defaults are in this tree; runner adoption and
> retirement of scratch recipes still need native writer plus Fable/Sol
> review smoke. This is not a Phase 4 assignment layer or a Phase 11 adapter.

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

## Implemented/unreleased: assignment runner (issue 127)

`scripts/assignment-run.mjs` is the normal **dev** entry. It is not `kxm run`
and does not replace Phase 3/4 gates.

Working commands (absolute paths; flags from the script, not invented):

```text
just assign /abs/manifest.json
# node scripts/assignment-run.mjs run --manifest /abs/manifest.json

just witness /abs/record-dir
# witness --record-dir /abs/record-dir

just attribute /abs/task-dir /abs/record-dir orchestration /abs/note.txt
# attribute --task-dir --record-dir --class --explanation-file

just observe-cost /abs/task-dir /abs/observation.json
# observe-cost --task-dir --input

just accept /abs/task-dir <commit> /abs/writer-record /abs/arch-review /abs/cli-review
# accept --task-dir --commit --record-dir --critic --critic
# optional observed PR/CI (direct script; the five-argument just recipe cannot forward them):
# node scripts/assignment-run.mjs accept --task-dir /abs/task --commit <sha> --record-dir /abs/writer --critic /abs/arch --critic /abs/cli [--observed-pr <id>] [--observed-ci <id>]

just plan-current /abs/task-dir /abs/plan.md <sha256> <base-commit> <expected-generation>
just change-report /abs/task-dir
```

`just impl|plan|review-arch|review-cli` remain harness transport. They do not
create assignment identity, witness receipts, or `accepted.json`.

Distinctions the report and docs must keep:

- **Manifest / current plan / gate / acceptance / cost** are different
  records. Completions are not acceptance. Witness receipts are not critic
  PASS. `attribute` history does not edit `completion.json`. Cost-only
  imports never gain witness or acceptance eligibility.
- `change-report` separates provider-reported sums, list estimates,
  unmetered, unknown, not-dispatched (`provider_calls` 0), and partial
  markers. Missing is not `0`. Unmetered is not free. Cumulative tokens are
  not context occupancy. True elapsed time is separate from summed latency
  and summed witness duration. The effort table is descriptive, not a
  ranking. Orchestration/root usage is unavailable unless imported.
- Observed PR/CI identifiers are unvalidated observations.
- Private handoff notes live in `attribute` explanations and private model
  summaries; the report references them and does not print the prose.

Evidence-informed **effort defaults** for transport recipes and operator
manifests: medium implementation/planning/architecture, low CLI review. Not a
learned policy and not a catalog feed. Phase 9 may use this report to
**propose** harness or model changes; activation still requires Git review.

Per-candidate acceptance requires an actual native writer, the fixed witness,
and both designated native reviews. PR/CI/merge complete issue 127. This
document does not assert those gates have passed. Low-level
`just impl|plan|review-arch|review-cli` recipes remain harness transport.

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

Pi numeric cost for `nous-proxy/*` is a market-reference value from a dated
operator catalog pin or converted live list rates (display suffix
`subscription proxy, market ref`), not billed spend. Direct `nous/*` uses
verified numeric USD/M rates when present: live public catalog prices are
per-token decimal strings converted once, never `pricing.original` and never
a guessed 20% haircut. Incomplete live tiers are excluded, not zeroed, unless
a matching dated pin supplies rates and capacity. Context tiers register as a
labeled componentwise upper bound without a Pi `cost.tiers` schedule (exact
tier scheduling is later). Direct and proxy display names show `upper-bound`
when that bound is used; proxy still keeps subscription/market-ref identity.
`COST_BASIS` is unchanged; true unmetered labelling for subscription proxy
usage is a routing v2 item. Extra usage beyond a subscription stays unknown
unless a provider actually reports it. The dated hashed product catalog feed
is still planned; this live mapping is not that overlay.

## Precedence

[AGENTS.md](../../AGENTS.md) and
[Tracking](../../plans/implementation-plan.md#tracking-working-tree-not-a-release)
win where they differ from historical 2026-09-04 reviews.
Issue 86 stays open for later-phase remainder (see Tracking).
