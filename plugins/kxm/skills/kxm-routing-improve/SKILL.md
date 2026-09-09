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
| `kxm improve report` | Generate improvement report and candidates | `--file`, `--target cli\|project`, `--out-dir` |

`kxm improve report` is the default `improve` command.

```bash
kxm routing report --json
kxm routing report --equivalent-list-cost --json
kxm routing benchmark --task fixture.md --arms grok/grok-4.6,claude/fable --runs 1 --json
kxm improve report --target cli --json
```

Do not invent prices or rank routes from missing cost. Stale catalog must not
silently underquote. Improvement candidates still need Git-reviewed activation;
telemetry cannot grant tools or skip a gate.
