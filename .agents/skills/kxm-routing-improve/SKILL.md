---
name: kxm-routing-improve
description: Run the KXM self-improvement loop. Capture evidence-backed journal lessons, read kxm_improvement_report, find repeated asks with kxm improve report (proposed gate, skill, or workflow-step candidates), and read recorded route spend with kxm routing report. Use when asked what KXM learned, what keeps failing or repeating, what to automate next, or what a model route cost. Everything is a proposal and nothing auto-applies.
---

# KXM self-improvement loop

Capture what a run taught, read what repeats, and turn a repeat into a
reviewed change. Every output here is a proposal: nothing applies itself,
grants a tool, or skips a gate. Use recorded telemetry only; unknown spend
stays unknown.

## 1. Capture

Record learning in the workflow journal while you work (`kxm-workflow`). A
`lesson` needs `--evidence`, and the hub refuses one without it:

```bash
kxm workflow record run_12345 lesson "Retries hid a race in the sync test" --stage-id verify --evidence https://ci.example.com/run/42 --json
```

## 2. Read the journal report

`kxm_improvement_report` summarizes errors, contradictions, lessons, and skill
candidates per improvement area, each area listing its priority entries sorted
by severity. Its ranked `signals` merge the same entry across runs and score
it by frequency x severity x run-attempt cost x evidence confidence, with
security signals first. Text is redacted.

## 3. Find repeats

| Command | Purpose | Options |
|---|---|---|
| `kxm improve report` | Group Runtime routing records and telemetry and propose coded-repeat candidates (the default `improve` command) | `--file <path>`, `--out-dir <path>`, `--dry-run`, `--json` |

Run it from the project root, and run `kxm improve report --dry-run --json`
first; the dry run writes nothing. Without `--file` it reads this checkout's
Runtime event store (read-only) and then `.kxm/logs/telemetry.jsonl`; `--file`
reads only that file. It prints the `sources` it read, and an unreadable store
exits 1 with `improve_source_unreadable`. Simulated drives are excluded, and a
Runtime attempt is `accepted` only when its run completed without the step
being re-entered.

- Grouping is by workflow, step, agent role and ask.
- A coded-repeat candidate needs the same ask decided in at least 2 runs, an
  accepted share of at least 0.75, and a step that writes no repository. A
  passing group that misses says `writes-repository` or `ask-not-repeated`.
- Each candidate has kind `gate`, `skill`, or `workflow-step` and status
  `proposed`.
- Without `--dry-run` it writes `<candidateId>.diff` and `<candidateId>.json`
  under `.kxm/candidates/` (or `--out-dir`) and the report under
  `.kxm/assets/improvements/`.
- Promotion readiness (`improvement.promotionPolicy`, `readyForReview`) never
  authorizes anything.

## 4. Act through review

Never apply a candidate diff yourself or treat `readyForReview` as approval.

- Gate: propose the `.kxm/gates.yaml` edit and the step change, run
  `kxm trust diff`, and ask the user to review and commit any EXPANSION.
- Skill: take the candidate through `kxm-skill-lifecycle`; do not write it
  into `.kxm/skills`.
- Workflow step: edit the workflow definition with the user (see
  `kxm workflow add --help` and `kxm workflow modify --help`), validate with
  `kxm init --dry-run --json`, then review it with `kxm trust diff`.

## 5. Route spend

| Command | Purpose | Options |
|---|---|---|
| `kxm routing report` | Compare verified completion, cost, and rework per behavioral configuration | `-f/--file`, `-l/--equivalent-list-cost`, `--list-prices`, `--prices <path>` |
| `kxm routing benchmark` | Placeholder side-by-side comparison | `--task`, `--arms`, `--runs` |
| `kxm prices acknowledge` | Stamp the existing `.kxm/prices.yaml` list as today's estimate without fetching vendor rates | `--json` |

`kxm routing report` reads the same sources as `kxm improve`, and
`routing report --json` includes the `sources`. `kxm routing benchmark` prints
fixed placeholder figures in this build; never cite them as measured cost or
quality. Use `kxm routing report` for recorded spend.
Estimates stay unknown until the catalog carries today's stamp, and a routing
total is null when any attempt has no cost.

```bash
kxm routing report --json
kxm routing report --equivalent-list-cost --json
kxm improve report --dry-run --json
```

Do not invent list, get, compare, or top-models verbs, prices, or a ranking
from missing cost. A stale price catalog must not silently underquote.
Improvement candidates still need Git-reviewed activation; telemetry cannot
grant tools or skip a gate.
