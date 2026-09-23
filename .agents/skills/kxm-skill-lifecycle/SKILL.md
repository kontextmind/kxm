---
name: kxm-skill-lifecycle
description: Govern KXM skill candidates. Create one from verified runs, journal entries, receipts, or a kxm improve skill candidate, record static-review, sandbox, functional and safety evaluations, and list or verify pinned hashes, while promotion and rejection stay a non-author decision. Use when turning a repeated practice into a reusable skill. Not for editing the bundled kxm-* plugin skills.
---

# KXM governed skills

This is the governed candidate lifecycle under `.kxm/skills/`, not the bundled
`plugins/kxm/skills` suite. Bundled skills are authored in Git and mirrored to
`.agents/skills`. Do not invent `candidate`, `quarantine`, `rollback`,
`validate`, or `get` verbs.

## Agent steps

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm skills create` | Submit a candidate from verified episodes | Required `--file`, `--name`, `--created-by`, `--harness`, `--models`; optional `--description`, `--run`, `--journal`, `--receipt`, `--supersedes` |
| `kxm skills evaluate <skillId>` | Record a protected evaluation | `--kind static-review\|sandbox\|functional\|safety\|optimization`, `--evaluator`, `--fail`, `--score`, `--details` |
| `kxm skills list` | List skills by state (default `promoted`) | `--state candidate\|promoted\|quarantined\|rejected` |
| `kxm skills verify <skillId>` | Verify the pinned content hash | `--state candidate\|promoted\|quarantined\|rejected` |

```bash
kxm skills create --file /tmp/retry-backoff/SKILL.md --name retry-backoff --created-by agent_writer --harness claude-code --models claude/fable --run run_1 --receipt receipt:run_1/verify --dry-run --json
kxm skills list --state candidate --json
kxm skills evaluate skill_123 --kind static-review --evaluator eval-1.0.0 --json
kxm skills verify skill_123 --state candidate --json
```

A failed `functional` or `safety` evaluation quarantines the candidate
automatically. Promotion needs passing `static-review`, `sandbox`,
`functional`, and `safety` evaluations.

## From an improvement candidate

`kxm improve report` proposes a `skill` candidate as a diff that adds a
`SKILL.md` draft (`kxm-routing-improve`).

1. Review the proposed `SKILL.md` draft with the user and rewrite it into
   real instructions.
2. Save it outside `.kxm/skills`, for example under `/tmp/<name>/SKILL.md`.
3. Run
   `kxm skills create --file <draft> --name <name> --created-by <id> --harness claude-code --models <models> --run <ids> --receipt <refs>`.
4. Record the evaluations above.

Never apply the candidate diff into `.kxm/skills`. `kxm skills list --state candidate`
ignores a hand-written `.kxm/skills/candidates/<slug>/SKILL.md`; only
`kxm skills create` registers a candidate with its pinned hash and history.

## Operator steps

Promotion and rejection belong to a non-author: the user or another
authorized reviewer, never the agent that created the candidate.

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm skills promote <skillId>` | Promote a candidate that passed the required evaluations; writes a patch for review | `--decided-by` (must differ from the author), `--evidence`, `--reason` |
| `kxm skills reject <skillId>` | Reject a candidate; history is retained | `--decided-by`, `--reason` |

Promotion requires durable evidence. A candidate cannot grant tools, skip
review, or auto-promote bundled skills.
