---
name: kxm-workflow
description: Work inside a durable KXM workflow run. Read it, record journal entries in any of the ten categories (plan, decision, contradiction, error, lesson, observation, hypothesis, experiment, state-change, skill-candidate) bound to a stageId, pass stage checkpoints with keyed evidence and peer evidence refs, wait for signed CI or review callbacks, start webhook workflows, and export retrospectives (kxm_workflow_get, kxm_workflow_record, kxm_workflow_checkpoint, kxm_workflow_wait). Use when a workflow run ID is involved or the user asks to checkpoint, gate, or wait on CI.
---

# KXM workflow and gates

Durable workflow runs live on the hub and start from signed webhooks. Read the
run first (`kxm_workflow_get` or `kxm workflow get <runId>`), record material
plans, decisions, contradictions, errors, and lessons as you work, and pass
every stage checkpoint before replying.

Peer-reply requirements need durable replied message IDs in
`--evidence-refs` (MCP `evidenceRefs`). Caller-authored text never satisfies
peer quorum.

`kxm workflow list` and `kxm workflow get` show hub webhook runs. Runs created
with `kxm run` are Runtime runs; inspect them with `kxm runs list`
(`kxm-runs`).

## Workflow

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm workflow list` | List hub workflow runs in the local store | `--json` |
| `kxm workflow get <runId>` | Show one run with its stages and journal | `--json` |
| `kxm workflow checkpoint [runId] [stageId] [status] [summary]` | Record a stage result | `--run-id`, `--stage-id`, `--status passed\|warning\|failed`, `--summary`, `--evidence <json>`, `--evidence-refs <json>` |
| `kxm workflow record [runId] [category] [area] [summary]` | Journal one of ten categories | `--category`, `--area`, `--stage-id`, `--severity info\|warning\|error`, `--summary`, `--details`, `--evidence <items...>`, `--related-entry-ids <ids...>` |
| `kxm workflow wait [runId] [stageId] [signalKey] [summary]` | Wait for a signed callback | `--signal-key`, `--summary`, `--timeout-ms`, `--evidence <json>`, `--evidence-refs <json>` |
| `kxm workflow signal <runId> <signalKey> <status> <summary>` | Resume a wait or unblock a KXM run | `[evidence...]` as `required-key=evidence`, `--delivery-id` |
| `kxm workflow start [definitionId]` | POST a signed workflow-start webhook | `--payload <json\|@file>`, `--delivery-id`, `--event` |
| `kxm workflow export <runId>` | Export a proposed retrospective | `--input`, `--out-dir` |
| `kxm workflow definitions` | List project and global workflow definitions | `--scope all\|global\|local` |
| `kxm workflow add [workflowId]` | Add a definition | `--template spec-and-plan\|implement-and-verify\|dual-critic-review`, `--file`, `--description`, `--scope`, `--overwrite`, `--pick` |
| `kxm workflow remove [workflowId]` | Remove a definition | `--scope`, `--pick` |
| `kxm workflow modify [workflowId]` | Modify a definition | `--description`, `--scope`, `--pick` |

`kxm workflow add <id> --template <spec-and-plan|implement-and-verify|dual-critic-review>`
writes a complete definition to `.kxm/workflows/<id>.yaml` (the default local
scope); the file name is the workflow ID. `spec-and-plan` only reads (`plan`,
then `review-arch`). `implement-and-verify` and `dual-critic-review` add an
`implement` step with write access and the `test` gate. Validate with
`kxm init`, then have the user review the `kxm trust diff` expansion and
commit it (`kxm-project-setup`).

```bash
kxm workflow get run_12345 --json
kxm workflow checkpoint run_12345 implement passed "Implementation complete" --evidence '{"tests":"npm test passed"}' --json
kxm workflow wait run_12345 verify github-pr-42-checks "CI running on PR 42" --json
```

## Journal

Categories are `plan`, `decision`, `contradiction`, `error`, `lesson`,
`observation`, `hypothesis`, `experiment`, `state-change`, and
`skill-candidate`. A `lesson` or `skill-candidate` requires `--evidence`; the
hub refuses one without it. Pass `--stage-id` to bind an entry to its stage:
the hub derives the attempt, and area defaults to the stage's declared area,
so `kxm workflow record <runId> <category> <summary> --stage-id <id>` works
without an area. Never supply an attempt. Link a decision or lesson that
resolves a contradiction with `--related-entry-ids`. The journal covers hub
webhook runs; a `kxm run` ID is `workflow_not_found`.

```bash
kxm workflow record run_12345 lesson "Flaky test hid a race" --stage-id verify --severity warning --evidence https://ci.example.com/run/42 --json
kxm workflow record run_12345 decision "Serialize the fixture setup" --stage-id verify --related-entry-ids je_123 --json
```

## Gates

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm gate validate` | Parse JSON webhook workflow definitions without printing secrets | `--file <path>` |
| `kxm gate artifacts-exist` | Verify a non-empty file under workspace assets | `--path` (required) |
| `kxm gate degrade <runId> <stageId>` | Approve a configured lower peer quorum | `--requirement`, `--reason` |
| `kxm gate signal <runId> <signalKey> <status> <summary>` | Post a signed callback | `[evidence...]`, `--delivery-id`, `--recovery-action retry\|fail\|cancel\|unblock` |
| `kxm gate github watch` | Poll required GitHub checks and signal | `--run-id`, `--stage-id`, `--signal-key`, `--repo`, `--pr`, `--required`, `--timeout-ms`, `--interval-ms`, `--delivery-id` |

`kxm gate validate` reads the hub's webhook definitions (`--file`, else
`KXM_WEBHOOK_WORKFLOWS_FILE` or `KXM_WEBHOOK_WORKFLOWS`), which are JSON. It
does not read project `.kxm/workflows/*.yaml`; validate those with
`kxm init --dry-run --json`.

`kxm gate signal` on a run this project's Runtime store holds goes to the
Runtime and passes `--recovery-action` through; on a hub webhook run, including
one with the same `run_` + 32-hex shape, it posts a signed callback that needs
`KXM_WORKFLOW_ID` and the definition's signal secret. Reuse `--delivery-id` to retry one unchanged callback.

```bash
kxm gate validate --file workflows.json --json
kxm gate signal run_0123456789abcdef0123456789abcdef verify passed "operator verified" --recovery-action unblock --dry-run
```

Do not invent `gate list`, `gate run`, or `gate status`.
