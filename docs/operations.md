# Operations guide

This guide covers the production envelope for one Pi Mesh Comms hub and one SQLite database.

## Deployment classification

Version `0.4.x` is designed for local workstations and controlled trusted-team hosts. It provides durable restart recovery, project authentication, signed webhook workflows, traffic limits, health signals, metrics, structured logs, and graceful shutdown.

It is not a clustered or multi-tenant control plane. Run one writer for each database. Do not place a load balancer across independent hubs and expect shared presence or delivery.

## Start and stop

```powershell
$env:PI_MESH_HOST = "127.0.0.1"
$env:PI_MESH_AUTH_TOKEN = "replace-with-a-long-random-token"
$env:PI_MESH_WORKSPACE_DIR = "D:\work\product\.kxm"
npm run hub
```

Stop with `Ctrl+C` or `SIGTERM`. The hub stops accepting connections, closes SSE streams, waits for active HTTP connections, and closes SQLite.

For unattended service, use a supervisor that sets a stable working directory, injects secrets, captures stdout, restarts after failure, and allows at least five seconds for graceful shutdown.

Run each long-lived coordinator with `pi-mesh worker --name <stable-name> --project <project> [--model <provider/model>]` under a separate service-manager unit. Use distinct worktrees for concurrent writers, explicit CPU and memory limits, and restart throttling outside the built-in bounded backoff. The worker launches Pi RPC mode and retains the most recent session unless configured otherwise. `pi-mesh stop` writes a generation-matched control request; the worker asks Pi RPC to abort, waits for confirmation and state flush, and only force-stops the process tree after the bounded drain deadline. If `--continue` reports an invalid tool-result session, the worker retries once fresh, journals a redacted recovery envelope, and injects a bounded resume instruction for the durable run and stage. Do not copy `pi-agent-*.log` into journals or retrospectives.

For GitHub-backed waits, run `pi-mesh github watch` as a separate command. The hub does not poll GitHub. Success, failure, cancellation, and timeout produce the exact signed signal for the waiting run/stage/key; timeout exits `4` after posting `failed`.

## Real multi-Pi release smoke

The opt-in release smoke requires two distinct models that already pass `pi auth check`. It creates a temporary workspace, launches two real Pi RPC workers, and verifies discovery, request/reply, fanout, durable identity plus a post-restart exchange, journal persistence, checkpoint completion, and cleanup.

PowerShell:

```powershell
$env:PI_MESH_SMOKE = "1"
$env:PI_MESH_SMOKE_MODELS = "xai/grok-4.6,anthropic/claude-sonnet-4-5"
node scripts/smoke-multi-pi.mjs
```

POSIX shell:

```bash
PI_MESH_SMOKE=1 PI_MESH_SMOKE_MODELS='xai/grok-4.6,anthropic/claude-sonnet-4-5' node scripts/smoke-multi-pi.mjs
```

For GitHub Actions, configure `PI_MESH_SMOKE_RUNNER` with the self-hosted runner label and `PI_MESH_SMOKE_MODELS` with the two model IDs as repository variables. A manual dispatch can override the model variable with its `models` input. Model credentials stay on the runner and are never workflow inputs.

## Health, readiness, and metrics

| Endpoint | Authentication | Meaning |
|---|---|---|
| `GET /health` | None | Process is accepting HTTP and reports online agents |
| `GET /ready` | None | Storage responds and the hub is ready for traffic |
| `GET /metrics` | Administrative token outside loopback | Prometheus text metrics |

Use `/ready` for service traffic and `/health` for liveness. Metrics include online agents, retained messages, requests, errors, registrations, sends, replies, cancellations, expiries, purges, workflow waits, external signals, and wait timeouts.

Structured JSON logs are written to `.kxm/logs/pi-mesh-hub.jsonl` and mirrored to stdout. They include request IDs and event metadata but omit prompt and reply bodies. Worker lifecycle events use `.kxm/logs/pi-mesh-worker-<agent>.jsonl`; raw headless Pi stdout and stderr use `.kxm/logs/pi-agent-<agent>.log` and may contain sensitive model or tool output. Useful hub events include `agent_registered`, `agent_resumed`, `agent_stale`, `message_sent`, `message_replied`, `message_cancelled`, `message_expired`, `message_purged`, `webhook_workflow_started`, `workflow_checkpoint`, `workflow_wait_started`, `workflow_signal_received`, `workflow_wait_timed_out`, `workflow_journal_recorded`, and `request_error`.

Runtime logs are ignored by Git. Ship them to an approved collector, restrict file access, and apply retention or rotation outside the process before unattended use. Never commit them as workflow evidence; reference a protected log location or sanitized asset instead.

Recommended alerts:

- readiness fails for more than one minute;
- errors or rate-limit responses rise unexpectedly;
- the process restarts repeatedly;
- retained-message count grows despite the retention policy;
- free disk space approaches the database's expected growth margin.
- webhook signature rejections, repeated provider retries, premature workflow settlement, or attempt exhaustion increase.
- waiting-run count or workflow wait timeouts rise beyond the expected external-system latency.

## Backup and restore

SQLite runs in WAL mode. The safest simple backup is a coordinated copy while the hub is stopped:

1. Stop the hub gracefully.
2. Copy `.kxm/state/mesh.db` to protected backup storage.
3. Keep the backup with the application version and configuration used to create it.
4. Restart the hub and confirm `/ready` returns `ok: true`.

For online backups, use a SQLite-aware backup tool or snapshot the database, `-wal`, and `-shm` files consistently. A plain copy of only `mesh.db` while the service is writing may omit committed WAL data.

To restore, stop the hub, preserve the current files for rollback, place the restored database at `.kxm/state/mesh.db` or the configured `PI_MESH_DATA_PATH`, and start the same or newer compatible release. The runtime refuses a database whose schema version is newer than it supports.

Test restoration periodically. A backup that has never been restored is not a verified recovery path.

## Upgrade and rollback

1. Back up the database and record the current package version.
2. Run `npm ci` for the target checkout.
3. Stop the old hub gracefully.
4. Start the new version against the database and verify `/ready`, `/metrics`, and a test round trip.
5. Restart agents only if their clients do not reconnect automatically.

For rollback, stop the new version and restore both the earlier application and its pre-upgrade database backup. Do not open a newer-schema database with an older runtime.

## Network and secret security

Loopback is the safest default. Before binding elsewhere, configure an administrative token, assign project tokens, terminate TLS at a trusted proxy, restrict inbound networks, disable proxy buffering for `/v1/events`, and protect the SQLite directory.

The database is not encrypted by the application. Use encrypted storage when messages require encryption at rest. Rotate a disclosed token and reconnect affected agents. Never expose the hub directly to the public internet.

## Capacity and failure behavior

The service uses one Node.js process, long-lived SSE connections, and one SQLite writer. Measure concurrent agents, request rate, event-loop delay, database size, disk latency, and reconnect frequency for your workload. The in-memory rate-limit ledger resets after process restart.

| Failure | Behavior | Recovery |
|---|---|---|
| Agent exits | Marked offline after the stale threshold | Restart with the same name to resume its ID |
| SSE drops | Client reconnects while heartbeats continue | Check network and proxy buffering if repeated |
| Hub exits | SQLite keeps agents and messages | Restart; agents reconnect and queued work resumes |
| Token rotates | Requests fail authentication | Restart agents with the new project token |
| Disk unavailable | Readiness or writes fail | Restore storage, then verify database integrity and readiness |
| Duplicate live name | Registration returns HTTP 409 | Stop the old session or choose another name |
| External callback is lost | Run stays `waiting` until its deadline | Retry with the same delivery ID or investigate the provider before timeout |
| External wait expires | Run and active stage fail; journal records the timeout and the coordinator receives a terminal notification | Fix delivery/routing, review side effects, then start a new safe workflow delivery |
| Pi executable cannot spawn | Worker records the process error and applies its normal restart/backoff limit | Repair `PATH` or `PI_MESH_PI_COMMAND`; confirm the worker exits nonzero when retries are exhausted |

Durable transport does not make peer execution exactly once. Use idempotent tasks and stable message idempotency keys, and store important artifacts in Git or another system of record.

## Remaining scale boundaries

Broader deployments need shared state and coordination, external identity and fine-grained authorization, distributed traffic controls, defined service-level objectives, load and chaos testing, and a formal long-term schema migration strategy.
