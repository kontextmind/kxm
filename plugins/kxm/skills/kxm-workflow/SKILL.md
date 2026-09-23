---
name: kxm-workflow
description: Operate webhook workflows, waits/signals, evidence checkpoints, provenance, and deterministic gates.
---

# KXM Workflow and Gates

Use the current CLI. Peer-reply requirements need durable replied message IDs
in `--evidence-refs`. Caller-authored text never satisfies peer quorum.

## Workflow

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm workflow list` | List local workflow runs | `--json` |
| `kxm workflow get <runId>` | Show one run | `--json` |
| `kxm workflow checkpoint [runId] [stageId] [status] [summary]` | Record a stage result | `--run-id`, `--stage-id`, `--status passed\|warning\|failed`, `--summary`, `--evidence`, `--evidence-refs` |
| `kxm workflow record [runId] [category] [area] [summary]` | Journal one of ten categories | `--category`, `--area`, `--stage-id`, `--severity`, `--details`, `--evidence` |
| `kxm workflow wait [runId] [stageId] [signalKey] [summary]` | Wait for a signed callback | `--signal-key`, `--timeout-ms`, `--evidence`, `--evidence-refs` |
| `kxm workflow signal <runId> <signalKey> <status> <summary>` | Resume a wait or KXM run | `[evidence...]`, `--delivery-id` |
| `kxm workflow start [definitionId]` | POST a signed workflow-start webhook | `--payload`, `--delivery-id`, `--event` |
| `kxm workflow export <runId>` | Export a proposed retrospective | `--input`, `--out-dir` |
| `kxm workflow definitions` | List definitions | `--scope all\|global\|local` |
| `kxm workflow add [workflowId]` | Add a definition | `--file`, `--description`, `--scope`, `--overwrite`, `--pick` |
| `kxm workflow remove [workflowId]` | Remove a definition | `--scope`, `--pick` |
| `kxm workflow modify [workflowId]` | Modify a definition | `--description`, `--scope`, `--pick` |

## Gates

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm gate validate` | Parse workflow definitions without printing secrets | `--file` |
| `kxm gate artifacts-exist` | Verify a non-empty workspace artifact | `--path` (required) |
| `kxm gate degrade <runId> <stageId>` | Approve a configured lower peer quorum | `--requirement`, `--reason` |
| `kxm gate signal <runId> <signalKey> <status> <summary>` | Post a signed callback | `[evidence...]`, `--delivery-id` |
| `kxm gate github watch` | Poll required GitHub checks and signal | `--run-id`, `--stage-id`, `--signal-key`, `--repo`, `--pr`, `--required`, `--timeout-ms`, `--interval-ms`, `--delivery-id` |

```bash
kxm workflow list --json
kxm workflow get run_12345 --json
kxm workflow checkpoint run_12345 stage_abc passed "Implementation complete" --evidence '{"code_changes":"added feature"}' --json
kxm gate validate --file workflows/default.yaml --json
```

Journal categories: `plan`, `decision`, `contradiction`, `error`, `lesson`,
`observation`, `hypothesis`, `experiment`, `state-change`, `skill-candidate`.
`lesson` and `skill-candidate` need evidence. Pass `--stage-id` to bind an entry
to its stage: the hub derives the attempt, and area defaults to the stage's
declared area, so `kxm workflow record <runId> <category> <summary> --stage-id
<id>` works without an area. Never supply an attempt. The journal covers hub
webhook runs; a `kxm run` ID is `workflow_not_found`.

```bash
kxm workflow record run_12345 lesson "Flaky test hid a race" --stage-id verify --evidence https://ci.example.com/run/42 --json
```

Do not invent `gate list`, `gate run`, or `gate status`.
