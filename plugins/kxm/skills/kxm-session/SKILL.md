---
name: kxm-session
description: Set up a local KXM hub session brief — recent tasks/plans, status-line stats, and harness chrome. Use when starting a new session, running kxm init --hub, or configuring a status bar. Local-only Runtime insights and SSH/remote hubs are after MVP.
---

# KXM session (hub local)

MVP is a **local hub** on this machine. Work is agents and workflows. Do not configure hub chrome for local-only init.

## Tracks

| Track | When | What this skill does |
|---|---|---|
| **Local-only** | `kxm init` with no `--hub` | Skip hub start, skip session brief, skip status-line chrome |
| **Hub local (MVP)** | `kxm init --hub existing` or `--hub new` | Use or start a loopback hub with this project's Git config; session brief + status line |
| **SSH / HTTPS remote** | After MVP | Fail closed. Not available |

In-harness Pi can attach to a local hub. Local Runtime workflow insights (`kxm dash` from the vNext event store) are after MVP.

## Init (hub opt-in)

```text
kxm init                  # local-only; no hub
kxm init --hub existing   # existing hub, existing or new project config
kxm init --hub new        # new local hub, existing Git project config
kxm init --hub existing --hub-url http://127.0.0.1:7331
```

`--hub ssh` / remote install is not available. Keep `.kxm/config` in Git; do not recopy templates onto an existing project.

New local hub:

```text
kxm hub start
kxm hub view
kxm session brief
```

Existing hub: set `KXM_SERVER_URL` (and project token) to that hub, then `kxm hub view` / `kxm session brief`.

## Session brief

`kxm session brief` reads the **local hub** SQLite (tasks = workflow runs, plans = journal `plan` rows). No message bodies. `--status` prints the status line for harnesses that have one.

Interactive **Pi TUI**: on `startup` / `/new` / `/fork`, the kxm extension offers recent tasks/plans and paints the footer + widget. `/kxm` reopens the picker. `/kxm status` refreshes chrome only. `/kxm hub` is hub view (replaces `/mesh-status`). Workers, RPC, and print mode never prompt. `KXM_SESSION_BRIEF=off` disables the picker only.

## Harness support (fail closed)

| Harness | Picker | Status line | Setup |
|---|---|---|---|
| Pi TUI | Yes, extension | Yes, `setStatus` + widget | Load the kxm extension (default from the package) |
| Pi RPC / worker | No | Status only if UI helpers exist; never a picker | Skip |
| Claude Code | No coded picker | Only if the operator points `statusLine` at `kxm session brief --status` | Do not invent chrome |
| Codex, Kimi, Gemini, DeepSeek | Unknown | None unless that CLI documents a status command | Skip chrome; first reply may run `kxm session brief` |

This skill never grants tools or permissions.

## Operator loop

1. Confirm hub local: `kxm hub view`.
2. `kxm session brief` or Pi `/kxm`.
3. Pick a task/plan or start fresh.
4. Live peek remains `kxm dash` (tasks / plans tabs).
