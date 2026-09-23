---
name: kxm-session
description: Read KXM session and hub status with kxm session status and kxm hub view, create a session manifest with kxm session start, open kxm dash screens, and lay out workflows with kxm studio layout. Use at the start of a session, when asked what is in flight, or when opening the dashboard. kxm session brief, kxm session stop, and kxm studio serve are operator steps because they save a 24-hour session token, stop the hub, or open a listener.
---

# KXM session

Start a session by reading status. The agent steps below write no token and
start no process.

## Agent steps

| Command | Purpose | Options / arguments |
|---|---|---|
| `kxm session status` | Session claims and recovery envelopes | `--json` |
| `kxm hub view` | Hub `/health` and `/ready`; exits 1 when the hub is down | `--json` |
| `kxm session start` | Create an agent/gate or workflow session manifest; launches nothing | `--id`, `--workflow`, `--mix`, `--json` |
| `kxm dash` | Live screens for agents, tasks, workflows, and plans | `--screen agents\|tasks\|workflows\|plans\|inbox\|procs\|spend` |
| `kxm studio layout [workflowPath]` | DAG, stepper, and swimlane layout JSON for a workflow | `--json` |

At the start of a session, run `kxm session status` and `kxm hub view`. In a
repository with no session token file both leave the user config directory
and the Git tree unchanged. `kxm session status` prints
`0 session claim(s), 0 recovery envelope(s)` on a fresh project, and
`kxm hub view` prints `hub health=false ready=false · loopback hub` and exits 1
while the hub is down.

## Hub binding

| Track | When | What to do |
|---|---|---|
| Local only | `kxm init` without a hub | Work with runs and Git memory; skip hub status chrome |
| Local hub | The user ran `kxm hub bind http://127.0.0.1:7331` | Read status with `kxm hub view` |
| Remote hub | The user ran `kxm hub bind <https-url>` | Binds when a credential resolves; otherwise it fails closed with `hub_bind_unauthenticated` |

`KXM_SERVER_URL` overrides a bound URL. Binding is an operator step owned by
`kxm-hub-ops`.

## Harness support (fail closed)

| Harness | Picker | Status line | First reply |
|---|---|---|---|
| Pi TUI | Yes, kxm extension | Yes, `setStatus` plus widget | Load the kxm extension (default from the package) |
| Pi RPC / worker | No | Only if UI helpers exist; never a picker | Skip chrome |
| Claude Code | No picker | The plugin's SessionStart hook adds a short KXM brief only in projects with `.kxm`; a statusLine is optional and an operator step | Run `kxm session status` and `kxm hub view` |
| Codex, Kimi, Gemini, DeepSeek | Unknown | None unless that CLI documents a status command | Run `kxm session status` and `kxm hub view` |

Interactive Pi TUI: on `startup`, `/new`, and `/fork`, the kxm extension offers
recent tasks and plans and paints the footer and widget, including a `ship`
line (dirty tree, local commits, PR after CI). `/kxm` reopens the picker,
`/kxm status` refreshes chrome only, and `/kxm hub` is the hub view. Workers,
RPC, and print mode never prompt. `KXM_SESSION_BRIEF=off` disables the picker
only.

This skill never grants tools or permissions.

## Operator steps

Ask the user to run these in their own terminal.

Until kxm session brief stops minting tokens, running it saves a 24-hour
operator session token; when that token expires every kxm_* tool fails with
tool_policy_denied. Its plain output prints a Session token line, so never
paste it into a conversation.

| Command | Purpose | Options |
|---|---|---|
| `kxm session brief` | Recent tasks (hub workflow runs from the local hub store and Runtime runs under the user state root) and plans (journal `plan` rows); every form saves the session token | `--status` (status line only), `--json` |
| `kxm session token --status` | Report the active session token | `--json` |
| `kxm session token --clear` | Delete the session token file | `--json` |
| `kxm session stop` | Request managed hub and worker shutdown | `--wait-ms <ms>` |
| `kxm studio serve` | Start the Web Studio listener (default `http://localhost:4242`) | `--port`, `--host`, `--token` |

- `kxm session token --status` reports
  `No active session token found in env or disk` for an expired or malformed
  file, even though that file still blocks every kxm_* tool. `--clear` is the
  fix for such a file.
- Claude Code statusLine: the user may point `statusLine` at
  `kxm session brief --status`, which saves the same 24-hour token.
- Pi operator loop: `kxm hub view`, then `kxm session brief` or Pi `/kxm`, pick
  a task or plan or start fresh, and keep `kxm dash` open for a live view.
