---
name: kxm-tasks
description: Recommend workflows and manage goals/tasks with explicit SCM/tracker boundaries.
---

# KXM Suggest, Goals, and Tasks

Bind SCM and issue trackers from this repo's conventions. Implemented today:
GitHub and Jira. An unimplemented tracker fails closed. Do not invent
`suggest workflows` or extra task verbs.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm suggest <prompt...>` | Recommend workflow, area, roles, and skills | `--json` |
| `kxm goal create <title>` | Create a project goal | `--area`, `--metric`, `--target-date` |
| `kxm goal list` | List project goals | `--json` |
| `kxm task create <title>` | Create a task | `--goal`, `--objective`, `--workflow`, `--tracker github\|jira`, `--issue` |
| `kxm task list` | List project tasks | `--goal`, `--status todo\|in_progress\|blocked\|in_review\|done` |
| `kxm task get <taskId>` | Task details and linked workflow status | `--json` |
| `kxm task run <taskId>` | Launch a workflow run driven by this task | `--json` |
| `kxm task sync <taskId>` | Sync status and evidence with the linked issue board | `--json` |

```bash
kxm suggest "implement trusted roster policy brakes" --json
kxm goal create "Land the skills suite" --area software-engineering --json
kxm task create "Repair trust loader" --goal goal_1 --tracker github --issue 127 --json
kxm task list --status in_progress --json
kxm task sync task_1 --json
```

Do not silently use GitHub when the operator picked an unimplemented tracker.
