---
name: kxm-harness-auth
description: Inspect authenticated harness capability and operate supported runtimes/workers without inventing fallback.
---

# KXM Harness and Auth

`kxm harness list` is observational (`yes|no|unknown`). `unknown` and `no` are
never eligible. Do not invent install/login/status verbs. Native harnesses
keep their own login; do not silently bill through Pi.

## Commands

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm harness list` | Installed harnesses, auth, and native updaters | `--json` |
| `kxm auth token` | Inspect, issue, or clear local session tokens | `--status`, `--clear`, `--issue` |
| `kxm update [harness]` | Update kxm, harness CLIs, extensions, catalogs | `--check`, `--kxm`, `--self`, `--extensions`, `--models` |
| `kxm runtime start` | Start the Runtime supervisor | `--json` |
| `kxm runtime status` | Supervisor liveness | `--json` |
| `kxm runtime stop` | Stop the supervisor | `--json` |
| `kxm agent worker` | Start a long-lived Pi worker | `--name`, `--project`, `--model`, `--fallback-models`, `--tools`, `--session-isolation`, `--no-continue`, `--fresh-start` |

```bash
kxm harness list --json
kxm auth token --status --json
kxm update --check --json
kxm update --models
kxm runtime status --json
```

Only Pi is a supervised RPC worker (`kxm agent worker` / `pi --mode rpc`).
Grok and agy are one-shot headless CLIs, not workers. Listing a harness does
not grant edit permission or writer admission.
