---
name: kxm-session
description: Set up a local KXM hub session brief — recent tasks/plans, status-line stats, and harness chrome. Use when starting a new session, running kxm init, kxm hub bind, or configuring a status bar. Local-only Runtime insights and SSH/remote hubs are after MVP.
---

# KXM session (hub local)

MVP is a **local hub** on this machine. Work is agents and workflows. Do not configure hub chrome for local-only init.

## Tracks

| Track | When | What this skill does |
|---|---|---|
| **Local-only** | `kxm init` (project-only) | Skip hub start, skip session brief, skip status-line chrome |
| **Hub local (MVP)** | `kxm hub bind <url>` | Bind this host to a running loopback hub; session brief + status line |
| **SSH / HTTPS remote** | After MVP | Fail closed. Not available |

In-harness Pi can attach to a local hub. Local Runtime workflow insights (`kxm dash` from the KXM event store) are after MVP.

## First run (hub local)

```text
kxm init
kxm hub start                 # other terminal
kxm hub bind <url>
kxm session brief
```

Keep `.kxm/config` in Git; do not recopy templates onto an existing project. `KXM_SERVER_URL` still overrides a bound URL.

## Session brief

`kxm session brief` reads the **local hub** SQLite (tasks = workflow runs, plans = journal `plan` rows). No message bodies. `--status` prints the status line for harnesses that have one.

Interactive **Pi TUI**: on `startup` / `/new` / `/fork`, the kxm extension offers recent tasks/plans and paints the footer + widget (including a `ship` line: dirty vs local commits vs PR after CI). `/kxm` reopens the picker. `/kxm status` refreshes chrome only. `/kxm hub` is hub view. Workers, RPC, and print mode never prompt. `KXM_SESSION_BRIEF=off` disables the picker only.

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
