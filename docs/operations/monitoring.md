# Monitor KXM

Check that the [hub](../glossary.md#hub) and the [Runtime](../glossary.md#runtime) supervisor are healthy, watch live work in the terminal dashboard, scrape Prometheus metrics, and read the structured logs. This page is for operators running KXM as a service. You end with a health check, a metrics scrape, log shipping, and a short list of alerts worth setting.

## Before you begin

- A hub started with `kxm hub start` (see [Deploy KXM](deploy.md)).
- The admin token for `/metrics`, the operations endpoints and `kxm tenant status`. Health probes need no token, and a project token is enough for the dashboard's fallback mode.
- For Runtime checks, a KXM project (`kxm init`) on the machine that runs the supervisor.

## Check health from the command line

Three read-only commands cover the whole machine:

```bash
kxm hub view          # hub /health and /ready, and whether the URL is loopback or remote
kxm runtime status    # supervisor liveness plus per-project sync state
kxm tenant status     # hub metadata and Runtime runs as one labelled view
```

Expected output:

```text
hub health=true ready=true · loopback hub
runtime supervisor running: rtm_74573b9df67705d8f6596518 pid 41437 on 127.0.0.1:50724
sync prj_a17d607765e144cd95b93a8715d360b6: ok (pending 0, acked 1, refused 0)
tenant prj_a17d607765e144cd95b93a8715d360b6 @ http://127.0.0.1:7331 (loopback)
hub 0/0 agents online, 0 hub runs, 0 open messages
runtime 1 runs (authoritative, on this box)
cross-check: unavailable — no run id appears in both sources (independent id spaces)
```

`kxm hub view` exits `1` when either probe fails, and `kxm runtime status` exits `1` when the supervisor is not running, so both work in a health timer. Add `--json` for machine-readable results. The sync states are explained in [Operate Runtime sync and leases](runtime-sync.md#check-sync-status).

### Probe the hub directly

The hub serves two unauthenticated probes. Neither counts against the rate limit.

| Endpoint | Use it for | Success |
|---|---|---|
| `GET /health` | Liveness: the process answers HTTP | `200 {"ok":true,"agents":<online count>}` |
| `GET /ready` | Readiness: SQLite answers | `200 {"ok":true,"storage":"sqlite"}`; `503` when storage fails |

```bash
curl --fail --silent http://127.0.0.1:7331/ready
```

Route traffic on `/ready` and restart on `/health`.

## Watch live work with `kxm dash`

`kxm dash` opens a full-screen terminal dashboard for the current project. It never loads or renders message bodies.

```bash
kxm dash                      # opens on the Agents screen
kxm dash --screen workflows   # open on another screen
```

Without a terminal, for example in a pipe, it prints one plain snapshot and exits:

```text
 kxm dash       ● hub ok  ● ready  live ops  0/0 online  updated 18:29:32 UTC · http://127.0.0.1:7331
 [1 Agents 0/0]  2 Tasks 0   3 Workflows 0   4 Plans 0   5 Inbox 0   6 Procs 1/1   7 Spend 0
 list                          detail
 Nothing here yet              No agent selected
 tab Agents · list · 1–7 tabs · h help · a/r/d/s/c · q quit · live
```

`--json` is refused; use `kxm hub view --json` for automation.

### Screens

| Key | Screen | What it lists |
|---|---|---|
| `1` | Agents | Registered agents with hub-clocked presence (online, stale, offline), host, model and last seen; the detail pane adds lease expiry and the agent's open messages |
| `2` | Tasks | Running or waiting runs with a stage checklist, progress bar and attempt counts |
| `3` | Workflows | Recent runs with state, current stage and progress |
| `4` | Plans | Plan entries from workflow journals: age, run, stage and summary |
| `5` | Inbox | Open messages: state, sender, recipient, delivery mode and age |
| `6` | Procs | PID claims in the workspace state directory (hub and workers), live or dead |
| `7` | Spend | Always empty: it reads `telemetry.jsonl` from the workspace state directory, but KXM writes it under `.kxm/logs/`. Use `kxm routing report` |

### Where the data comes from

- **With the admin token** (header `live ops`), agents, open messages, runs and plans come from the hub's `/v1/ops/snapshot`, refreshed on every `/v1/ops/events` wake-up. The Tasks and Workflows screens then show the hub's webhook workflow runs only. Use `kxm runs list` or `kxm tenant status` for Runtime runs.
- **With a project token** (header `presence/local`), the operations endpoints refuse, so the dashboard registers a hidden observer, opens a presence-only event stream, and reads the rest from the local hub database and Runtime run stores. It refuses a hub that cannot guarantee a presence-only stream.

The dashboard uses `KXM_AUTH_TOKEN`, then the saved project token for its project, then the saved admin token. When the project has a saved project token, the dashboard therefore starts in fallback mode; export the admin token as `KXM_AUTH_TOKEN` in that terminal for admin mode.

### Keys

| Key | Action |
|---|---|
| `1`–`7` | Jump to a screen |
| `Tab` or `]`, `Shift+Tab` or `[` | Next or previous screen |
| `←`, `→` (also `Enter`, `Space`) | List pane or detail pane |
| `↑`, `↓` | Select a row |
| `PgUp`, `PgDn` (also `Ctrl+U`, `Ctrl+D`) | Scroll |
| `h` or `?` | Toggle help |
| `q`, `Ctrl+C`, `Esc` | Quit (`Esc` closes help first) |

> [!WARNING]
> The dashboard is not read-only. The keys `a`, `r`, `s` and `c` post approve, reject, signal and cancel requests to a hub route that does not exist, so they change nothing, although the status line reports the action. The `d` key does the same and then creates a Git branch and worktree under `.kxm/worktrees/` in the current directory. Act on runs with `kxm runs cancel`, `kxm gate signal` or `kxm gate degrade` instead.

## Scrape metrics

`GET /metrics` returns Prometheus text. It needs the admin token whenever the hub has one, including on loopback, and `kxm hub start` always creates one. Counters live in memory and restart from zero with the hub.

Example Prometheus job:

```yaml
scrape_configs:
  - job_name: kxm
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/kxm/admin-token
    static_configs:
      - targets: ["127.0.0.1:7331"]
```

For a one-off look, keep the token out of the process list by reading the header from a private file:

```bash
umask 077
printf 'Authorization: Bearer %s\n' "$KXM_AUTH_TOKEN" > "$HOME/.kxm-metrics-header"
curl --silent --header @"$HOME/.kxm-metrics-header" http://127.0.0.1:7331/metrics
```

| Area | Metrics |
|---|---|
| Presence and load | `kxm_online_agents` (gauge), `kxm_messages` (retained messages, gauge), `kxm_requests_total`, `kxm_errors_total`, `kxm_registrations_total` |
| Messages | `kxm_messages_sent_total`, `kxm_messages_replied_total`, `kxm_messages_cancelled_total`, `kxm_messages_expired_total`, `kxm_messages_purged_total` |
| Workflows | `kxm_webhooks_accepted_total`, `kxm_workflow_checkpoints_total`, `kxm_workflow_waits_total`, `kxm_workflow_signals_total`, `kxm_workflow_wait_timeouts_total`, `kxm_workflow_degradations_total`, `kxm_workflow_journal_entries_total` |
| Context | `kxm_context_requests_total` |
| Leases | `kxm_leases_granted_total`, `kxm_leases_refused_total`, `kxm_leases_released_total` |
| Runtime sync | `kxm_sync_events_accepted_total`, `kxm_sync_events_duplicate_total`, `kxm_sync_events_refused_total`, `kxm_sync_conflicts_total`, `kxm_runtime_heartbeats_total` |
| Reserved | `kxm_attempt_latency_seconds_total`, `kxm_metered_cost_usd_total`: exported, but the hub does not increment them yet, so they stay `0` |

The admin-only operations endpoints `GET /v1/ops/snapshot?project=<name>` and `GET /v1/ops/events?project=<name>` return project metadata and metadata-only wake-ups; they answer `503 admin_auth_not_configured` when the hub has no admin token. See the [Hub HTTP API reference](../reference/http-api.md).

## Read the logs

KXM writes JSON lines. Structured logs carry actors, project, state and request IDs, never prompt, request or reply bodies.

| Log | Default location | Rotation |
|---|---|---|
| Hub | `.kxm/logs/kxm-hub.jsonl` (`KXM_LOG_PATH`); also mirrored to stdout unless `KXM_DAEMON=1` | 10 MB, three rotated files |
| Runtime supervisor | `runtime/logs/kxm-runtime.jsonl` under the user state root | 2 MiB, three rotated files |
| Worker lifecycle | `.kxm/logs/kxm-worker-<key>.jsonl` (`KXM_WORKER_LOG_PATH`) | None; rotate externally |
| Raw Pi output | `.kxm/logs/pi-agent-<key>.log` (`KXM_AGENT_LOG_PATH`) | None; rotate externally |

The supervisor runs detached with no terminal, so its log and `kxm runtime status` are its only voice.

### What is redacted

- Log fields named like `token`, `secret`, `password`, `apiKey` or `authorization` are replaced with `[redacted]`.
- Every string value is scanned for credential shapes (API keys, GitHub tokens, bearer headers, 64-character hex strings) and those are replaced too.
- Context requests log sizes, not text: `context_packet_assembled` records `taskChars` and `taskTokens`, and `context_recall` records `queryChars` and `queryTokens`.
- Sync failures in the Runtime log are cut to 300 characters with token-like strings removed.

> [!WARNING]
> Raw `pi-agent-*.log` files hold model and tool output and can contain anything the model saw. Restrict them like secrets, and never copy them into journals, retrospectives or bug reports.

### Useful events

| Area | Hub events |
|---|---|
| Lifecycle | `hub_started`, `hub_stopping`, `request_error`, `security_alert` |
| Agents | `agent_registered`, `agent_resumed`, `agent_stale`, `agent_unregistered` |
| Messages | `message_sent`, `message_replied`, `message_cancelled`, `message_expired`, `message_purged` |
| Workflows | `webhook_workflow_started`, `workflow_checkpoint`, `workflow_wait_started`, `workflow_signal_received`, `workflow_wait_timed_out`, `workflow_degradation_approved`, `workflow_journal_recorded`, `workflow_run_purged` |
| Context | `context_packet_assembled`, `context_recall`, `context_state_proposed`, `context_state_promoted` |
| Leases and sync | `lease_acquired`, `lease_renewed`, `lease_released`, `lease_denied`, `lease_purged`, `runtime_registered` |

The Runtime log records `runtime_sync_state` (info) and `runtime_sync_stalled` (warning) once per change, not once per tick, plus `runtime_sync_retry` and `runtime_sync_context_unavailable`. Worker lifecycle events such as `worker_process_error`, `worker_exited`, `worker_tool_timeout` and `worker_session_routed` go to the worker log; see [Run supervised Pi workers](../guides/pi-workers.md).

Ship logs to an approved collector, restrict file access, and never commit them as workflow evidence; cite a protected location or a sanitized asset instead.

## Set alerts

Alert on these conditions:

- `/ready` fails for more than one minute, or the hub restarts repeatedly.
- `kxm runtime status` exits `1`, or any project reports `blocked` or `refusing`; also alert on `runtime_sync_stalled` in the Runtime log.
- `kxm_errors_total` or HTTP 429 responses rise faster than usual.
- `kxm_messages` keeps growing although `kxm_messages_purged_total` advances.
- `security_alert` appears, or `kxm_sync_conflicts_total` increases.
- `kxm_workflow_wait_timeouts_total` rises, or waiting runs outlast the expected external latency.
- `kxm_workflow_degradations_total` increases outside a declared incident or change window.
- Webhook signature rejections (HTTP 401 on `/v1/webhooks/...`) or provider retries climb.
- Free disk space nears the database's expected growth margin.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/metrics` returns 401 on loopback | The hub has an admin token, so loopback is no longer open | Send the admin token |
| The dashboard header shows `presence/local` instead of `live ops` | It found a project token before the admin token | Export the admin token as `KXM_AUTH_TOKEN` in that terminal |
| Tasks and Workflows are empty while Runtime runs exist | Admin mode lists hub workflow runs only | Use `kxm runs list` or `kxm tenant status` |
| Spend is always empty | The screen reads `telemetry.jsonl` from the workspace state directory, but KXM writes it under `.kxm/logs/` | Use `kxm routing report` for Runtime attempt costs |
| No Runtime log file | The supervisor writes its log on the first sync state change | Wait one sync tick (10 seconds), then check again |

## Next steps

- Diagnose a failing check: [Troubleshoot KXM](troubleshooting.md)
- Fix sync problems: [Operate Runtime sync and leases](runtime-sync.md)
- Protect the state you are watching: [Back up and restore KXM](backup-and-restore.md)
- Every command used here: [CLI reference](../reference/cli-reference.md)
