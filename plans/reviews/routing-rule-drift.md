---
schema: "kxm.doc.v1"
id: "REVIEW-ROUTING-RULE-DRIFT"
type: "architecture"
title: "Routing and cost rules that disagree with the code (2026-09-23)"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-23"
updated: "2026-09-23"
authority: "hypothesis"
confidence: "verified"
summary: "Six routing/cost findings checked against AGENTS.md and Tracking → Decided. Two are bugs against a decided rule and are fixed in the same change (Pi native-vendor brake; unknown cost ranked cheapest); four are admission or budget policy and are left to the operator with options. Planner record, not assignment, witness or acceptance proof."
tags: ["review", "routing", "harnesses", "cost"]
related:
  - ../implementation-plan.md
  - ../../docs/contracts/routing.md
depends_on: []
blocked_by: []
details:
  reviewed_commit: "0aba4b2"
  found_on: "ac08d95"
---

# Routing and cost rules that disagree with the code

Found 2026-09-23 on main `ac08d95` while drafting `docs/harness-routing.md`; every line
below was re-checked on `0aba4b2` (main two commits later — neither touches these files).
Rules come from `AGENTS.md` and **Tracking → Decided** in
[`implementation-plan.md`](../implementation-plan.md). Line numbers are `0aba4b2`; a bare
`:NNN` is a line of `implementation-plan.md`.

Admission belongs to the operator, so the test for "fix it here" was narrow: the rule must
already be written down, the fix may only **refuse** more (never admit), and it must not
override a policy the code states on purpose. Anything else is a question with options.

| # | Finding | Verified | Class | In this change |
|---|---|---|---|---|
| 1 | Pi brake checks only the first id segment; worker has none | yes | **(a) bug** — except the reseller sub-case, which is (b) | brake fixed on three dispatch paths; four doc examples updated |
| 2 | Google route: code wires `agy`, decision says `antigravity` | yes | (b) policy | nothing |
| 3 | Two Pi provider allowlists | yes | (b) policy | Tracking text corrected only |
| 4 | `limits.maxModelCost` cannot trip | yes | (b) policy | recorded gap in Tracking |
| 5 | `qwen-token-plan/deepseek-v4.1-flash` admitted | yes | (b) policy | nothing |
| 6 | Routing report ranks partly-unknown cost at `$0` | yes | **(a) bug** | sort fixed |

## 1. Pi native-vendor brake — (a), fixed

**Rule.** Pi must not run a model whose vendor has a native harness: "Never bill one vendor
through another harness" (`AGENTS.md:38`); "Do not use Pi's bundled provider credentials to
impersonate a logged-in subscription CLI … Pi's `xai` provider is not a writer fallback"
(`implementation-plan.md:284-295`); "Native-vendor candidates never fall back to OpenRouter …
(no silent cross-billing)" (`:2123`). The accepted roster loader already enforces it by vendor
(`scripts/roster-policy.mjs:115-135`, "native vendor cannot use Pi"). Named exceptions:
`antigravity` for Gemini only (`:234-248`, segment rule in `scripts/harness-run.mjs`), and the
Claude bridge "stays experiment-only" (`:259`, `AGENTS.md:100`).

**Code.** `validateHarnessModelPair("pi", …)` (`plugins/kxm/src/harness.ts:1069-1085`) tests
only the first segment against `PI_NATIVE_BRAKE_PROVIDERS` (`:130-137`). Reproduced — all
valid on `0aba4b2`: `openrouter/x-ai/grok-4.6`, `openrouter/anthropic/claude-fable-5`,
`openai-codex/gpt-5.6-sol`, `kimi-coding/k3`, `moonshotai/kimi-k3`, `google-vertex/gemini-2.5-pro`,
`claude-bridge/claude-fable-5`, `antigravity/claude-sonnet-4-6`. Two causes: the brake list
spells Moonshot `moonshot`, but Pi 0.87.1's provider ids are `moonshotai`, `moonshotai-cn` and
`kimi-coding`, so the Moonshot entry never matched a real Pi id; and the vendor segment of an
aggregator id is never read. The dev helper had the same aggregator gap for non-writer roles
(`scripts/harness-run.mjs:1538-1551`; `openrouter/anthropic/…` passed as `planner`). The
long-lived worker had no brake at all (`scripts/kxm-worker.mjs:35`, `cli/hub.ts:373`), and
`docs/configuration.md:256-257` showed `--model antigravity/claude-sonnet-4-6 --fallback-models xai/grok-4.6`.

**Fix.** The pair check now resolves the model's vendor three ways — a braked provider id
(unchanged), a Pi provider id that *is* a braked vendor under another name (`openai-codex`,
`moonshotai`, `moonshotai-cn`, `kimi-coding`, `google-vertex`, `claude-bridge`, `antigravity`),
or the vendor segment of `provider/vendor/model` using the roster policy's aliases (`x-ai`,
`moonshotai`, `google-ai`). `antigravity/gemini-*` stays open as the decided Google route. The
helper gets the same vendor-segment check after its existing writer pin; the worker script runs
every primary and fallback selector through the pair check before Pi starts (covering both
`kxm agent worker` and a direct `scripts/kxm-worker.mjs` launch). Four doc examples launched
workers the brake now refuses and were moved to admitted non-native routes:
`docs/configuration.md:256-257`, `README.md:157` (`xai/grok-4.6` primary), the release smoke in
`docs/operations.md:100,107` (`xai/grok-4.6,anthropic/claude-sonnet-4-5`) and the provenance
reviewers in `docs/provenance-gates.md:141-142`, whose ids `reviewer-claude`/`reviewer-grok`
stay because `examples/provenance-workflow.json` and its test pin them. No admitted route
changes: every id in `.kxm/routes.yaml` and `.kxm/roster.yaml` validates exactly as before on
every harness (checked against `0aba4b2`'s function).

Tests (each mutation-checked — reverting the rule turns exactly its test red):
`Pi brake refuses a native vendor's model under any Pi provider id, not just the first segment`
(`test/core/harness.test.ts`), `Pi helper refuses a native vendor's model behind an aggregator
prefix for every non-writer role` (`harness-run.test.ts`), and `long-lived worker refuses a
native-vendor model or fallback before supervising Pi` (`worker.test.ts`).

Consequences to know about. `claude-bridge` is now refused on the product path; nothing admitted
it there, and the helper never allowlisted it, so no experiment route closes — a product-path
experiment would need role-aware admission, which is an operator decision. Mirroring the roster
rule also refuses open-weight models filed under a braked vendor's namespace
(`groq/openai/gpt-oss-120b`, `nvidia/google/gemma-3-12b-it`), as `roster-policy.mjs` already does;
see item 5 for the open-weight question.

**Left as (b): resellers without a vendor segment.** Pi also serves native-vendor models under
the reseller's own id — `github-copilot/claude-*`, `opencode/claude-*`,
`cloudflare-ai-gateway/claude-*`, `radius/claude-*`, `amazon-bedrock/anthropic.*`,
`azure-openai-responses/gpt-*` and `qwen-token-plan/deepseek-*`. Refusing them means inferring the
vendor from the model name, and one of them is an admitted route (item 5). Decide item 5 first;
the same table then covers the rest.

**Left as (b): worker selectors the brake cannot see.** A worker started with no `--model`
runs Pi's own default model, and a bare id (`grok-4.6`) lets Pi pick the provider; neither
names a vendor the brake can check. Requiring a provider-qualified model would refuse existing
launches (the provenance coordinator has none), so it is a choice, not a fix. Also stale, and
untouched: `.kxm/assets/run-provenance-workflow.ps1` still names `antigravity/claude-sonnet-4-6`
and `xai/grok-4.6`, and was already unusable on `PI_MESH_*` variables and `mesh status`.

## 2. Google route — (b)

**Rule.** "Google integration is the `antigravity` Pi provider … never a shell-out to the agy CLI.
The agy CLI stays a harness catalog/helper entry, not the admission path" (`:234-248`, 2026-09-15);
"the roster.json route and writer promotion wait on the operator's `/login antigravity` and a live
witness". `AGENTS.md:97-100` adds "with the deprecated `gemini` entry kept".

**Code.** Google still flows to `agy` everywhere: `NATIVE_HARNESS_PROVIDERS` maps `agy → google`
(`harness.ts:116`); guide setup maps `google → agy` (`init-guide-setup.ts:53`); the helper admits
`agy` as writer/experiment with `edit` (`harness-run.mjs:141-148`); `.kxm/routes.yaml:5-6` admits
`google/gemini-3.8-flash-*`, which on the Runtime drive only `harness: agy` can run
(`runtime-supervisor.ts:810-824`). The Runtime Pi one-shot passes `--no-extensions`
(`harness.ts:487`, `oneshot-producer.ts:226-239`), and `antigravity` is registered by the bundled
KXM extension, so that path cannot reach the decided route at all. There is no `gemini` catalog
entry in `BUILTIN_HARNESSES`; only the helper's fail-closed `UNVERIFIED_HARNESSES` names it
(`harness-run.mjs:178`). The operator still used `agy` as a writer on 2026-09-16 (`:2089`).

**Why not a fix.** Every remedy changes admission (retire the `agy` writer route, admit
`antigravity/gemini-*` in `routes.yaml`) or containment (let the one-shot load the extension that
registers `antigravity`, which also registers its tools and hooks), and the decision itself says
promotion waits on a login and a witness that have not happened.

**Options.**

- **A — implement the decision now.** `routes.yaml` moves to `antigravity/gemini-*`; guide setup
  sends Google candidates to Pi/`antigravity`; `ROUTES.agy` drops to catalog/read-only; the
  one-shot loads exactly the bundled extension (`--no-extensions` plus one explicit path) and
  re-runs the S5 write-refusal witness. Blocked on `/login antigravity` and a live witness.
- **B — record `agy` as the interim Google writer** in Decided until A's witness passes, and say
  that the Runtime path cannot reach `antigravity` today.
- **C — B now, A when the witness passes.** *Recommended:* it makes the tracker true today without
  pre-empting the witness the decision asked for.

Either way, drop "with the deprecated `gemini` entry kept" from `AGENTS.md:99-100` and
`:304-307`: no such entry exists, and re-adding one would be the dual-name shim the rules forbid.

## 3. Two Pi provider allowlists — (b)

**Code.** `harness.ts:121-127` exports `PI_ALLOWED_PROVIDERS` = `openrouter`, `nous-portal`,
`nous`, `nous-proxy`, and nothing reads it; the product brake is a denylist. The helper's own
`PI_ALLOWED_PROVIDERS` (`harness-run.mjs:76`) is `openrouter`, `nous-portal`, `antigravity`. The
product path's actual admission is `.kxm/routes.yaml`, which admits `zai-coding-cn/*` and
`qwen-token-plan/*` — in neither list. Tracking says the brake uses "allowlisted aggregator
prefixes `openrouter/*`, `nous-portal/*`, `nous/*`, `nous-proxy/*`" (`:1427-1428`) and that the
helper's prefixes are `openrouter` and `nous-portal` (`:2211-2212`); both are stale.

**Options.**

- **A — one authority per path.** Delete the unused `harness.ts` constant; the product path is
  "denylist brake + `routes.yaml` admission", the helper list governs only the helper.
  *Recommended:* smallest, and matches what already decides.
- **B — one shared allowlist on both paths.** This is an admission change: `zai-coding-cn` and
  `qwen-token-plan` would be refused unless added.

This change corrects only the two stale Tracking sentences. Vendor alias tables now live in five
places (`roster-policy.mjs`, `policy-draft.mjs`, `init-guide-setup.ts`, `harness.ts`,
`harness-run.mjs`); consolidating them belongs with option A, not here.

## 4. Cost cap cannot trip — (b)

**Rule.** "Run `limits.maxModelCost` remains the hard stop" and "Fail closed rather than
overflowing onto an untracked or wrong-credential path" (`:385-387`); "Fail closed on untracked
spend" (`AGENTS.md:131`). Tracking says the cap is enforced (`:1294`, `:2476`).

**Code.** The engine sums only `costBasis: metered` (`engine.ts:1470-1482`). No producer writes
`metered`: the Pi producer hard-codes `unknown` (`pi-producer.ts:632`); the one-shot writes
`unmetered` for three observed subscription methods and otherwise `unknown`
(`oneshot-producer.ts:330-331`). Grok auth sets no method (`harness.ts:805`), so Grok runs are
`unknown`. So a declared cap (`examples/project/.kxm/workflows/fix.yaml` declares `40`) never
trips on a live run; only a simulated producer reporting `metered` exercises it.

**Why not a fix.** The code already states a policy for unknown cost: up to 100
unmetered-or-unknown attempts per run (`engine.ts:1485`). Any fix replaces that policy with
another; none is written down.

**Options.**

- **A — fail on unknown.** Under a declared cap, an `unknown` attempt stops further dispatch as
  `budget_model_cost`; `unmetered` counts as `$0`. Every capped Pi run then stops after one attempt.
- **B — refuse what cannot be enforced.** A live drive of a run that declares `maxModelCost` gets
  the existing `limit_unsupported` handoff, the shape `maxAgentTimeMs` already uses
  (`engine.ts:2540`), until a producer reports metered cost.
- **C — charge verified list estimates to the cap.** Use `listCostUsd` from a hash-verified,
  same-day catalog as a cap-only upper bound (still never recorded as `metered`); fall back to A
  or B when the catalog is stale — which this repo's catalog is today.
- **D — Grok auth method.** Label the `grok.com` login a subscription only with evidence that it
  is one. Orthogonal: `unmetered` does not count toward the cap either.

*Recommended:* B now, because it is the only one that is true for every producer today, then C
when the dated price feed lands. This change records the gap in Tracking → Still open and marks the
two "enforced" sentences as inert for live runs; it changes no budget behaviour.

## 5. DeepSeek billed through Alibaba's plan — (b)

**Code.** `.kxm/routes.yaml:11` admits `qwen-token-plan/deepseek-v4.1-flash`. DeepSeek is a
braked vendor (`harness.ts:118`, `:130-137`), but its native harness can never be eligible:
auth is always `unknown` (`harness.ts:103`) and helper dispatch fails closed
(`harness-run.mjs:178`). The route passes the brake (fixed or not) because the id has no vendor
segment. The S5 real run used `qwen-token-plan/qwen3.8-flash` (`:1781`), not this one.

**The real question** is whether an open-weight model billed by a third party's plan is "billing
that vendor". A strict reading (the brake list) says no DeepSeek route may use Pi at all; a
billing reading says this bills Alibaba, not DeepSeek, and DeepSeek has no usable native harness.

**Options.**

- **A — remove the route.** Strict and fail-closed; DeepSeek has no admitted route until its
  harness is verified.
- **B — write the exception.** "Open-weight models billed by a third-party plan are that plan's
  bill", applied consistently: it would also re-open `openrouter/deepseek/*`, the Fireworks,
  Baseten and Together DeepSeek hosts, `groq/openai/gpt-oss-*` and `nvidia/google/gemma-*`,
  which the vendor-segment brake refuses.
- **C — then finish item 1's reseller class** with a model-name vendor table for closed-weight
  models (`claude-*`, `gpt-*` except `gpt-oss`, `grok-*`, `gemini-*`) on reseller providers.

*Recommended:* decide A or B first, then C. Until then A is the fail-closed default — but that is
still an admission change, so it is not made here.

## 6. Unknown cost ranked cheapest — (a), fixed

**Rule.** "never ranking unknown cost cheapest" and "Routes with unknown cost are flagged (`*`)
and **never ranked cheapest**" (`docs/contracts/routing.md:9`, `:174`).

**Code.** A route counted as unknown only when its cost-per-accepted was `null`, it had unknown
attempts and zero metered cost (`routing.ts:821-822`). One unmetered attempt beside an unknown one
set cost-per-accepted to `0` (`:750-754`), so the route sorted **first** at `$0` while flagged; a
cheap metered attempt beside an unknown one underquoted the same way.

**Fix.** Any unknown-cost attempt makes the route's cost a lower bound, so it never sorts ahead of
a fully priced route of equal quality. Displayed values and flags are unchanged. The existing
`E3 Gate: unknown cost is never ranked cheaper than metered cost`
(`test/core/route-admission.test.ts`) now also covers the unmetered-plus-unknown and
metered-plus-unknown routes; it fails with the old predicate.

## Not changed here

`.kxm/routes.yaml`, `.kxm/roster.yaml`, `AGENTS.md`, the one-shot `--no-extensions` containment,
budget enforcement, `roster-policy.mjs` and `policy-draft.mjs` (both already check the vendor).
