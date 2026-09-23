---
name: kxm-tasks
description: Recommend workflows and manage goals and tasks with explicit SCM and tracker boundaries. Use when asked what workflow fits, to plan work as goals and tasks, or to sync with GitHub or Jira. Run a kxm suggest workflow ID only after kxm workflow definitions lists it.
---

# KXM suggest, goals, and tasks

Bind SCM and issue trackers from this repo's conventions. Implemented today:
GitHub and Jira. An unimplemented tracker fails closed. Do not invent
`suggest workflows` or extra task verbs.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm suggest <prompt...>` | Recommend workflow, area, roles, and skills | `--json` |
| `kxm goal create <title>` | Create a project goal | `--area`, `--metric`, `--target-date` |
| `kxm goal list` | List project goals | `--json` |
| `kxm task create <title>` | Create a task | `--goal`, `--objective`, `--workflow`, `--tracker github\|jira`, `--issue <number-or-key>` |
| `kxm task list` | List project tasks | `--goal`, `--status todo\|in_progress\|blocked\|in_review\|done` |
| `kxm task get <taskId>` | Task details and linked workflow status | `--json` |
| `kxm task run <taskId>` | Launch a workflow run driven by this task | `--json` |
| `kxm task sync <taskId>` | Sync status and evidence with the linked issue board | `--json` |

```bash
kxm suggest "implement trusted roster policy brakes" --json
kxm workflow definitions
kxm goal create "Land the skills suite" --area software-engineering --json
kxm task create "Repair trust loader" --goal goal_1 --tracker github --issue 127 --json
kxm task list --status in_progress --json
kxm task sync task_1 --json
```

## Suggested workflows

`kxm suggest` picks its workflow ID from a built-in catalog, and that ID may
not exist in this project. Before running the suggested `kxm run` command,
confirm that `kxm workflow definitions` lists the ID; otherwise `kxm run`
fails with `run_workflow_unknown`. Pick a listed workflow instead, or write
one with the user (`kxm-project-setup`).

`--issue` on `kxm task create` is a tracker issue number or Jira key, not a
credential. In this build `kxm task sync` marks only the local task record
synced; it does not contact GitHub or Jira. Do not silently use GitHub when
the operator picked an unimplemented tracker.
