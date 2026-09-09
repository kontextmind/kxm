---
name: kxm-runs
description: Create and inspect local vNext runs while preserving current execution-status boundaries.
---

# KXM Runs

`kxm run` creates a vNext run (offline-first; steps do not execute until the
run engine lands). Inspect with `kxm runs`. Do not invent get/create/logs
verbs under `runs`.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm run [workflow] [prompt...]` | Create a vNext run (prompt is hashed, never stored raw) | `--json` |
| `kxm runs list` | List recent runs for the current project | `--json` |
| `kxm runs status <runId>` | Show projected run status | `--json` |
| `kxm runs cancel <runId>` | Durably request cancellation | `--json` |

```bash
kxm run default "implement the bounded slice" --json
kxm runs list --json
kxm runs status run_12345 --json
kxm runs cancel run_12345 --json
```

Created runs remain `created` until the engine executes. Do not treat listing
or status as proof that steps ran.
