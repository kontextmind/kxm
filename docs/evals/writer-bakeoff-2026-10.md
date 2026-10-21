# Writer bake-off, October 2026

Use this page when you are deciding whether writer number two should stay OpenRouter Qwen3.7 Plus. It records a comparison of Reflection Beam 1.0, Inception Mercury 3, and `qwen/qwen3.7-plus` on six KXM writer tasks. Routing was left unchanged. No model was called, so this page does not name a replacement.

## Recommendation

Keep `pi-qwen3-7-plus-openrouter` as writer number two. `.kxm/roles/writer.yaml` stays `grok-grok-4-7`, then that Qwen route at effort medium, then the Argon and Flash routes. `.kxm/routes.yaml`, `.kxm/prices.yaml`, and `.kxm/models/inventory.yaml` are unchanged.

The three candidates have no correctness score, no diff, and no measured latency. List price is a catalog fact, and it is the wrong kind of evidence for an admission. On 2026-10-21 the OpenRouter models endpoint lists Mercury 3 at $0.10 input and $0.35 output per 1M tokens, Beam 1.0 at $0.30 and $1.00, and Qwen3.7 Plus at $0.32 and $1.28.

Mercury 3 is absent from the inventory. That file has `inception/mercury-2` and `inception/mercury-2.5`. Beam is present, and its checked-in standard tier is still $1 input and $3 output. The live models row is $0.30 and $1.00. Beam's BaseTen endpoint does not advertise tools. The Qwen admission required a live tool check, and this run did not send one.

## How this run was scored

The intended transport was OpenRouter chat completions for `reflection/beam-1.0-501b-a23b`, `inception/mercury-3`, and `qwen/qwen3.7-plus`. `OPENROUTER_API_KEY` is unset. This machine has no `~/.pi` directory and no Pi OpenRouter login. An unauthenticated `POST` to `https://openrouter.ai/api/v1/chat/completions` returned 401.

The fallback used by the [October 2026 planner bake-off](planner-bakeoff-2026-10.md) is a Cursor subagent pinned to the candidate model. The catalog offered to this agent on 2026-10-21 has no slug for the three OpenRouter ids. It offers Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5, Composer 2.5, Cursor Grok 4.6, Gemini 4 Argon, GPT-5.6 Sol, Grok 4.7, and Muse Wonder 1.0. A diff from one of those families would answer a different question, so no substitute arm was launched.

GPT-5.6 Sol (`gpt-5.6-sol-medium`) was available as a judge and was not called. There were no diffs to label. The rubric, for a later keyed run, is 0 to 5 on correctness (the task tests pass), diff quality, and instruction following. Latency and dollars are measurements beside that score. `score.py --score` exits 2 while `raw/` is empty. A missing arm is not stored as zero.

## Catalog

Prices were read from `https://openrouter.ai/api/v1/models` at 2026-10-21T08:34:25Z, and from each id's `/endpoints` URL. OpenRouter returns USD per token. The tables multiply by 1,000,000. The snapshot is `writer-bakeoff-2026-10/prices.json`. Reprint it with `python3 docs/evals/writer-bakeoff-2026-10/score.py --prices`.

| Model | OpenRouter id | Input / output per 1M | Cache read per 1M |
| --- | --- | --- | --- |
| Beam 1.0 | `reflection/beam-1.0-501b-a23b` | $0.30 / $1.00 | $0.04 |
| Mercury 3 | `inception/mercury-3` | $0.10 / $0.35 | $0.01 |
| Qwen3.7 Plus | `qwen/qwen3.7-plus` | $0.32 / $1.28 | $0.064 |

Qwen3.7 Plus also lists cache write at $0.40 per 1M. Above 256,000 prompt tokens that row triples ($0.96, $3.84, $0.192, $1.20). The `.kxm/prices.yaml` base tier matches the live base tier at $0.32, $1.28, $0.064, and $0.40. Context length is 1,048,576 for Beam and 1,000,000 for Mercury 3 and Qwen3.7 Plus. All three model rows list `tools`.

Endpoint names in the snapshot carry provider dates: Beam `20261016`, Mercury `20261019`, and Qwen `20260602`. Beam's providers do not share one price.

| Provider | Tag | Input / output per 1M | Tools |
| --- | --- | --- | --- |
| Nebius | `nebius/fp8` | $0.25 / $1.00 | yes |
| CoreWeave | `coreweave/fp4` | $0.30 / $1.00 | yes |
| BaseTen | `baseten/fp4` | $0.40 / $1.20 | no |
| Together | `together` | $0.40 / $1.20 | yes |

CoreWeave, BaseTen, and Together list cache read at $0.04 per 1M. Nebius omits it. Mercury 3 has one Inception endpoint, tag `inception`, with tools. That object includes `"discount": 0.5` next to the rates in the table. Those prompt and completion fields are the quoted price. Qwen3.7 Plus has two Alibaba endpoints, `alibaba/us-east-1` and `alibaba`, both at the base price and both with tools.

`qwen/qwen3.7-plus:batch` is a separate catalog row at $0.23 input and $0.92 output per 1M. It is not writer number two. The live models list had no `reflection/beam-1.0-501b-a23b:free` id.

## Totals

Every arm is "not run". An empty cell means the model was not executed.

| Task | Beam, Mercury, and Qwen |
| --- | --- |
| Rate-limit abort | not run |
| Suggest whole words | not run |
| Hub-down hint | not run |
| Vision admitted route | not run |
| Windows cmd shim | not run |
| Init Antigravity guide | not run |

| Model | Judge total (max 90) | Tasks won | Measured spend |
| --- | --- | --- | --- |
| Beam 1.0 | not run | not run | $0.00, no calls |
| Mercury 3 | not run | not run | $0.00, no calls |
| Qwen3.7 Plus | not run | not run | $0.00, no calls |

Six tasks times three rubric dimensions is 90 points. Nobody scored any of them.

## Cost per task

No response returned token usage, latency, or a provider bill. Measured spend is $0 because zero requests were sent. A forecast would need token counts this run does not have.

| Task | Measured cost | Latency | Tests |
| --- | --- | --- | --- |
| Rate-limit abort | not measured | not measured | not run |
| Suggest whole words | not measured | not measured | not run |
| Hub-down hint | not measured | not measured | not run |
| Vision admitted route | not measured | not measured | not run |
| Windows cmd shim | not measured | not measured | not run |
| Init Antigravity guide | not measured | not measured | not run |

## Tasks that were prepared

Six landed fixes were selected because each is a small source change with a test. A live run would check out the parent, implement that task, and run the named tests. The landed commit would be the oracle. No parent was checked out, and no prompt was sent. The statements are the shipped bug, in `writer-bakeoff-2026-10/tasks.json`.

### Rate-limit abort

Pull request 414, landed `e63907a`, parent `477fc06`. A 429 body that says the request was aborted was classified as cancellation, so an opted-in role never walked. `tool_policy` stays non-walkable. Source: `plugins/kxm/src/route-fallback.ts`. Test: `test/core/route-fallback.test.ts`.

### Suggest whole words

Pull request 411, landed `477fc06`, parent `9c51344`. Substring keywords sent prompts containing "guide", "author", or "change" to the wrong workflow. Hyphenated keywords stay one token. Source: `plugins/kxm/src/suggest.ts`. Test: `test/core/suggest.test.ts`.

### Hub-down hint

Pull request 413, landed `9c51344`, parent `e5c1b54`. `kxm init` outside a Git worktree needs to say to run `git init`. `kxm hub view` needs a hint when nothing answers a loopback or remote [hub](../glossary.md#hub). Sources: `plugins/kxm/src/init.ts`, `plugins/kxm/src/cli/hub.ts`. Tests: `test/core/cli.test.ts`, `test/core/hub-bind-probe.test.ts`.

### Vision admitted route

Pull request 412, landed `e5c1b54`, parent `c11458e`. `--route` changed the admission check while Pi still ran the default provider. Other ids need `pi --model`, native-vendor ids are refused first, and an unadmitted route names the admit command. Source: `plugins/kxm/src/vision-gate.ts`. Test: `test/core/vision-gate.test.ts`.

### Windows cmd shim

Pull request 365, landed `145a8db`, parent `2ea15a7`. A missing Windows `cmd.exe` shim was counted as installed, and the light-shard Windows tests were asserting Unix file modes and forward-slash paths. Source: `plugins/kxm/src/harness.ts`. Test: `test/core/harness.test.ts`.

### Init Antigravity guide

Pull request 309, landed `8fb4aa5`, parent `0ba4474`. Guided setup mapped Google Gemini candidates onto a Pi Antigravity selector. The Runtime one-shot uses `--no-extensions`, and `pi auth check` does not load extensions, so a drive fails at dispatch. Source: `plugins/kxm/src/init-guide-setup.ts`. Test: `test/core/init-guide-setup.test.ts`.

## Caveats

- The sample is six tasks, and zero of them ran. Keep the current writer number two until a keyed run scores them.
- List rates are the 2026-10-21 models row. They are not an invoice for these tasks.
- The inventory Beam tier and the live models row disagree. Read the catalog again before any admission.
- OpenRouter may send Beam to BaseTen, which does not list tools. This page did not probe which endpoint answers.
- Mercury's `discount` field is stored in the snapshot and is not applied as a second cut.
- Cursor subagents were the documented fallback and were not used, because the candidate slugs are absent.
- Regenerate prices with `score.py --prices`. `score.py --run` and `score.py --score` exit 2 and do not invent arms.

## Related

- [Harness routing](../reference/harness-routing.md)
- [Configuration reference](../reference/config-reference.md)
- [Planner bake-off, October 2026](planner-bakeoff-2026-10.md)
- Prices, the task list, and `score.py` live in `docs/evals/writer-bakeoff-2026-10/`.
