---
name: kxm-routing-improve
description: Inspect real route quality/cost and propose reviewed improvements without auto-routing or underquoting.
---

# KXM Routing and Improve

Use recorded routing telemetry. Unknown spend stays unknown. Do not invent
list/get/compare/top-models or auto-apply routing changes.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm routing report` | Compare verified completion, cost, and rework | `-f/--file`, `-l/--equivalent-list-cost`, `--list-prices`, `--prices` |
| `kxm routing benchmark` | Offline side-by-side model comparison | `--task`, `--arms`, `--runs` |
| `kxm improve report` | Generate improvement report and candidates | `--file`, `--out-dir` |

`kxm improve report` is the default `improve` command. There is no `--target`.

Run both reports from the project root. Without `--file` they read this
checkout's Runtime event store (read-only) and then `.kxm/logs/telemetry.jsonl`;
`--file` reads only that file. `kxm improve` prints the `sources` it read and
`routing report --json` includes them. An unreadable store exits 1 with
`improve_source_unreadable`. Simulated drives are excluded, and a Runtime attempt
is `accepted` only when its run completed without the step being re-entered.

`kxm improve` groups by workflow, step, agent role and ask. A coded-repeat
candidate needs the same ask decided in at least 2 runs, an accepted share of at
least 0.75, and a step that writes no repository; a passing group that misses
says `writes-repository` or `ask-not-repeated`. Candidates are proposed diffs
under `.kxm/candidates/`. Promotion readiness (`improvement.promotionPolicy`)
never authorizes.

```bash
kxm routing report --json
kxm routing report --equivalent-list-cost --json
kxm routing benchmark --task fixture.md --arms grok/grok-4.6,claude/fable --runs 1 --json
kxm improve report --dry-run --json
```

Do not invent prices or rank routes from missing cost. Stale catalog must not
silently underquote. Improvement candidates still need Git-reviewed activation;
telemetry cannot grant tools or skip a gate. Never apply a candidate diff or
treat `readyForReview` as approval.
