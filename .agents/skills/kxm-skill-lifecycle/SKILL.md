---
name: kxm-skill-lifecycle
description: Govern candidate/evaluate/promote/quarantine/reject/verify lifecycle; distinguish this from bundled skills.
---

# KXM Governed Skills

This is the governed candidate lifecycle, not the bundled `plugins/kxm/skills`
suite. Bundled skills are authored in Git and mirrored to `.agents/skills`.
Do not invent `candidate`, `quarantine`, `rollback`, `validate`, or `get`.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm skills create` | Submit a candidate from verified episodes | `--file`, `--name`, `--description`, `--created-by`, `--run`, `--journal`, `--receipt`, `--harness`, `--models`, `--supersedes` |
| `kxm skills evaluate <skillId>` | Record a protected evaluation | `--kind static-review\|sandbox\|functional\|safety\|optimization`, `--evaluator`, `--fail`, `--score`, `--details` |
| `kxm skills promote <skillId>` | Promote a candidate that passed required evaluations | `--decided-by`, `--evidence`, `--reason` |
| `kxm skills reject <skillId>` | Reject a candidate; history is retained | `--decided-by`, `--reason` |
| `kxm skills list` | List skills by state | `--state candidate\|promoted\|quarantined\|rejected` |
| `kxm skills verify <skillId>` | Verify pinned content hash | `--state candidate\|promoted\|quarantined\|rejected` |

```bash
kxm skills list --state candidate --json
kxm skills evaluate skill_123 --kind static-review --evaluator eval-1.0.0 --json
kxm skills promote skill_123 --decided-by agent_reviewer --evidence receipt:run_1/verify --json
kxm skills verify skill_123 --state promoted --json
```

Promotion requires durable evidence and a non-author decision. A candidate
cannot grant tools, skip review, or auto-promote bundled skills.
