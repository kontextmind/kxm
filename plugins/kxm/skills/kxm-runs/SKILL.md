---
name: kxm-runs
description: Create and inspect local KXM runs while preserving current execution-status boundaries.
---

# KXM Runs

`kxm run` creates a KXM run (offline-first; steps do not execute until the
run engine lands). Inspect with `kxm runs`. Do not invent get/create/logs
verbs under `runs`.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm run [workflow] [prompt...]` | Create a KXM run (prompt is hashed, never stored raw) | `--json` |
| `kxm runs list` | List recent runs for the current project | `--json` |
| `kxm runs status <runId>` | Show projected run status | `--json` |
| `kxm runs receipt <runId>` | Print the newest drive receipt for a run | `--json`, `--all` |
| `kxm runs drive <runId> --wait` | Drive a run, then wait for a receipt; exits 0 only for a VERIFIED COMPLETED settlement | `--json`, `--simulated`, `--timeout-ms` (default 60000, max 600000) |
| `kxm runs cancel <runId>` | Durably request cancellation | `--json` |

```bash
kxm run default "implement the bounded slice" --json
kxm runs list --json
kxm runs status run_12345 --json
kxm runs receipt run_12345 --json
kxm runs drive run_12345 --simulated --wait --timeout-ms 60000 --json
kxm runs cancel run_12345 --json
```

Created runs remain `created` until the engine executes. Do not treat listing
or status as proof that steps ran.
