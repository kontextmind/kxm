---
name: kxm-runs
description: Create, drive, and inspect local KXM runs. kxm runs drive with --simulated executes a run model-free and settles it with a verified receipt. Use when asked to start a workflow run, check its status, read its receipt, cancel it, or smoke-test a workflow.
---

# KXM runs

`kxm run` creates a run of a project workflow in the local Runtime and starts
the Runtime supervisor. A created run stays `created` until
`kxm runs drive` executes it. Do not invent get, create, or logs verbs under
`runs`.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm run [workflow] [prompt...]` | Create a run; the prompt is hashed, never stored raw | `--dry-run` (plan only), `--json` |
| `kxm runs drive <runId>` | Drive a run; with `--wait`, exits 0 only for a verified completed settlement | `--simulated`, `--wait`, `--timeout-ms <n>` (default 60000, max 600000), `--json` |
| `kxm runs status <runId>` | Projected run status plus drive receipt state (open, receipt verified, unsettled, orphaned) | `--json` |
| `kxm runs receipt <runId>` | Newest drive receipt for a run | `--all`, `--json` |
| `kxm runs cancel <runId>` | Durably request cancellation | `--json` |
| `kxm runs list` | Recent runs for the current project | `--json` |

`kxm runs drive <runId> --simulated --wait [--timeout-ms <n>]` executes the run
with the model-free simulation producer. Always pass `--simulated`; without it,
drive calls live harnesses. When you are finished, stop the supervisor with
`kxm runtime stop`.

## Smoke-test the first workflow

Run this only after the user has reviewed and committed
`.kxm/workflows/first.yaml` (`kxm-project-setup`, phase 2), so
`kxm trust check` exits 0.

```bash
kxm run first "add a hello script" --dry-run
kxm run first "add a hello script" --json
kxm runs status run_12345
kxm runs drive run_12345 --simulated --wait --timeout-ms 60000 --json
kxm runs status run_12345
kxm runs receipt run_12345 --json
kxm runs list
kxm runtime stop
```

The dry run prints `run plan: workflow first at sha256:… (no run created)`.
After the drive, `kxm runs status` prints `completed … (receipt verified)` and
the receipt's settlement is terminal `completed`.

## Refusals

- `run_workflow_unknown`: the workflow ID is not a project workflow. Run only
  IDs that `kxm workflow definitions` lists.
- `run_handoff_required`: the Runtime does not execute a field the workflow
  uses, so drive fails with `runtime request failed with HTTP 409` and the run
  stays `preparing`. The template `default` workflow declares
  `limits.maxAgentTimeMs`, which is one such field. Cancel the run with
  `kxm runs cancel <runId>` and drive a workflow without the field, such as
  `first`.

Listing or status alone is not proof that steps ran; a verified receipt is.
`kxm workflow list` shows hub webhook runs, not these runs.
