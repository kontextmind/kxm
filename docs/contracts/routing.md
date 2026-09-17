# Routing and cost telemetry

> **Status.** `kxm.routing-record.v1` is parse-only for legacy records.
> `kxm.routing-record.v2` is **implemented and active**: emitted at engine
> attempt settlement (`routing.attempt.recorded` event in `plugins/kxm/src/engine.ts`),
> enforced with fail-closed `costBasis` requirement. Price catalog `.kxm/prices.yaml`
> (`kxm.prices.v1`) is implemented, dated, and hashed. `kxm routing report`
> is implemented (`plugins/kxm/src/routing.ts`) and ranks routes quality-first,
> then cost per accepted attempt, never ranking unknown cost cheapest and
> reporting metered, unmetered, and unknown populations separately. Dev-helper
> telemetry (`scripts/harness-run.mjs`) and the issue 127 assignment runner
> (`scripts/assignment-run.mjs`, `just assign`) are implemented developer tools.

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

## Implemented: v2 record

Schema id: `kxm.routing-record.v2` (`plugins/kxm/src/routing.ts`).

Fields carried on `RoutingRecordV2`:

- Identity & scoping: `schema`, `recordedAt`, `project`, `runId`, `stepId`, `assignmentId`, `attemptId`.
- Routing configuration: `harness`, `provider`, `requestedModel`, `effectiveModel`, optional `thinking`, optional `agentRole`, `behavioralSha256`.
- Execution metrics: `latencyMs`, `contextTokens`, `tokensIn`, `tokensOut`, `cacheReadTokens`, `cacheWriteTokens`.
- Outcomes: `verifierOutcome` (`passed` | `warning` | `failed`), `finalOutcome` (`accepted` | `blocked` | `failed` | `pending`), `retries`, optional `transitions`, optional `humanInterventions`, optional `providerMetadata`.
- Cost accounting: `costBasis` (`"metered" | "unmetered" | "unknown"`), `costUsd` (required when metered), optional `priceRef`.

The KXM engine settle transaction appends a `routing.attempt.recorded` event carrying the v2 record and refuses to settle without a valid `costBasis`. Attempt dispatch enforces `limits.maxModelCost` against metered cost before invocation (`budget_model_cost`).

## Implemented: report and price catalog

- **Price catalog:** `.kxm/prices.yaml` (`kxm.prices.v1`, dated and hashed) defines input, output, cache-read, cache-write rates, and context tiers for active models. Missing rows or uncataloged models evaluate to `costBasis: "unknown"`.
- **Ranked report:** `kxm routing report` (`plugins/kxm/src/routing.ts`, CLI command `kxm routing report`) groups records by `(harness, model, thinking, role)`.
- **Ranking order:** Quality first (`verifyPassRate` descending, then `reworkRate` ascending where rework measures back-edge re-entries `transitions > 0`), followed by `costPerAcceptedUsd` ascending.
- **Underquote prevention:** Routes with unknown cost are flagged (`*`) and **never ranked cheapest**, eliminating silent underquoting.
- **Population separation:** Reports metered cost, unmetered attempt counts, unknown-cost attempt counts, and quota-exhausted attempt counts as separate metrics rather than a single misleading total.
- **List prices flag:** Supports `--equivalent-list-cost` / `--list-prices` to display estimated list rates for comparison alongside actual recorded spend.
- **Post-MVP:** Dynamic catalog price feeds (`kxm update --models`), budget roll-over, and automated promotion of repeat successes into workflow gates.

## Precedence

[AGENTS.md](../../AGENTS.md) and
[Tracking](../../plans/implementation-plan.md#tracking-working-tree-not-a-release)
win where they differ from historical 2026-09-04 reviews.
Issue 86 stays open for later-phase remainder (see Tracking).
