---
schema: "kxm.doc.v1"
id: "RES-JEV-SYSTEM-ONE"
type: "research"
title: "Jev (TypeSafe System One model): fit for KXM"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-23"
updated: "2026-09-23"
authority: "hypothesis"
confidence: "uncertain"
summary: "Web-source and code-seam study of whether KXM should bring in Jev, TypeSafe AI's typed-decision model, where it could sit, and the pros and cons. Verdict: watch behind named triggers, not adopt; deterministic fixes first. Creates no backlog and changes no gate."
tags: ["research", "jev", "typesafe", "routing", "classification", "openrouter", "governance"]
related:
  - implementation-plan.md
  - plan-cross-host-phase.md
  - plan-per-tenant-hosting.md
  - plan-usage-cost-quota-tracking.md
  - research-a2a-cross-host.md
  - ../docs/contracts/routing.md
  - ../docs/guides/continuous-improvement.md
  - ../docs/guides/provenance-gates.md
depends_on: []
blocked_by: []
details:
  research_status: "web_source_review"
  research_date: "2026-09-22"
  baseline_commit: "4372866"
  method: "61-agent workflow: 8 code readers over decision subsystems, 6 web arms, 3-lens judge panel and merge, adversarial verification (14 claims x 2 lenses, 5 candidates x 2 lenses), synthesis with two critic rounds; operator-added OpenRouter cookbook and direct checks folded in afterwards"
  jev_version_studied: "jev-1.13.0 (OpenRouter serves a dated snapshot, typesafe/jev-1.13-20260917)"
  reconciled_against: "implementation-plan.md Tracking, 2026-09-23"
---

# Research: Jev (TypeSafe System One model) and KXM

One-line answer: Jev is a real new tool class, a cheap calibrated classifier
that returns typed answers with probabilities instead of text, but KXM has no
live seam for it today and every candidate seam has a cheaper deterministic fix
that must land first. Watch it behind the named triggers below; do not admit a
route now. It is never a writer or a critic.

## Method and verification

This record was produced on 2026-09-22 and 2026-09-23 by a 61-agent workflow:
eight readers mapped KXM decision points file by file, six web arms covered the
official docs, cookbooks, independent critique, adoption, commercial and legal
terms, and the baseline of alternatives; three judges with different lenses
(cost and latency, governance and safety, product value) proposed candidates
that a merge step ranked; two adversarial lenses then tried to refute the 14
load-bearing claims and the 5 highest-ranked candidates; a synthesis passed two
completeness-critic rounds. Six of the 14 claims held as written and eight were
corrected in the text below; all five ranked candidates were refuted as
designed, which is why none carries an experiment tier. After the workflow the
operator added the OpenRouter tool-call gating cookbook as a source, and the
planner directly re-checked the main-checkout hub database counts, the
OpenRouter model list and endpoint, the Master Customer Agreement clauses, and
the Octomind injection figures quoted here.

## Verdict

Jev is a genuine new tool class (typed decisions with per-option probabilities at $0.042 per million input tokens, output free), but KXM has no live seam for it today: the main-checkout hub store holds 0 workflow runs, 0 context items and 0 messages, all 8 logged context packets had `candidateCount: 0`, `plugins/kxm/src/engine.ts` never calls the arbiter, and every seam the judges ranked is a $0 script or a config lookup. All five candidates the merged judges placed in the first two waves failed adversarial verification as designed, so no candidate holds a first-experiment tier; M1 and M2 are deferred behind deterministic fixes and re-enter only if their own trigger fires. Recommendation: do not admit Jev now, land the deterministic fixes the refutations exposed, and revisit only behind five named triggers: M1 fires when a workflow id that `kxm run` can dispatch exists and the word-boundary heuristic scores below an operator-set floor on the frozen fixture (otherwise M1 closes in Tracking with no vendor); M2 fires when measured coordinator-versus-stage label disagreement is material, a Tracking to Decided egress ruling exists, and a stored human-label field exists (today the hub has only the create route at `hub.ts:2195` and the promotion route at `hub.ts:1935`); the remaining three are the arbiter wired into dispatch with a non-empty pool, a workflow text assertion no script, grep or test can hold, and live untrusted intake traffic (P4d or hosted tenants). When one fires, the only admissible path is one bounded two-or-three-arm experiment on a human-labelled set with all arms and dissent recorded in routing telemetry (AGENTS.md:135). Jev is not a writer (it cannot generate text), not a critic (acceptance needs both Fable and Sol, AGENTS.md:40; as a judge of completion reports it measured ECE 0.42-0.46), and never an input to auth, admission, pricing, quorum or gate settlement.

## What Jev is (one week in)

- **API.** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <TYPESAFE_API_KEY>`, request `{state, model, questions}`; answers carry per-option `probabilities` and, for choice and score, a derived `confidence`; errors 401/422/429/529 with exponential backoff ([api.md](https://docs.typesafe.ai/api.md)). Three primitives: `noul` (P(yes)), `choice` (up to 255 options), `score` (2-10 ordered levels) ([primitives](https://docs.typesafe.ai/primitives.md); the option and level limits are cited, not independently re-verified). No text generation.
- **Model and limits.** `jev-1.13.0`; `jev-latest` and `jev-preview` both alias it and move without a deprecation window, so pin the version. 64k tokens per request, 32k for state plus the longest question; 250,000 tokens/s and 1,200 requests/min that "can change without notice"; text only, English primary ([models.md](https://docs.typesafe.ai/models.md), verified 2026-09-23). Through [Vercel AI Gateway](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway) the model id is `typesafe-ai/jev` with no version exposed, so a Gateway run cannot be pinned; scienthoon's calibration figures below came through that channel.
- **Price.** $0.042/M input, output free, on the official models page and matched by OpenRouter's endpoint record ([endpoints](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)). Free on Vercel AI Gateway until 2026-09-25, a Vercel channel promotion, not TypeSafe list price. TypeSafe: "We can't prove it isn't subsidized" ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). Purchased credits expire at the earlier of end of Term or 12 months and are not refundable ([MCA](https://typesafe.ai/legal/mca) 8.2(a)); the MCA has no price-change clause, but agreement updates take effect on at least 60 days' notice, which is the mechanism by which terms can change.
- **Latency.** Self-reported "70ms-500ms" end-to-end ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)) and "about 100 ms" for most queries ([how-to-build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)). Independent direct p50: 126.81 ms ([LiteLLM](https://docs.litellm.ai/blog/jev-auto-router-benchmark)), 313 ms ([jev-measured](https://github.com/WallerChen/jev-measured)), 376 ms ([decision-fabric](https://github.com/ghubnab99/jev-enterprise-decision-fabric)). Via OpenRouter, jev-measured README section 5 reports p50 734 ms and p90 1,739 ms against 313/423 ms direct, but that is a single 12-request interleaved run from one vantage with a 198.8 ms TCP floor, and the same README notes runs a few hours earlier had OpenRouter at 339-453 ms; OpenRouter publishes no latency. jev-measured's server-time table is roughly flat in question count: 1 question 70 ms, 3 questions 72 ms, 4 questions 81 ms, 5 questions 74 ms.
- **Calibration and robustness.** In-distribution ECE 0.024-0.032, out-of-distribution 0.107; noul under-confident (refit T 0.66), choice and score over-confident (1.30/1.92 after the 2026-09-22 correction) ([scienthoon](https://github.com/scienthoon/jev-ood-calibration), run via Vercel AI Gateway, version not exposed). Top probability exactly 1.0 on 56.4% of CLINC150 answers, nine wrong; a certified 5% routing bound missed 3.6x under prevalence shift ([jev-certify](https://github.com/nikkoxgonzales/jev-certify)). The vendor's own [jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13): state is data and "does not treat it as hostile by default"; scoping words, negations and implied conditions are read at face value; contradictory instructions versus criteria confuse it; indirection and distractor-heavy state degrade accuracy; it does not count reliably and "is not a calculator"; it reads dates as text; thresholds do not transfer between primitives. One planted sentence moved P(block) on `rm -rf ~/.ssh` from 0.76 to 0.48 ([Octomind](https://octomind.run/blog/jev-system-one-model-ai-agents)).
- **Legal and data (corrected by verification).** MCA (updated 2026-09-19): 4.1(c)/4.3 grant a perpetual right to derive Telemetry including "classifications ... and learnings" processed "without restriction"; no training on Customer Data without consent; 2.3(b) forbids distillation; 9.3 AS IS and AS AVAILABLE with only a 9.1 material-conformance warranty and no SLA; 10.3 deletion at TypeSafe's discretion. A GDPR mechanism is published: the [DPA](https://typesafe.ai/legal/data-processing) adopts EU SCCs Modules 2/3 and the UK Addendum, gives 72-hour breach notice, and grants audit rights at most once every 12 months at the customer's cost (DPA 5.3); no EU-US Data Privacy Framework certification is claimed anywhere. Hosting is stated as US ([privacy policy](https://typesafe.ai/legal/privacy-policy)). ZDR is enterprise-only on the direct API ([legal.md](https://docs.typesafe.ai/legal.md)) but per-request via [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr) on Pro/Enterprise. SOC 2 is unverified (Vanta trust center not readable).
- **Availability.** Early access 2026-09-15; waitlist removed 2026-09-20 21:30 UTC ([X post](https://x.com/typesafeai/status/2101786156572823624)); signups "temporarily" paused 2026-09-22 06:19 UTC ([X post](https://x.com/typesafeai/status/2102281508950307159)), reopen status unknown. [Status page](https://status.typesafe.ai/): two formal incidents (console Sep 20-21; API Sep 21) plus uptime-bar blips Sep 16, 19, 20; API 99.840%. JS SDK 0.6.0 (MIT, Node >=20, no runtime dependencies per the [npm registry](https://registry.npmjs.org/@typesafe-ai/sdk)) shipped a breaking `Score.criteria` change on launch day ([changelog](https://docs.typesafe.ai/sdk/javascript/changelog.md)); its timeout is per attempt "without a total retry budget" ([TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md)). OpenRouter serves `typesafe/jev-1.13` only at `/api/v1/systemone` or the alpha Decisions endpoint, not chat completions ([OpenRouter guide](https://openrouter.ai/docs/guides/community/typesafe-sdk)); the [Nous inference API catalog](https://inference-api.nousresearch.com/v1/models) has no Jev entry.

## The OpenRouter route (operator-added source)

Jev is also served by OpenRouter, an aggregator KXM already admits as a Pi
provider prefix, and that changes the access story more than anything else
found after the launch week.

- **Listing.** `typesafe/jev-1.13` (alias `~typesafe/jev-latest`), added
  2026-09-18, priced at the same $0.042/M input and $0/M output, 32k context
  against 64k direct, prepaid OpenRouter credits, no waitlist
  ([provider page](https://openrouter.ai/provider/typesafe),
  [jevaiguide OpenRouter channel](https://jevaiguide.com/channels/openrouter/)).
  TypeSafe's own signups were paused on 2026-09-22, so as of this record the
  OpenRouter key is the only instant path.
- **Endpoint.** `POST https://openrouter.ai/api/alpha/decisions`, an alpha
  endpoint whose "behavior may change", with the same `{model, state,
  questions}` request and `answers` response as the direct API plus
  `usage.cost` and `provider`
  ([API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)).
  OpenRouter's guide also exposes `POST /api/v1/systemone` for the TypeSafe SDK
  with `baseURL: "https://openrouter.ai/api"`
  ([guide](https://openrouter.ai/docs/guides/community/jev),
  [tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial)). It is
  not chat completions: the model is absent from `/api/v1/models` (verified
  2026-09-23: 454 ids, zero matches), so `kxm update --models` and
  `plugins/kxm/src/model-inventory.ts` will never see it and an unauthenticated
  probe of the decisions endpoint answers 401 as documented.
- **SDK.** `@openrouter/sdk` with `openRouter.alpha.decisions.create()`
  ([TypeScript SDK](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README));
  the cookbook itself uses `@openrouter/agent` hooks. Both are Node packages.
- **Quirks reported by integrators.** The response carries a dated snapshot id
  (`typesafe/jev-1.13-20260917`) although `typesafe/jev-1.13` was requested, so
  a run pinned by request id is not pinned by served weights and the served id
  must be recorded per call; per-option probabilities can sum to 0.99, which
  broke a strict validator until relaxed
  ([Effect-TS #8379](https://github.com/Effect-TS/effect/issues/8379)); one
  integrator reports roughly 15% of calls hanging on a read timeout and needing
  retry with backoff, a single report not re-verified here
  ([pydantic-ai #8552](https://github.com/pydantic/pydantic-ai/issues/8552));
  a Pi fork already models a "judgment provider" with the direct API and asked
  for the OpenRouter transport
  ([oh-my-pi #12458](https://github.com/can1357/oh-my-pi/issues/12458)).
  Latency through OpenRouter is measured only in single small runs: 185 to 600
  ms in one Elixir SQL-safety sample
  ([gist](https://gist.github.com/iautom8things/52f2cd39cd17f9773e9bffc1001cb057))
  and the jev-measured p50 of 734 ms cited above.
- **Data terms stack, they do not replace.** OpenRouter does not store prompts
  unless prompt logging is opted in; TypeSafe is not in OpenRouter's
  zero-data-retention endpoint list
  ([OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr)); the
  TypeSafe MCA telemetry carve-out and discretionary deletion still apply to
  whatever OpenRouter forwards.

**What the cookbook shows.** The
[gate tool calls with Jev](https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev)
cookbook places Jev between an agent's proposed tool call and its executor:
deterministic checks first (order and amount arithmetic), then a batch of
`noul` questions over ticket, policy and the proposed call, then fixed
thresholds, at or above 0.9 on every check approves, at or below 0.1 on any
check blocks, and anything between pauses for a human. It reports "cost per
call under $0.0001" and "under 600 ms", notes probabilities move by about 0.08
across repeats while outcomes stayed stable, keeps static human-in-the-loop
rules for tools that are "always dangerous", and puts the policy text into the
state so a customer's claim cannot override it. Read against KXM that is
exactly the shape of M10 and M11 below, and it is why M11 stays "do not":
`plugins/kxm/src/safety-integrity.ts` is the "always dangerous, static rule"
tier the cookbook itself keeps outside the model, and the Octomind injection
result (P(block) on `rm -rf ~/.ssh` from 0.76 to 0.48 after one planted
sentence) shows that any such middle band must be fed state that excludes tool
output and message bodies. The cookbook's own arithmetic-first ordering matches
AGENTS.md "code the repeats" and the vendor's "keep the arithmetic in code".

**Governance reading.** OpenRouter is an allowlisted Pi provider prefix for
chat models (`harness.ts` `PI_ALLOWED_PROVIDERS`), and Tracking admits
OpenRouter models one exact model at a time. The decisions endpoint sits
outside Pi's chat transport, so using it means a small direct HTTPS client
holding `OPENROUTER_API_KEY`, a transport AGENTS.md ("aggregators are Pi
providers, not a second coding harness") does not describe. It therefore needs
its own Decided entry like any other route, but it removes two costs of the
direct path: no new vendor account or secret, and provider-reported
`usage.cost` on every call, which is what `kxm.routing-record.v2` needs to
settle `costBasis: metered` under `limits.maxModelCost`.

## Where it fits in KXM

| Candidate | KXM location | Decision | Today | Jev primitive + example question | Value | Risk | Tier |
|---|---|---|---|---|---|---|---|
| M1 `kxm suggest` workflow id | `plugins/kxm/src/suggest.ts:95-115,145`; `cli/tasks.ts:28-62` | Which of 7 workflow ids a prompt matches | Substring keyword count (`add` matches `address`), array-order ties, invented confidence; emitted slash ids cannot resolve (`cli/project.ts:305-309`, `project-config.ts:99,535`) | choice over live ids + `other`: "Which workflow best matches the request? Judge the primary deliverable." | low | low | deferred behind deterministic fix; own trigger |
| M2 journal area tag | `hub.ts:2210-2218`; `commands.ts:562-618`; `workflow.ts:448-454` | Which of 7 areas an agent entry belongs to | Coordinator self-labels, hub enum-checks; auto entries already coded (`hub.ts:1097,1400-1401`); tool never sends `stageId`; tool exposes 5 of 10 categories; no relabel endpoint | choice (area only) as evidence tag: "Which of these subsystems does this summary describe?"; severity from stage outcome in code | medium | medium | deferred behind deterministic fix; own trigger |
| M3 repeatable-ask flag | `improve.ts:60-70,174-178,237` | Is a recurring step mechanizable | promptHash is unique per assignment (`assignment-run.mjs:1119-1160,1880`), recurrence never reaches 2; checked-in report: 151 groups, 0 candidates | noul + choice over redacted brief | high if reachable | high (brief egress) | blocked |
| M4 context relevance rerank | `arbiter.ts:183-190,274-275`; `hub.ts:1805-1810` | Packet order/inclusion; recall order | Task never consulted; all journal items tie on authority/confidence so UUID decides; 8/8 packets empty; engine never calls `arbitrate()`; independent evidence: standalone Jev rescoring of bge-m3 top-30 is +0.012 NDCG@10 (CI spans zero) but rank fusion rrf(bge-m3, jev@30) is +0.090 [+0.077, +0.104] and the best system at 0.864 ([zhuyansen](https://github.com/zhuyansen/jev-search-rerank-eval)) | score per candidate, batched, fused with a deterministic lexical key: "How relevant is this record to the task?" | medium once pool exists; only fusion has positive evidence | high (determinism contract, largest egress) | blocked |
| M5 effort signal | `assignment-run.mjs:826-857`; `role.ts:697-699` | low/medium/high per role | Static constant; plan:1152 already records grok low 84% at $0.17 vs medium 86.7% at $0.60; prompt sidecar embeds the ~54k-token plan (over Jev's 32k cap) | choice (3) | low | high | dropped |
| M6 improvement prioritisation | `workflow.ts:448-454`; `retrospective.ts:266-274` | Which entries surface first | Severity weight 3/2/1, positional top 12; documented formula unimplemented | score: "How reusable is this lesson?" | low | low | later |
| M7 skill applicability | `arbiter.ts:152-173` | Include skill in packet | Include-all; 0 promoted skills exist | noul per skill | 0 today | low | later (>=10 skills) |
| M8 diagnostics `unknown` residual | `diagnostics.ts:121-158` | 16-class failure class | Code map then 10 regexes; unknown rate unmeasured | choice (16) | low | medium (tool text off-box) | later |
| M9 typed text gate | template `vision-gate.ts:63-94`; kinds `engine-plan.ts:61-64` | Artifact satisfies assertion | No text gate exists | noul, P>=0.9 pass else exit non-zero | 0 (no consumer) | medium | later |
| M10 peer-message injection tag | `extension.ts:506-523`; `protocol.ts:14` | Message tries to change tools/policy/review | Receiving LLM reads verbatim | noul + choice, metadata tag only | medium in hosted/P4d | medium | later (trigger) |
| M11 seatbelt second layer | `safety-integrity.ts:10-32` | Destructive argv | 7 literal regexes on Git-reviewed argv | tighten-only noul | none | high | do-not |

**M1.** The seam is real but dead: `suggest.ts:36-78` emits ids like `software-engineering/bug-fix` that no `.kxm/workflows/<id>.yaml` can carry, the role half compares `authenticated|unauthenticated` (`tasks.ts:36-39`) against `active|ready|configured` (`suggest.ts:117-121`) so the writer is always grok, and `test/core/cli-experience.test.ts:296-323` pins only three whole-word prompts. Deterministic fix first, all $0 under AGENTS.md:141: suggest only among ids `loadKxmProject(...).workflows` contains; drop the `normalized.includes` branch at `suggest.ts:99`; drop or lengthen the short keywords that substring-match unrelated words, namely `ui` (:41, matches "build" and "guide"), `hang` (:34, matches "change") and `auth` (:55, matches "author"); return an explicit unclear result at `bestScore <= 1`; fix the auth vocabulary; re-pin the test. Then the pre-gate: freeze 60-160 operator-labelled prompts in `test/fixtures` and score arm A (current) and arm B (word-boundary) offline; if B clears the operator's floor, close M1 in Tracking with no vendor. Only if B falls below the floor do arms C and D run, and arm C has two preconditions: a Tracking to Decided entry that admits `typesafe/jev-1.13.0` (adoption item 1) and a dated, hashed `typesafe` row in `.kxm/prices.yaml` (adoption item 2). Arm C is a Jev choice over live ids plus `other`, pinned `jev-1.13.0`, direct API; arm D is the admitted `zai-coding-cn/glm-5.3-flash` (already priced at `prices.yaml:52-58`) via the `vision-gate.ts` pattern: prompt builder `:39-41`, regex-extracted verdict `:51-54` that is null when absent, injectable transport `:27`. Each C/D call settles a `kxm.routing-record.v2` (role `experiment`, `tokensIn`, `latencyMs`, `costBasis` per the Decided policy with a `priceRef`) and sets `verifierOutcome: "passed"` when the label matches the operator label and `"failed"` otherwise (`routing.ts:22-23` allows exactly those values); that is the only way per-label correctness reaches the record, because `kxm routing report` ranks quality-first on `verifierOutcome`/`finalOutcome` (docs/contracts/routing.md:173; `routing.ts:809-849`) and counts rework only when `transitions > 0` (`routing.ts:693-696`). A record with `costBasis: unknown` is flagged and never ranked cheapest (docs/contracts/routing.md:174), so without the price row the cost axis would not compare and the arm does not run. Disagreement is recorded as dissent. Pass: C >= B + 15 points and >= D - 3 and ECE <= 0.10; fail ships B; cap $0.50 per model arm; one named test proves fallback with `TYPESAFE_API_KEY` absent via injected transport.

**M2.** The hub only enum-checks labels (`hub.ts:2210-2218`), but the tool never forwards `stageId` (`commands.ts:568-613`), no shipped workflow declares a step `area`, the tool exposes 5 of the hub's 10 journal categories (`commands.ts:572-576` vs `workflow.ts:44-55`), and no endpoint stores corrected labels, so the "weekly review produces ground truth" premise is false. Deterministic fix first: add `stageId` to `kxm_workflow_record`; declare step areas (the parser accepts them, `workflow.ts:998-1038`); default agent entries to `stage.area` as `hub.ts:1097` does; derive severity from stage outcome as `hub.ts:1400-1401` already does (severity is never a model question); align the tool's category enum with the hub's ten, since the redacted state Jev would see is summary and category only and a mismatched category vocabulary corrupts the question; pin the `docs/continuous-improvement.md:18-26` definitions into `commands.ts:578-581`; measure coordinator-versus-stage disagreement from the existing `workflow_journal_recorded` log (`hub.ts:2262-2269`). Preconditions for any model arm: that disagreement is material, a Tracking to Decided egress ruling for redacted summaries exists (else synthetic only), and a stored human-label or relabel field exists; without it neither agreement nor ECE can be computed. Then, offline on `kxm workflow export` output: 150-200 entries operator-labelled for area; arms A coordinator label, B Jev `choice` over the 7 areas with the atomic question "Which of these subsystems does this summary describe?" over redacted summary and category only, C glm-5.3-flash forced JSON. Each B/C call settles a routing v2 record with `verifierOutcome` set from operator-label agreement exactly as in M1, results stored in `providerMetadata`, never as journal evidence tokens (evidence must be durable references, `workflow.ts:57-59`), and never a hub-process outbound call at record time. Whatever a Jev answer becomes, it is tool-origin content and the context authority lattice caps it at `evidence` (docs/provenance-gates.md:271-291), which is the repo rule that makes "evidence tag only, never an overwrite of the agent's label" the ceiling rather than a preference. Pass: B area agreement >= A + 10 and >= C - 3, ECE <= 0.10, zero `looksLikeSecret` hits in logged payloads; cap $1 Jev + $3 GLM.

## Where it must not go

- **Outcome settlement from prose** (`pi-producer.ts:111-141`; `oneshot-producer.ts:59-68`): Tracking S3 (PR #256) removed word-matching and default-pass because "a lying success path is not a deferred hardening item" (plan:221-224); `assignment-run.mjs:1133` "Never infer a verdict from prose".
- **Harness auth and eligibility** (`harness.ts:777-829,978-984`): fail-closed by rule (AGENTS.md:26-27,245); eligibility is "a pure function over the inventory, with no spawn or network" (plan:397-400).
- **Route admission, rosters, dispatch model choice, tier auto-routing** (`routes.ts:58-61`; `engine.ts:1300-1392`; `roster-policy.mjs:90-160`): admission is a Decided entry plus Git YAML (AGENTS.md:31-34); "Do not let an LLM invent prices or top models" (:133); no learned routing (:143; plan:323-324).
- **Critic PASS/BLOCK, quorum, a third critic, or a pre-screen deciding whether a critic runs**: both critics required (AGENTS.md:40); fallback "does not mint quorum" (:137); Jev cannot produce findings or read a tree (32k cap) and scored ECE 0.42-0.46 as a completion-report judge ([cejel.dev](https://cejel.dev/experiments/jev-judge-2026-09-20/), preregistered at [BargLabs](https://github.com/BargLabs/jev-judge-calibration)).
- **The fixed witness and command-gate settlement** (`runtime-store.ts:1889-1904`; `engine-evidence.ts:104-107`): "Deterministic gates beat a third model" (AGENTS.md:42); command gates retain only sha256 and byte counts (`engine-command.ts:57-71`), so Jev could not even see the input.
- **Prices, cost basis, budgets, report ranking, quota detection, circuit breaker** (`price-calc.ts`; `engine.ts:1467-1488`; `routing.ts:476-491,809-849`): "Fail closed on untracked spend" (AGENTS.md:131); "unknown is never ranked cheapest" (docs/contracts/routing.md:174); Jev is not a calculator and reads dates as text.
- **Secret detection, redaction, intake classification** (`redact.ts`; `intake.ts:273-307`): sending a candidate secret off-box is exfiltration; prompts and credentials are never centralized (plan:1821-1824); classification is caller-asserted and enforcement for untrusted adapters is "a separate design, not a keyword change" (plan:1886-1887); MCA 4.1/4.3.
- **Replacing or fronting the seatbelt or tool policy** (`safety-integrity.ts:10-32`; `commands.ts:1098-1192`): Decided 2026-09-11 names literal seatbelts as brakes (plan:413-420); plan:118 forbids weakening them; Jev is steerable (0.76 to 0.48).
- **Peer-reply "did the producer pass"** (`workflow.ts:599-724`): an evidence-semantics decision, not a classifier (plan:1790-1802).
- **Intake ordering, triage, refusal** (`intake.ts:374-380`): P4d "Explicitly not: email/SMS bindings, automatic takeover, scoring" (plans/plan-cross-host-phase.md:65); arrival order was chosen because text-order ties let a caller control queue priority (plans/reviews/intake-contract-astra.md:90); messages are data, never consent (AGENTS.md:245; plans/research-a2a-cross-host.md:2251).
- **Promotion authorization** (`hub.ts:1850-1866`; `skills.ts:390-399`): "Do not auto-promote skills or gates from telemetry" (AGENTS.md:141); note `evaluatePromotionPolicy` (`improve.ts:411-418`) has no production caller, so the real brakes are admin auth and promoter-not-author.
- **Registering Jev as a Pi provider, harness, role, or producer** (`nous-pi.ts:235-267`; `harness.ts:499-617`; `engine.ts:173`): aggregators are chat-shaped Pi providers (AGENTS.md:103); OpenRouter offers no chat path for Jev.
- **Raw transcripts, 0600 sidecars, journal `details`, briefs, intake bodies or tenant text as state; default-on for hosted tenants**: transcripts are "the most sensitive data KXM would hold off-host" (plans/research-a2a-cross-host.md:743); hub is loopback-only and prompts are never centralized (plan:1821-1824).
- **Permission-diff direction, authority floor, project isolation, presence and leases, vision-gate swap** (`permission.ts:433-507`; `context.ts:262-269`; `protocol.ts:58-94`): "Capability and auth checks stay fail-closed" (AGENTS.md:26-27); `context.ts:262-269` is a 403 protocol check (`context_authority_violation`) that enforces the origin floor structurally, not advisorily (docs/provenance-gates.md:285-291); presence and leases are hub-clock and fencing-token arithmetic; the vision gate is image-only and Jev is text-only.

## Pros

- Cheapest per decision in the catalog at a 2,000-token state plus about 20 output tokens: Jev $0.000084 vs gpt-5-nano $0.000108 ($0.05/$0.40, `.kxm/models/inventory.yaml:6013-6035`), glm-5.3-flash $0.000186 ($0.09/$0.30, `.kxm/prices.yaml:52-58`), claude-haiku-4.5 $0.0021 ($1/$5, `inventory.yaml:768-790`), gpt-5.6-sol $0.0042 ($2/$10, `prices.yaml:17-22`); independent $0.0151 vs Haiku $0.3565 per 1k decisions ([ayautomate](https://www.ayautomate.com/blog/jev-vs-llm-benchmark)). `prices.ts:80-87` already accepts `outputPerMillion: 0`.
- Direct latency 3.1-5.4x below the fastest small LLM measured in the same benchmark: 126.81 ms vs Haiku 688.40 ms ([LiteLLM](https://docs.litellm.ai/blog/jev-auto-router-benchmark), 240 calls) and 0.33 s vs Haiku 1.02 s ([ayautomate](https://www.ayautomate.com/blog/jev-vs-llm-benchmark), via OpenRouter); decision-fabric's 376 ms p50 belongs to a third benchmark with no Haiku arm. The aggregator penalty (734 vs 313 ms p50) rests on one 12-request interleaved run from one vantage, and the same author saw 339-453 ms hours earlier ([jev-measured](https://github.com/WallerChen/jev-measured)). Server time is roughly flat in question count, so per-candidate fan-out is nearly free.
- A calibrated per-option distribution that three of KXM's admitted vendors do not return: the Anthropic [Messages API](https://platform.claude.com/docs/en/api/messages) has no logprobs parameter, GPT-5 reasoning models list logprobs unsupported ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)), and Gemini logprobs are intermittently disabled on the Developer API ([Google AI forum](https://discuss.ai.google.dev/t/logprobs-is-not-enabled-for-gemini-models/107989)). Logprob support for the other admitted routes (`xai/grok-4.6`, `openrouter/qwen/*`, `openrouter/z-ai/glm-5.3-flash`, `qwen-token-plan/*`, `zai-coding-cn/glm-5.3` and `-flash`) is unknown. Injection-detection AUC 0.9927, ECE 0.0588 on 662 deepset items ([jev-sec-bench](https://github.com/Gaurav-Gosain/jev-sec-bench)).
- Fused with a deterministic ranker, Jev has positive independent reranking evidence: rrf(bge-m3, jev@30) minus bge-m3 = +0.090 NDCG@10 [+0.077, +0.104], the best system at 0.864 and still +0.064 under independent-judge labels; over a weak lexical candidate list Jev rescoring beat bge-m3 rescoring by +0.060 ([zhuyansen](https://github.com/zhuyansen/jev-search-rerank-eval)); over BM25 top-30 across 14 datasets Jev scored 0.692 nDCG@10 vs Cohere Rerank Pro 0.691, gap CI -0.009 to +0.012 ([anessbelbati](https://github.com/anessbelbati/jev-rerank-bench)). That is the only configuration with positive independent evidence and the shape M4 would take if its pool ever fills.
- The fail-closed typed-verdict contract already exists as code: `vision-gate.ts:63-94` checks `isRouteAdmitted` (:75-77), extracts a typed verdict by regex from the raw reply (:51-54, null when absent), returns `verdict: null` plus a divergence reason, and takes an injectable transport (:27) so tests need no network.
- Existing containers need no schema change: `routing.ts:343-347` bounds `providerMetadata` to 32 scalar keys; `config.ts:68-72` is the shadow-execution precedent; `retrospective.ts:125-128` reads `prefix:value` evidence; `.kxm/routes.yaml` admission is modality-blind and already admits the glm-5.3-flash vision route.
- As a detector rather than a target it is additive-only and measures well: tool-call risk 55/60 = 91.7%, jev-latest ECE 0.0712 (jev-preview 0.0505), with 50 of 60 predictions in the 0.9-1.0 bin so the ECE rests mostly on one bin ([themsquared/jev-benchmark](https://github.com/themsquared/jev-benchmark)); agent-action gate 90.1% vs Claude Opus 5 91.9% at 376 vs 2,479 ms p50 ([decision-fabric](https://github.com/ghubnab99/jev-enterprise-decision-fabric)).
- `typesafe` would be one more independent vendor beside the five providers `.kxm/routes.yaml:3-16` admits natively (anthropic, google, openai, xai, zai-coding-cn) and the qwen, z-ai and deepseek models it admits only under the `openrouter/` and `qwen-token-plan/` prefixes (lines 8-9, 11-13). OpenRouter is already an allowlisted Pi provider prefix (`harness.ts:121-127`, `PI_ALLOWED_PROVIDERS`), so billing could ride the existing OpenRouter account at `/api/v1/systemone`, outside Pi's chat transport and at the aggregator latency cost measured above in a single run; the zero-dependency SDK fits `"node": "^22.19.0 || >=24.0.0"` (`package.json:24-26`), and a hand-written client following `hubJsonRequest` (`client.ts:641-687`) is small.

## Cons

- No hot loop exists (verified 2026-09-23): the only hub log (`/Users/eddieflores/source/clients/kxm/.kxm/logs/kxm-hub.jsonl`) has 791 lines with 8 `context_packet_assembled` events, all empty, and 1 `context_recall` returning 0; `telemetry.jsonl` has 7 lines; a `sqlite3 -readonly` read of `/Users/eddieflores/source/clients/kxm/.kxm/state/kxm.db` (main checkout, file mtime 2026-09-19, not the worktree) shows 0 workflow runs, 0 context items, 0 messages; `.kxm/memory` and `.kxm/skills` are absent. Summed monthly cost of the candidates: unknown, because per-call volumes are unmeasured.
- KXM's cost and wall-clock live in generative, tool-using work that Jev cannot do; attempts per week are unknown (assignment records are gitignored) and the only volume figure is 204 PR-referenced commits in 30 days; most of that work settles `unmetered` (`oneshot-producer.ts:330-333`).
- No governed consumer: gate kinds are `command|artifacts-exist|reserved` (`engine-plan.ts:61-64`), `KxmProducer.id` is closed (`engine.ts:173`), gate attempts emit no routing record (only `engine.ts:2153/2189/2203` do), and a `command`-gate wrapper is ungoverned (shape-only argv, `engine-plan.ts:290-318`; raw spawn, `engine-command.ts:184`; no route check, no cost accounting), so Jev spend would escape `maxModelCost`. `redact.ts:12-13` has no `TYPESAFE` pattern. Decided 2026-09-20 forbids hub-store schema change in S0-S5 (plan:1771-1772; plan:214 says S1-S5).
- Egress and contract terms conflict with repo rulings: US-only hosting with no EU-US DPF certification claimed, ZDR enterprise-only on the direct API, perpetual telemetry carve-out, discretionary deletion, AS IS with no SLA, audit rights at most once every 12 months (DPA 5.3), a distillation ban that blocks bootstrapping a local fallback from Jev labels, SOC 2 unverified; KXM redaction is regex-only (`redact.ts:1-15`).
- Not adversarially robust while every candidate state is agent- or attacker-authored: an authority line flipped 147/200 tickets ([devxlabs](https://www.devxlabs.ai/blogs/jev-1-13-cheapest-and-twelfth)); option order flipped the top label on 5.0% of 139 decisions ([jevbench #40](https://github.com/fstandhartinger/jevbench/issues/40), cited, not independently re-verified). Under AGENTS.md:143 an output can only be a proposal or a tighten-only signal.
- Calibration does not transfer, so every threshold needs a KXM-labelled set that does not exist; the vendor's own benchmark reference labels are the "average of GPT-6 Astra and Fable 5.1" with the vendor conceding "some bias could exist" ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)), not human ground truth.
- Non-determinism collides with `arbiter.ts:26-29` (pinned including the audit at `test/core/arbiter.test.ts:78`) and `retrospective.test.ts:80-82`; no seed; raw label agreement 90.8% vs Haiku t=0 100% (vendor [consistency cookbook](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md), self-reported).
- Accuracy is not uniformly better than free baselines: Banking77 77-way 78.8% (73.1-83.6) vs GPT-5.6 Terra 84.0% (78.7-88.2) and Haiku 76.2% ([ayautomate](https://www.ayautomate.com/blog/jev-vs-llm-benchmark)); 12th of 19 arms on ticket routing ([devxlabs](https://www.devxlabs.ai/blogs/jev-1-13-cheapest-and-twelfth)); phishing 62.6% vs Haiku 81.3% while a regex baseline hit 91.8% and an 18-minute Qwen3-4B LoRA 97.4% ([anisselbd](https://github.com/anisselbd/jev-phishing-bench), cited, not independently re-verified); TF-IDF plus logistic regression 98.39% vs Jev 98.33% on 18,514 emails, an exploratory single run on jev-1.13.0 ([bitnovus](https://github.com/bitnovus/jev-spam-eval)); standalone reranking does not beat bge-m3 (+0.012, CI spans zero, [zhuyansen](https://github.com/zhuyansen/jev-search-rerank-eval)); only fusion with a deterministic ranker shows a gain, which means Jev alone is never the ranker.
- Early-access operational risk conflicts with "Do not upgrade model or harness without evidence" (AGENTS.md:131): limits changeable without notice, signups paused a week in, a breaking SDK change on launch day, floating alias, and a p50 that roughly doubled through the aggregator KXM already admits in jev-measured's single 12-request run (734 vs 313 ms; p90 1,739 vs 423 ms; 198.8 ms TCP floor; 339-453 ms hours earlier), a figure the author calls "not one number".
- Verification outcomes: 6 of 14 claims held as written; 8 were corrected. Legal: a GDPR mechanism and a region statement are published, SOC 2 is unverified, Vercel offers per-request ZDR. cejel's 28% false-flag rate is text-only (0/50 with evidence). zhuyansen's -0.028 is a label-subset figure and the fusion result was previously omitted. The status page shows two formal incidents, not four; OpenRouter's entry dates to 2026-09-18 UTC and publishes no latency. `cli-experience.test.ts` pins only three prompts, not the substring or confidence behaviour. Auto journal entries are already coded and no weekly scheduler exists. The 204 commit count was right. An admission slot exists; the gap is a governed consumer. Plan:465 ("slugs are documentation identity only") is contradicted by `suggest.ts`, and `manual_pr` is the default of an unwired evaluator. All five ranked candidates were refuted as designed, which is why M1 and M2 carry no experiment tier.

## What adoption would actually require

Only after a trigger fires and a Tracking to Decided entry names the experiment:

1. **Admission.** `typesafe/jev-1.13.0` (pinned, never `jev-latest`; the Vercel Gateway cannot pin) added to `.kxm/routes.yaml` `admitted` by hand (no inventory feed carries it) and checked through `isRouteAdmitted` before any call.
2. **Price row.** A dated `.kxm/prices.yaml` entry with `inputPerMillion: 0.042`, `outputPerMillion: 0`, re-hashed via `hashPriceCatalog` (`prices.ts:10-30`), landed before any Jev arm runs; plus a policy decision on whether fresh catalog times provider-reported `usage.input_tokens` may settle as `metered` so `limits.maxModelCost` counts it. A record left at `costBasis: "unknown"` is flagged and never ranked cheapest, so it cannot compare on cost.
3. **Transport.** Either the direct API (`TYPESAFE_API_KEY`, 64k per
   request, pin `jev-1.13.0`) or the OpenRouter decisions endpoint
   (`OPENROUTER_API_KEY`, alpha, 32k, provider-reported `usage.cost`, record
   the dated served model id from the response). Both are a direct HTTPS
   client outside Pi and outside every existing producer, so both need the same
   Decided entry, the same route check and the same telemetry; neither is a Pi
   provider, a harness, a role or a producer.
4. **Fail-closed key check.** `TYPESAFE_API_KEY` presence plus a bounded probe mapping 401/422 to refusal and 429/529 to `quota`/`provider_error`; absent key means the deterministic path runs, never a silent degrade; add `TYPESAFE_API_KEY` to `redact.ts:12-13` (`OPENROUTER_API_KEY` is already there via `nous-provider.ts:199`).
5. **Redaction before egress.** State is an allowlisted projection of KXM-produced text through `redactSecrets`, never `details`, sidecars, briefs, transcripts or intake bodies; a written egress ruling or synthetic fixtures.
6. **Telemetry and authority.** Every call settles a `kxm.routing-record.v2` (provider `typesafe`, role `experiment`, `tokensIn`, `latencyMs`, `costBasis`, `verifierOutcome` from human-label agreement, bounded `providerMetadata` for probability and confidence) so `kxm routing report` ranks arms and gate-side calls are not invisible. Any Jev answer that is stored as context is tool or external origin and the authority lattice caps it at `evidence` (docs/provenance-gates.md:271-291); it never carries the agent's label, a control-plane field, or quorum.
7. **Tests and fixtures.** One focused named test per breakable behaviour inside an existing suite with an injectable transport; live legs `KXM_SMOKE`-gated; no new npm script, CI job or platform leg.
8. **Cost cap.** Under $5 total Jev spend across all experiments plus one operator labelling session, which is the real cost.
9. **Admission rules the experiment inherits.** One bounded two-or-three-arm comparison on the same task, never the daily loop (AGENTS.md:135); Jev is never a writer (no text generation) or a critic, and its output never mints quorum (AGENTS.md:40, :137); experiment telemetry cannot grant tools, promote a skill or gate, or skip review (AGENTS.md:141); no learned routing results from it (AGENTS.md:143; plan:323-324).

What stays unchanged: the fixed witness, two-critic acceptance, auth and admission code, price arithmetic, the seatbelt, the arbiter's determinism contract, hub loopback binding, every gate kind, and the rule that routing choices stay Git-reviewed constants rather than learned policy.

## Status against Tracking

This record is a planning artifact: it creates no backlog, schedules nothing, and changes no gate. It relates to Still open S3 (strict outcome, delivered), P3 (leases), P4 (intake consumer behind the `target_not_found` trigger; P4d row at plans/plan-cross-host-phase.md:65), the 2026-09-20 per-tenant hosting rulings (plan:1821-1824), Phase 9 "context and reviewed improvement" (plan:2201-2206, 2535-2539, where M3 and M6 sit), the recorded peer-reply semantics gap (plan:1790-1802), the catalog feed (plan:2189-2195), and routing report v2 ranking. The deterministic fixes surfaced by verification (live ids, word-boundary matching and the `ui`/`hang`/`auth` keywords in `suggest.ts`, the `stageId` tool field, step areas and the 5-of-10 category enum, a stable brief hash for the improve grouping key, arbiter wiring plus a lexical relevance key, reconciling `writer.yaml:9` with `role.ts:76`, and the `reworkRate` blind spot at `assignment-run.mjs:1434`) are for the operator to schedule; nothing here admits a route.

## Sources

### Official (TypeSafe and partners)

- [docs.typesafe.ai/api.md](https://docs.typesafe.ai/api.md)
- [docs.typesafe.ai/primitives.md](https://docs.typesafe.ai/primitives.md)
- [docs.typesafe.ai/models.md](https://docs.typesafe.ai/models.md)
- [docs.typesafe.ai/concepts/how-to-build-with-system-one.md](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)
- [docs.typesafe.ai/model-jaggedness/jev-1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- [docs.typesafe.ai/legal.md](https://docs.typesafe.ai/legal.md)
- [docs.typesafe.ai/sdk/javascript/changelog.md](https://docs.typesafe.ai/sdk/javascript/changelog.md)
- [docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md)
- [docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md)
- [typesafe.ai/blog/introducing-system-one-models-and-jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [typesafe.ai/legal/mca](https://typesafe.ai/legal/mca)
- [typesafe.ai/legal/data-processing](https://typesafe.ai/legal/data-processing)
- [typesafe.ai/legal/privacy-policy](https://typesafe.ai/legal/privacy-policy)
- [status.typesafe.ai](https://status.typesafe.ai/)
- [@typesafeai X post 2101786156572823624 (no waitlist, 2026-09-20)](https://x.com/typesafeai/status/2101786156572823624)
- [@typesafeai X post 2102281508950307159 (signups paused, 2026-09-22)](https://x.com/typesafeai/status/2102281508950307159)
- [registry.npmjs.org/@typesafe-ai/sdk](https://registry.npmjs.org/@typesafe-ai/sdk)
- [openrouter.ai endpoints for typesafe/jev-1.13](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)
- [openrouter.ai TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk)
- [vercel.com changelog: Jev on AI Gateway](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway)
- [vercel.com AI Gateway ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr)
- [inference-api.nousresearch.com/v1/models](https://inference-api.nousresearch.com/v1/models)
- [platform.claude.com Messages API reference](https://platform.claude.com/docs/en/api/messages)
- [learn.microsoft.com reasoning models](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)

### Independent

- [LiteLLM auto-router benchmark](https://docs.litellm.ai/blog/jev-auto-router-benchmark)
- [WallerChen/jev-measured](https://github.com/WallerChen/jev-measured)
- [ghubnab99/jev-enterprise-decision-fabric](https://github.com/ghubnab99/jev-enterprise-decision-fabric)
- [themsquared/jev-benchmark](https://github.com/themsquared/jev-benchmark)
- [scienthoon/jev-ood-calibration](https://github.com/scienthoon/jev-ood-calibration)
- [nikkoxgonzales/jev-certify](https://github.com/nikkoxgonzales/jev-certify)
- [Octomind: Jev and agent decisions](https://octomind.run/blog/jev-system-one-model-ai-agents)
- [cejel.dev Jev judge experiment](https://cejel.dev/experiments/jev-judge-2026-09-20/)
- [BargLabs/jev-judge-calibration (preregistration)](https://github.com/BargLabs/jev-judge-calibration)
- [ayautomate Jev vs LLM benchmark](https://www.ayautomate.com/blog/jev-vs-llm-benchmark)
- [Gaurav-Gosain/jev-sec-bench](https://github.com/Gaurav-Gosain/jev-sec-bench)
- [devxlabs: Jev 1.13 cheapest and twelfth](https://www.devxlabs.ai/blogs/jev-1-13-cheapest-and-twelfth)
- [fstandhartinger/jevbench issue #40](https://github.com/fstandhartinger/jevbench/issues/40)
- [anisselbd/jev-phishing-bench](https://github.com/anisselbd/jev-phishing-bench)
- [bitnovus/jev-spam-eval](https://github.com/bitnovus/jev-spam-eval)
- [zhuyansen/jev-search-rerank-eval](https://github.com/zhuyansen/jev-search-rerank-eval)
- [anessbelbati/jev-rerank-bench](https://github.com/anessbelbati/jev-rerank-bench)
- [Google AI forum: logprobs not enabled for Gemini models](https://discuss.ai.google.dev/t/logprobs-is-not-enabled-for-gemini-models/107989)
- [Simon Willison: Jev](https://simonwillison.net/2026/Sep/21/jev/)

### Press

- [TechCrunch, 2026-09-18](https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/)
- [VentureBeat: prompt injection can influence the verdict](https://venturebeat.com/security/companies-are-putting-jev-in-charge-of-ai-agent-decisions-and-prompt-injection-can-influence-the-verdict)
- [Anthony Maio: Jev, the language model that won't](https://anthonymaio.substack.com/p/jev-the-language-model-that-wont)

### OpenRouter route and integrators (added after the workflow)

- [OpenRouter cookbook: gate tool calls with Jev](https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev)
- [OpenRouter Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
- [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev) and [tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial)
- [OpenRouter TypeScript SDK: Alpha.Decisions](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README)
- [OpenRouter TypeSafe provider page](https://openrouter.ai/provider/typesafe)
- [OpenRouter Jev Lab](https://openrouter.ai/labs/jev)
- [OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)
- [jevaiguide: Jev on OpenRouter](https://jevaiguide.com/channels/openrouter/) and [privacy FAQ](https://jevaiguide.com/faq/does-jev-train-on-your-data/)
- [Effect-TS #8379: probabilities sum to 0.99](https://github.com/Effect-TS/effect/issues/8379)
- [pydantic-ai #8552: OpenRouter decisions routing](https://github.com/pydantic/pydantic-ai/issues/8552)
- [oh-my-pi #12458: judgment provider transport](https://github.com/can1357/oh-my-pi/issues/12458)
- [iautom8things gist: SQL safety via OpenRouter decisions](https://gist.github.com/iautom8things/52f2cd39cd17f9773e9bffc1001cb057)
- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
- [LangChain: building a harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)
- [burin-labs/harn #8633: privacy controls for Jev routes](https://github.com/burin-labs/harn/issues/8633)

### Repository files cited (worktree at HEAD 4372866)

- `AGENTS.md`; `plans/implementation-plan.md`; `plans/plan-cross-host-phase.md` (P4d row, line 65); `plans/reviews/intake-contract-astra.md`; `plans/research-a2a-cross-host.md`; `docs/continuous-improvement.md`; `docs/contracts/routing.md`; `docs/provenance-gates.md` (context authority lattice, lines 271-291); `.kxm/routes.yaml`; `.kxm/prices.yaml`; `.kxm/models/inventory.yaml`; `package.json`; source files under `plugins/kxm/src/` and `scripts/` as anchored inline.
