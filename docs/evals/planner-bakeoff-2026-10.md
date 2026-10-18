# Planner bake-off, October 2026

This page records a scored comparison of Claude Fable 5.1 and Claude Sonnet 5.5 on six KXM planning tasks. It is for maintainers deciding whether the planner primary should stay Fable. Routing is unchanged.

## Recommendation

Keep Fable as the planner primary. Treat Sonnet 5.5 as a fallback candidate, not a replacement.

Sonnet scored 126 and Fable scored 110, out of 150, on a blinded judge. Sonnet won four tasks and Fable won two. The two Fable wins include the Argon roster, which is the task closest to an admission decision, and Sonnet's Argon plan admitted only the medium pin and placed it after Flash. Six tasks, one judge, and a transport that is not the KXM planner route are not enough to replace the primary. List price favors Sonnet by about five to one, and a native Claude subscription records both as unmetered, so the invoice may not move.

## How this run was scored

The planner roster in `.kxm/roles/planner.yaml` is `claude-fable` at effort medium, then `pi-qwen3-8-flash-openrouter`. The native one-shot is `claude -p --model <model> --effort medium --output-format json` with the read-only arguments in `oneShotReadOnlyArgs` for `claude`. There is no command flag that swaps the planner model without editing the role and admitting a route. `kxm routing benchmark` prints placeholder numbers and does not call a model.

This machine has no `claude` binary, no Claude auth directory, and no `ANTHROPIC_API_KEY`. The committed plans are from Cursor subagents pinned to `claude-fable-5-1-thinking-medium` and `claude-sonnet-5-5-medium`. Both received the same prompt. They were told not to read the checkout, because the landed change would leak the answer. The Argon plans still name `pi-qwen3-coder-plus-openrouter` as writer number two, which the current tree no longer has, so they do not look like a read of the solution.

The judge is `gpt-5.6-sol-medium`. Labels were shuffled with seed `20261017` and stored in `score.py`. The judge scored a section-level condensation of each plan, the same sections for both arms, not the raw file byte for byte. Full text is under `raw/`. A keyword checklist in `score.py` scores the full text and does not pick the winner.

Rubric, 0 to 5 each: correctness against what shipped (or, for the open journal gap, against the written constraints), completeness of files, tests, and docs, risk and fail-closed guards, sequencing, and conciseness. The cap in the prompt was 700 words.

Tokens are `ceil(characters / 4)` on `prompts/` and `raw/`. That is not provider usage. Cache tokens were not observed, so cache rates are not applied. Fable uses the flat tier in `.kxm/prices.yaml` for `anthropic/fable`: $10 input and $50 output per 1M tokens. Sonnet 5.5 has no row in `.kxm/prices.yaml`. Its list estimate uses the standard tier in `.kxm/models/inventory.yaml` for `anthropic/claude-sonnet-5.5`: $2 and $10. `score.py` reads both files.

Twelve plans ran in one parallel wave from 2026-10-17T17:48:29Z to 2026-10-17T17:51:03Z, 154 seconds. The transport did not return per-plan latency, so the table does not invent one.

Regenerate scores with `python3 docs/evals/planner-bakeoff-2026-10/score.py --score`. `score.py --run` exits 2 until the Claude CLI or `ANTHROPIC_API_KEY` is present, and it does not invent plans.

## Totals

| Task | Fable | Sonnet | Winner |
| --- | --- | --- | --- |
| Argon writer roster | 19 | 16 | Fable |
| CLI reviewer switch | 18 | 23 | Sonnet |
| Writer number two | 13 | 21 | Sonnet |
| Weekly catalog refresh | 22 | 21 | Fable |
| Knowledge wiki seed | 18 | 21 | Sonnet |
| Runtime journal gap | 20 | 24 | Sonnet |
| Total (max 150) | 110 | 126 | Sonnet, 4 of 6 |

| Task | Input tokens | Fable output | Sonnet output |
| --- | --- | --- | --- |
| Argon writer roster | 895 | 1501 | 1359 |
| CLI reviewer switch | 924 | 1361 | 1306 |
| Writer number two | 1002 | 1318 | 1344 |
| Weekly catalog refresh | 800 | 1400 | 1246 |
| Knowledge wiki seed | 940 | 1295 | 1252 |
| Runtime journal gap | 661 | 1279 | 1349 |
| Total | 5222 | 8154 | 7856 |

| Model | List rate per 1M | List cost | Wins |
| --- | --- | --- | --- |
| Fable 5.1 | $10 / $50, from `.kxm/prices.yaml` | $0.460 | 2 |
| Sonnet 5.5 | $2 / $10, from inventory, not `.kxm/prices.yaml` | $0.089 | 4 |

Input tokens are identical because the prompts were identical. Wall time for the wave is 154 seconds, shared.

The keyword checklist matched every required topic on eleven of the twelve plans. Sonnet's Argon plan missed "argon high on the roster" and "argon tried before flash". The checklist does not encode the shipped writer-number-two model, so a perfect checklist there does not mean the plan matched what shipped.

## Argon writer roster

Shipped in pull request 401: Argon high and medium on the writer roster, ahead of Flash medium (the safety net) and Flash high (last, so the file stays on a roster). Low was inventoried and not rostered. Planner primary stayed Fable.

| Dimension | Fable | Sonnet |
| --- | --- | --- |
| Correctness | 3 | 1 |
| Completeness | 3 | 2 |
| Risk | 5 | 5 |
| Sequencing | 3 | 3 |
| Conciseness | 5 | 5 |
| Total | 19 | 16 |

Fable admitted high and medium and put them ahead of Flash, but swapped Flash medium and high and described the roster as living in `.kxm/routes.yaml`. Sonnet admitted only medium and appended it after both Flash entries. Both refused an OpenRouter Google route. List cost $0.084 versus $0.015.

## CLI reviewer switch

Shipped in pull request 402: `codex-gpt-6-1-sol` at effort low, then `pi-qwen3-8-flash-openrouter`, then `codex-gpt-5-6-sol`. Pro is an alias on the price row. Architecture review stayed Fable.

| Dimension | Fable | Sonnet |
| --- | --- | --- |
| Correctness | 3 | 5 |
| Completeness | 3 | 4 |
| Risk | 4 | 5 |
| Sequencing | 3 | 5 |
| Conciseness | 5 | 4 |
| Total | 18 | 23 |

Both named the shipped order, the pro alias, the native-vendor brake, and the doc set. The judge marked Sonnet higher because Fable placed the roster reorder inside `.kxm/routes.yaml`. Neither named `workforce-names.mjs`, the review template, or the generated bundles. List cost $0.077 versus $0.015.

## Writer number two

Shipped in pull request 403: `pi-qwen3-7-plus-openrouter`, after a live check that the model lists tools. The old coder-plus route was retired and its price row kept. The packet withheld tool support and told the planner to fail closed.

| Dimension | Fable | Sonnet |
| --- | --- | --- |
| Correctness | 2 | 3 |
| Completeness | 4 | 3 |
| Risk | 2 | 5 |
| Sequencing | 2 | 5 |
| Conciseness | 3 | 5 |
| Total | 13 | 21 |

Both defaulted to `qwen3-coder-next`, which is not what shipped. Sonnet refused to admit on that assumption and named `qwen3.7-plus` as the fallback if tools were missing. Fable scheduled the tool check after the route edit and moved the old alias onto the new route. List cost $0.076 versus $0.015.

## Weekly catalog refresh

Shipped in pull request 404: `.github/workflows/refresh-models.yml`, a catalog module, a script, and a unit test. Monday 13:00 UTC. One pull request when the catalog changes. Routes are not edited.

| Dimension | Fable | Sonnet |
| --- | --- | --- |
| Correctness | 5 | 4 |
| Completeness | 4 | 4 |
| Risk | 5 | 5 |
| Sequencing | 4 | 5 |
| Conciseness | 4 | 3 |
| Total | 22 | 21 |

Both chose Monday 06:00 UTC and marked it as a choice, which the packet allowed. Both kept CLI-only rows, refused a token, refused route edits, and refused auto-merge. The one-point edge is not a decision by itself. List cost $0.078 versus $0.014.

## Knowledge wiki seed

Shipped in pull request 405: hand-written pages under `.kxm/knowledge/`, not under `wiki/` and not under a handbook directory. Compile and ingest stayed unselected. No new test, script, or route edit.

| Dimension | Fable | Sonnet |
| --- | --- | --- |
| Correctness | 3 | 4 |
| Completeness | 3 | 3 |
| Risk | 4 | 5 |
| Sequencing | 4 | 5 |
| Conciseness | 4 | 4 |
| Total | 18 | 21 |

Sonnet put pages at `.kxm/knowledge/` and did not invent a browser flag. Fable used `.kxm/knowledge/handbook/` and named `KXM_BROWSER=steel`, which the packet said not to invent. Both refused ingest and a second glossary. List cost $0.074 versus $0.014.

## Runtime journal gap

Nothing has shipped. The constraint is: no event-store or hub-store schema change while S5 is open, do not relabel a Runtime run as a webhook run, and prefer a design note plus tests that lock `workflow_not_found`.

| Dimension | Fable | Sonnet |
| --- | --- | --- |
| Correctness | 4 | 5 |
| Completeness | 5 | 5 |
| Risk | 4 | 5 |
| Sequencing | 4 | 5 |
| Conciseness | 3 | 4 |
| Total | 20 | 24 |

Both refused a store and refused invented schema versions. Sonnet stopped at characterization tests and a design note. Fable also changed the CLI message, which is more than the smallest step and still not a schema change. List cost $0.071 versus $0.015.

## Caveats

- Six tasks is a small sample. One task is still open, so its correctness score is against constraints, not a diff.
- The judge saw condensations. Weekly is a one-point result and could flip. Argon, the reviewer switch, writer number two, and the journal gap are wider.
- The judge is one model, GPT-5.6 Sol, which is the CLI critic family. It was blind to the author and not blind to the shipped outcome.
- Token counts and list cost are estimates. Provider usage was not returned. A Claude subscription would record `costBasis: unmetered` for both models.
- Sonnet's price is not in `.kxm/prices.yaml`. Quoting it from the inventory is a list estimate, and the price loader would mark that row missing.
- Cursor subagents are not `claude -p` and not the KXM planner route. Effort was medium on both, matching the roster.
- Pull request 398, the plan-link repair, was not run. The six tasks are the five roster and docs slices from 401 through 405, plus the open Runtime journal gap.
- Plans were instructed not to use tools. A subagent that ignored that instruction could have read the landed diff. The Argon plans still describe the pre-change writer number two, which argues against that leak, and it is not proof.

## Related

- [Harness routing](../reference/harness-routing.md)
- [Configuration reference](../reference/config-reference.md)
- [CLI reference](../reference/cli-reference.md)
- Raw plans, prompts, judge JSON, and `score.py` live in `docs/evals/planner-bakeoff-2026-10/`.
