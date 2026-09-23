# Operations guide

This guide covers the production envelope for one KXM hub and one SQLite database.

## Deployment classification

Version `0.4.x` is designed for local workstations and controlled trusted-team hosts. It provides durable restart recovery, project authentication, signed webhook workflows, traffic limits, health signals, metrics, structured logs, and graceful shutdown.

It is not a clustered or multi-tenant control plane. Run one writer for each database. Do not place a load balancer across independent hubs and expect shared presence or delivery.

## Start and stop

```powershell
$env:KXM_HOST = "127.0.0.1"
$env:KXM_AUTH_TOKEN = "replace-with-a-long-random-token"
$env:KXM_WORKSPACE_DIR = "D:\work\product\.kxm"
kxm hub start
```

These operator commands assume the packed release CLI installation from
[Getting started](getting-started.md#1-install). From a
source clone, use `npm run hub` instead.

When `KXM_AUTH_TOKEN` is not set, `kxm hub start` loads the persisted hub
credential file (schema `kxm.hub-env.v1`) under the user state root
(`~/.local/state/kxm/hub-env.json` on Linux, honoring `KXM_STATE_HOME` and
platform equivalents). If no persisted token exists, a long random
administrative token is generated, saved there with `0600` permissions, and
used. The hub therefore never silently starts with `auth=none` because a
token was forgotten; a missing token is created once and reused by every
later restart, worker, and dashboard on the same machine. Explicit
`KXM_AUTH_TOKEN` / `KXM_PROJECT_TOKENS` environment values always win and are
persisted so restarts keep them. The generated value is never printed in
full; kxm only reports which file it came from.

Stop with `Ctrl+C` or `SIGTERM`. The hub stops accepting connections, closes SSE streams, waits for active HTTP connections, and closes SQLite.

For unattended service, use a supervisor that sets a stable working directory, injects secrets, captures stdout, restarts after failure, and allows at least five seconds for graceful shutdown.

### PID claims and restart recovery

The hub wrapper records its own PID and the server child PID in
`.kxm/state/hub.pid`. A claim whose wrapper is dead is reclaimed automatically
on the next `kxm hub start`; when the dead wrapper left an orphaned server
child behind (for example after `SIGKILL` or a machine crash), the new
wrapper terminates that orphan before reclaiming. `kxm hub stop` also
recovers orphans directly: it signals a still-running recorded server child
of a dead wrapper, waits for exit, and removes the stale claim. Malformed or
foreign PID claims stay fail-closed; remove those only after verifying no
hub process is running.

Run each long-lived coordinator with `kxm agent worker --name <stable-name> --project <project> [--model <provider/model>] [--fallback-models <provider/model,...>] [--tools <name,...>]` under a separate service-manager unit. Use distinct worktrees for concurrent writers, explicit CPU and memory limits, and restart throttling outside the built-in bounded backoff. Enforce role ownership with the Pi tool allowlist: omit `bash`, `edit`, and `write` from read-only reviewers, even if their prompt also says not to edit. The worker launches Pi RPC mode and retains the most recent session unless configured otherwise. Use `--fresh-start` for a clean first session that may still resume after a later provider failure; reserve `--no-continue` for a worker that must never resume. For release verification, configure the [exact extension and skill sets](configuration.md#long-lived-worker-settings), including every required provider extension; configured categories disable discovery and fail closed on invalid paths. `kxm hub stop` writes a generation-matched control request; the worker asks Pi RPC to abort, waits for confirmation and state flush, and only force-stops the process tree after the bounded drain deadline. A final provider error leaves the inbound hub message delivered, gracefully restarts Pi, rotates to an unused fallback model, and preserves the session; Pi's own automatic retries always finish first. A tool that exceeds `KXM_WORKER_TOOL_TIMEOUT_MS` follows the same durable restart path without changing models. If `--continue` reports an invalid tool-result session, the worker retries once fresh, journals a redacted recovery envelope, and injects a bounded resume instruction for the durable run and stage. Do not copy `pi-agent-*.log` into journals or retrospectives.

### Workflow-specific Pi sessions

Workflow isolation is opt-in during the upgrade-compatible release because the new scoped default directory cannot safely infer which pre-upgrade shared Pi session belonged to a worker. Enable it explicitly for coordinators and peers that may receive durable workflow work:

```powershell
kxm agent worker --name coordinator --project product --session-isolation workflow
```

Ordinary peer and operator messages reuse the worker's stable `default` Pi history. Each canonical workflow run uses `.kxm/state/pi-sessions/<workerKey>/runs/<runId>/`; only one Pi RPC child exists at a time. A route-change lifecycle event (`worker_session_routed`) is expected and does not consume restart budget or apply crash backoff. `worker_session_evicted` records bounded LRU cleanup. `worker_session_state_recovered` means a malformed binding manifest was quarantined and routing restarted safely at `default`; inspect the protected `.corrupt-*` file and workflow journal before deleting it. `worker_session_request_rejected` indicates a stale, malformed, mismatched-generation, or mismatched-source request and should be investigated if it repeats.

Back up workflow model histories only if local Pi context is part of your recovery policy; authoritative workflow stages, evidence, and decisions remain in `kxm.db`, assets, and Git. Never use a Pi JSONL as the sole system of record. The first isolated launch starts fresh scoped storage; the previous shared Pi history remains available only in `off` mode and is not copied because a shared directory may contain several agents' sessions. To disable isolation temporarily, stop the exact worker cleanly and restart it with `--session-isolation off`; do not run isolated and shared supervisors concurrently under the same agent identity. Returning to `workflow` resumes the binding recorded in the manifest, subject to the configured retention bound.

For GitHub-backed waits, run `kxm gate github watch` as a separate command. The hub does not poll GitHub. Success, failure, cancellation, and timeout produce the exact signed signal for the waiting run/stage/key; timeout exits `4` after posting `failed`.

## Live observer dashboard

Run the read-only dashboard against the active workspace:

```powershell
kxm --workspace D:\work\product\.kxm dash
```

The dashboard uses Pi's `@earendil-works/pi-tui` renderer. With the administrative `KXM_AUTH_TOKEN`, it subscribes to `/v1/ops/events` and refreshes the project-scoped `/v1/ops/snapshot` on each SSE wakeup, keeping agent, open-message, and workflow metadata live without timer polling. Both endpoints omit request/reply bodies. Local process claims remain a local read-only snapshot. If the operations endpoints are unavailable or the supplied credential is project-scoped rather than administrative, the dashboard requests a hub-enforced presence-only agent SSE stream plus local SQLite metadata. It refuses an older/unmarked stream that cannot guarantee this metadata-only mode. Observer registrations are excluded from the dashboard's displayed agent table and counts; they remain ordinary authenticated hub identities while connected.

| Key | Action |
|---|---|
| `1`–`6` | Agents, Tasks, Workflows, Plans, Inbox, or Procs |
| `Tab` / `]` | Next tab |
| `[` | Previous tab |
| `←` / `→` | List pane / detail pane |
| `↑` / `↓` | Select |
| `PgUp` / `PgDn` | Scroll |
| `h` | Toggle help |
| `q` | Quit |

In a non-interactive shell, `kxm dash` prints one ANSI-free snapshot and exits.
Use `kxm hub view --json` instead when a machine-readable result is required.

## Real multi-Pi release smoke

The opt-in release smoke requires two distinct models that already pass `pi auth check`. It creates a temporary workspace, launches two real Pi RPC workers, and verifies discovery, request/reply, fanout, durable identity plus a post-restart exchange, journal persistence, checkpoint completion, and cleanup.

PowerShell:

```powershell
$env:KXM_SMOKE = "1"
$env:KXM_SMOKE_MODELS = "xai/grok-4.6,anthropic/claude-sonnet-4-5"
node scripts/smoke-multi-pi.mjs
```

POSIX shell:

```bash
KXM_SMOKE=1 KXM_SMOKE_MODELS='xai/grok-4.6,anthropic/claude-sonnet-4-5' node scripts/smoke-multi-pi.mjs
```

For GitHub Actions, smoke runs on the ARC scale set `kontextmind-doks`. Set
the GitHub repository variable `KXM_SMOKE_RUNNER` (a readiness latch, not a
process environment variable) exactly to `kontextmind-doks` and
`KXM_SMOKE_MODELS` to the two model IDs. Any other value skips the job. A
manual dispatch can override the model variable with its `models` input.
Readiness means Pi credentials are provisioned to ephemeral ARC pods and
pass `pi auth check`, not general CI readiness. Credentials are never
workflow inputs. The variable is currently unset, so the workflow is
intentionally disabled.

## Health, readiness, and metrics

| Endpoint | Authentication | Meaning |
|---|---|---|
| `GET /health` | None | Process is accepting HTTP and reports online agents |
| `GET /ready` | None | Storage responds and the hub is ready for traffic |
| `GET /metrics` | Administrative token outside loopback | Prometheus text metrics |
| `GET /v1/ops/snapshot?project=<name>` | Administrative token | Project-scoped agent, open-message, and workflow metadata; no bodies |
| `GET /v1/ops/events?project=<name>` | Administrative token | Metadata-only SSE wakeups for live dashboard refresh |

Use `/ready` for service traffic and `/health` for liveness. Metrics include online agents, retained messages, requests, errors, registrations, sends, replies, cancellations, expiries, purges, workflow waits, external signals, wait timeouts, and explicit workflow quorum degradations.

Structured JSON logs are written to `.kxm/logs/kxm-hub.jsonl` and mirrored to stdout. They include request IDs and event metadata but omit prompt and reply bodies. Worker lifecycle events use `.kxm/logs/kxm-worker-<project>-<agent>-<identity>.jsonl`; raw headless Pi stdout and stderr use `.kxm/logs/pi-agent-<project>-<agent>-<identity>.log` and may contain sensitive model or tool output. The collision-resistant suffix separates exact project/agent owners even when display names sanitize identically. Useful hub events include `agent_registered`, `agent_resumed`, `agent_stale`, `message_sent`, `message_replied`, `message_cancelled`, `message_expired`, `message_purged`, `webhook_workflow_started`, `workflow_checkpoint`, `workflow_degradation_approved`, `workflow_wait_started`, `workflow_signal_received`, `workflow_wait_timed_out`, `workflow_journal_recorded`, and `request_error`.

Runtime logs are ignored by Git. Ship them to an approved collector, restrict file access, and apply retention or rotation outside the process before unattended use. Never commit them as workflow evidence; reference a protected log location or sanitized asset instead.

Recommended alerts:

- readiness fails for more than one minute;
- errors or rate-limit responses rise unexpectedly;
- the process restarts repeatedly;
- retained-message count grows despite the retention policy;
- free disk space approaches the database's expected growth margin.
- webhook signature rejections, repeated provider retries, premature workflow settlement, or attempt exhaustion increase.
- waiting-run count or workflow wait timeouts rise beyond the expected external-system latency.
- quorum degradation approvals occur outside a declared incident or change window.

## Per-tenant hosted deployment

One tenant is one machine: one hub process, one Runtime supervisor, one SQLite state set.
Tenancy is the box, not a table — the hub has no tenant column and no user accounts, and
`kxm hub bind` still means *this machine's client attaches to that hub URL*. The portal
(kontextmind/kxmd-portal) is the multi-tenant, multi-user surface; browsers never talk to
the hub.

Topology on the tenant box:

```text
browser ──HTTPS──▶ reverse proxy + Authentik ──▶ portal (users, sessions, tenant directory)
                                                   │
                                                   │  server-side, loopback
                                                   ▼
                                    hub 127.0.0.1:7331  ·  Runtime supervisor (loopback)
```

1. **Service account, not root.** Run the hub and Runtime under a dedicated unprivileged
   account. Workflow session isolation is a routing and cross-run safety mechanism, not a
   sandbox against a hostile same-OS process (see
   [architecture.md](architecture.md)); a model with shell access can reach anything its
   own account can reach, so untrusted workers need separate accounts or containers.
2. **Stable paths, declared explicitly** rather than inherited from a home directory:
   `KXM_WORKSPACE_DIR`, `KXM_STATE_DIR`, `KXM_DATA_PATH`, `KXM_LOG_PATH`, and
   `KXM_STATE_HOME` for the machine-level hub credential and binding records. Pin
   `KXM_HOST=127.0.0.1`.
3. **Loopback listeners only.** The hub and the supervisor expose no public port; nothing
   is load-balanced across hubs. The hub keeps one writer per database.
4. **One project, the slim workflow.** `kxm init` the workspace, then start the hub with
   `kxm hub start` and confirm with `kxm hub view` — the status line reports the binding as
   `loopback` or `remote`, so an operator can see which side of the trust line they are on
   without reading files. `kxm hub bind` refuses a **remote** URL when the machine has no
   credential to authenticate with, because a stored-but-unusable URL later reads as a
   network fault and gets debugged as one.
5. **Restart recovery is the existing one:** the PID claim file, dead-claim reclaim and
   graceful `SIGTERM` shutdown described under *PID claims and restart recovery*. Do not
   add a second service manager for the hub; use the tenant's existing one.

### Reverse-proxy contract

The tenant's proxy owns TLS and the browser session. KXM ships no proxy configuration,
because a generated config reads as authoritative while one missing directive silently
re-opens header forgery. What must hold, whatever the stack:

- The hub and supervisor ports are **not** reachable from outside the box.
- The proxy **strips** client-supplied identity, tenant, agent, caller and `Authorization`
  headers before injecting its own validated values. The hub must never see a
  browser-forged `x-kxm-agent-id`, `x-kxm-caller-id` or bearer.
- The proxy **never injects the hub admin token on a user's behalf**. That flattens every
  authenticated user in the tenant to hub admin and destroys attribution.
- Machine credentials stay server-side in the portal process. A browser must not hold,
  echo, or be redirected with a hub bearer.
- `kxm hub bind` on a remote hub URL therefore requires an explicit credential, and a
  refusal names the fix instead of only the failure.

Example (illustrative shape — not generated config, not tested by this repository's CI):
Authentik's embedded proxy answers a forward-auth subrequest per request; the tenant proxy
`proxy_cache_bypass`/`auth_request`-style gate allows only the portal's routes and keeps
`/v1/*` and the supervisor off the public interface entirely.

## Backup and restore

> **This section covers the whole tenant state set, on purpose.** A recipe that copies only
> `.kxm/state/kxm.db` is a hub-only backup: it silently omits the Runtime registry,
> per-project event stores, prompt sidecars, bindings and configuration, so a restore that
> passes every hub check can still lose run history. Verify with a real restore before first
> hosted use, not after an incident.

SQLite runs in WAL mode, so a consistent copy requires a stopped service (or a SQLite-aware
online tool). Stop the hub and the Runtime supervisor first.

**What a tenant backup contains.** Six roots — one fixed to the checkout, one for the
workspace directories, and four more that can each sit anywhere — and confusing them is how
a backup goes missing while looking complete:

- **`$S`** — host-local machine state: `$KXM_STATE_HOME` **when set**, and it must be an
  absolute path — a relative value is **rejected** with `local_state_root_not_absolute`, not
  redirected. When unset, the default is `~/.local/state/kxm` on Linux (honouring
  `XDG_STATE_HOME`), `~/Library/Application Support/KXM` on macOS, or
  `%LOCALAPPDATA%\KXM` on Windows. The silent case to know about is a relative
  `XDG_STATE_HOME`/`LOCALAPPDATA` **base**: that falls back to the default without error,
  so a backup path derived from it can quietly point somewhere else.
- **`$R`** — the checkout root. Everything below it is **fixed to the repository and does
  not follow any workspace override**: `$R/.kxm/project.yaml`, `$R/.kxm/config.yaml`,
  `$R/.kxm/agents/`, `$R/.kxm/workflows/`, `$R/.kxm/gates.yaml`, `$R/.kxm/roles/`,
  `$R/.kxm/role-hosts.yaml` (or `.json`), `$R/.kxm/producers.yaml`, `$R/.kxm/roster.yaml`,
  `$R/.kxm/routes.yaml`, `$R/.kxm/prices.yaml`, `$R/.kxm/repo/`,
  `$R/.kxm/template-provenance.yaml`, plus the durable work and learning records
  `$R/.kxm/goals/`, `$R/.kxm/tasks/`, `$R/.kxm/memory/` (with `memory/candidates/`) and
  `$R/.kxm/skills/`. Conflating these with the next root is how a backup omits the project
  definition while believing it copied the project.
- **`$D`** — the **workspace directories**, resolved from `--workspace` or
  `KXM_WORKSPACE_DIR`, else `$R/.kxm`, relative to `KXM_WORKDIR`/cwd:
  `$D/config`, `$D/logs`, `$D/assets`, `$D/state`. `--workspace` **derives all four** and
  ignores the per-directory variables; otherwise `KXM_CONFIG_DIR`, `KXM_LOGS_DIR`,
  `KXM_ASSETS_DIR` and `KXM_STATE_DIR` override each one independently, and
  `KXM_DATA_PATH`/`KXM_LOG_PATH` move two files again inside that. `$D` therefore **defaults to `$R/.kxm`**, and the two
  move together only when the *workspace* is relocated: `KXM_WORKSPACE_DIR` (or
  `--workspace`) moves `$D` and every default beneath it, while `KXM_CONFIG_DIR`,
  `KXM_LOGS_DIR`, `KXM_ASSETS_DIR`, `KXM_STATE_DIR`, `KXM_DATA_PATH` and `KXM_LOG_PATH`
  move **their own target and nothing else** — `KXM_STATE_DIR=/srv/state` alone leaves `$D`
  at `$R/.kxm` and shifts only `$W`. A backup that assumes one shared location starts
  omitting the other in exactly that case, which is why every row below is labelled as a
  default.
- **`$W`** — the workspace *state* directory: `KXM_STATE_DIR` when set, else `$D/state`
  (and `--workspace` derives it, ignoring that variable). It holds the
  hub database, worker routing/recovery manifests and Pi sessions.
- **`$C`** — user configuration: `KXM_USER_CONFIG_DIR`, else `~/.config/kxm`.
- **`$T`** — federated telemetry output: an explicit global directory joined with
  **`telemetry/`**, else `$XDG_CONFIG_HOME/kxm/telemetry`, else `~/.config/kxm/telemetry`.
  It is built from `XDG_CONFIG_HOME`/`HOME`, **not** from `KXM_USER_CONFIG_DIR`, so `$T` can
  land outside `$C`; and it is a *different file* from local accounting in `$D/logs`.

| Path | Contents | Loss means |
|---|---|---|
| `$W/kxm.db` (+ `-wal`, `-shm`, or `KXM_DATA_PATH`) | hub store: agents, messages, workflow runs, checkpoints, gate evidence | hub history and delivery state |
| `$S/runtime/registry.db` | Runtime registry, including the **supervisor identity and claim row** | which projects this Runtime knows; the claim is a registry row — there is no `supervisor.json` |
| `$S/runtime/projects/<projectKey>/run-events.db` (+ `-wal`/`-shm`) | event-sourced run state, commands, drives, receipts, gate evidence, intake, coordinators, pause control | run history and every receipt that proves it |
| `$S/runtime/projects/<projectKey>/run-events.db.run-prompts.json` | prompt text; the sidecar name appends to the **full** database filename | the prompts that explain the runs — restoring databases without sidecars is a partial restore |
| `$S/runtime/logs/kxm-runtime.jsonl` (+ rotated `.1`…) | the Runtime supervisor's own structured log, including every outbound-sync state change | the supervisor runs detached with no stdio: this file and `GET /v1/sync/status` are its only voice |
| `$S/projects/<control-root-hash>/repository-bindings.json` | host-local member repository paths | member bindings are host state, outside the project tree |
| `$S/update.yaml` | release/update configuration consumed by the updater | the box reverts to defaults on the next update path |
| `$W/pi-sessions/<workerKey>/{default,runs/<runId>}/` | Pi model histories | **optional by existing policy** (see *Workflow-specific Pi sessions*): never a system of record — decide and record, do not silently widen scope |
| `$W/worker-session-binding-<workerKey>.json` (+ `.corrupt-*`), `worker-context-*.json`, `worker-recovery-*.json` | routing and recovery manifests | not optional: these are what make worker routing resumable after a restart |
| `$R/.kxm/…` project definition: `project.yaml`, `config.yaml`, `agents/`, `models/`, `workflows/`, `gates.yaml`, `roles/`, `role-hosts.yaml` (or `.json`), `producers.yaml`, `roster.yaml`, `routes.yaml`, `prices.yaml`, `repo/`, `project/env.yaml`, `template-provenance.yaml` | project, role, route, price and provenance definition | the tenant stops being reproducible — and a restore without `roster.yaml`/`routes.yaml`/`prices.yaml` comes back with **different admission and cost behaviour** while reporting itself healthy |
| `$R/.kxm/goals/`, `tasks/`, `memory/` (with `memory/candidates/`), `skills/` (candidate/promoted/rejected, history, patches) | durable work and learning records | open goals/tasks and approved memory disappear |
| `$R/.kxm/candidates/` — improvement candidate JSON and their diffs, **default only**: `kxm improve report --out-dir` relocates this directory outside every root listed here | the improvement queue itself | proposed fixes nobody was told about |
| each bound member repository's own `$memberRepo/.kxm/repo/repo.yaml` and `.kxm/repo/env.yaml` | member repository definition and environment | for **externally bound** members, the binding JSON alone is not enough — these files live on the member's own filesystem and need their own backup or an explicit, checked reconstruction prerequisite |
| `$D/assets/` (default; `KXM_ASSETS_DIR` relocates it) — retrospectives, improvements, artifacts, evidence | exported evidence | provenance and the ability to audit a past decision |
| `$D/logs/` (default; `KXM_LOGS_DIR` relocates the directory and `KXM_LOG_PATH` the hub log) and `$D/logs/telemetry.jsonl` | operator logs and **local** usage accounting — the spend numbers routing reports read | no local accounting to reconcile against |
| `KXM_WORKER_LOG_PATH` / `KXM_AGENT_LOG_PATH` targets (defaulting under `$D/logs`) | per-worker lifecycle and raw Pi output | worker diagnostics; **separate overrides, not local accounting** |
| `$T/model-metrics.jsonl` | **federated** metrics only. Absent almost everywhere: the exporter exists and `telemetry.federated` defaults to `true` in the shipped config, but **no hub or CLI path calls it today**, so absence is the normal state rather than evidence someone opted out. A different file from local accounting, which is `$D/logs/telemetry.jsonl` | cross-machine reporting continuity, and a privacy boundary worth naming: federated records are separate, with `anonymize` defaulting to `true` |
| `$S/hub-binding.json`, `$S/hub-env.json`, `$C/session.token` | host hub URL, credentials, local session token | a re-bind and a token rotation. **Secrets:** prefer regeneration to shipping them off-box, and never commit them |
| `$C` global roles/workflows/host configuration | user-level defaults | operator conventions |

**Overrides are part of the backup record.** `KXM_WORKSPACE_DIR` (and the `--workspace`
flag, which additionally **ignores** the per-directory variables) moves every `$D`
**default** at once; a directory with its own override stays where that variable points.
Neither moves `$R`, so the fixed project tree must still be backed up from the checkout even
when the workspace was relocated elsewhere — and copying the whole checkout is what protects
`$R`'s default locations, which is why an enumerated-paths backup should be re-checked
against this table whenever a loader grows a file. `KXM_STATE_HOME` moves `$S`
only if absolute. An explicit telemetry directory is likewise joined with `telemetry/`,
not used verbatim.
`KXM_DATA_PATH`, `KXM_STATE_DIR`, `KXM_CONFIG_DIR`, `KXM_ASSETS_DIR`, `KXM_LOGS_DIR`,
`KXM_LOG_PATH`, `KXM_WORKER_LOG_PATH`, `KXM_AGENT_LOG_PATH` or an explicit telemetry
directory each relocate one more thing. Record every override **with** the backup, or a
restore lands somewhere the running service will not look.

**Disposable, not backup material:** `session-brief.json`, `update-check.json`,
`*.error`, PID/claim files such as `hub.pid` and `worker-<key>.pid`, and
`supervisor.token` (host-local secret, re-generated on start). WAL-consistent copying or
`VACUUM INTO` applies to **every** SQLite file above, not only the hub database.

**Back up (stopped-state recipe):**

1. Stop **both** services, confirm they are down, and **keep them down until the copy
   finishes**. `kxm hub stop` covers the hub and its worker PID claims; the Runtime
   supervisor is a **separate** process owning `registry.db` and the project event stores,
   stopped by `kxm runtime stop` — and that call acknowledges shutdown *initiated*, not
   databases closed. So: verify neither reports live, then suspend whatever would start them
   again — the service manager's auto-restart, hub autostart on login, and any client that
   would reconnect and begin new work (a bound CLI, MCP server or Pi worker restarting a
   supervisor on demand). A manager that respawns the hub halfway through a copy produces a
   backup that is internally inconsistent across files, which is precisely the failure mode
   this recipe is otherwise careful about. Only then copy.
2. Copy the whole set above as one tree — **every root**, `$R`, `$D`, `$W`, `$S`, `$C` and
   `$T` — or take `VACUUM INTO` snapshots per database. **Snapshots replace the database
   copies, not the file copy**: configuration, repository bindings, prompt sidecars,
   routing manifests and update configuration are not databases, so a snapshot-only backup
   reproduces exactly the failure this section exists to remove. The hub's own backup path already writes a hashed manifest and records
   a schema version ceiling; keep that manifest with the files. That ceiling is
   **hub store v5 and event store v6** as of the sync-outbox release: a backup taken by
   an earlier build records hub v4 or event store v5 and is refused by this one, because
   there is no migration lane.
   Restore such a backup with the release that produced it, or start fresh.
3. Record the package version, configuration revision and schema versions beside the copy.
   A restore that cannot state which release produced it is not a restore path.
4. Keep at least one rotation, and bound retention explicitly — run events and prompt
   sidecars grow, and unbounded retention is how a tenant box fills up.

**Restore:**

1. Stop the services. Move the current state aside rather than overwriting it.
2. Place each file back at its recorded path under the right root — `KXM_DATA_PATH`, the
   Runtime registry and each project event store **with its sidecar**, repository bindings
   under `$S/projects/…`, config, and `$S/runtime/registry.db` so the supervisor claim
   returns with it.
3. Start the hub and confirm `/ready`, then `kxm hub view` — including that the reported
   binding scope is what the environment actually is.
4. Read back a run and its drive receipt, and confirm prompt text is present. Restoring
   databases without their sidecars leaves runs whose prompts are gone; that is a partial
   restore, not a success.

The runtime refuses a database whose schema version is newer than it supports, so
restore order is: matching-or-newer release, then data. Online backups need a
SQLite-aware tool or a consistent snapshot of each database with its `-wal` and `-shm`;
a plain copy of a live `kxm.db` can omit committed WAL data.

Test restoration periodically. Routine unattended recovery (automated discovery of every
Runtime store plus sidecars) is deliberately **not** claimed here: it is a tracked
post-MVP item, and today this procedure is executed stopped and by hand.

## Upgrade and rollback

1. Back up the database and record the current package version.
2. Run `npm ci` for the target checkout.
3. Stop the old hub gracefully.
4. Start the new version against the database and verify `/ready`, `/metrics`, and a test round trip.
5. Restart agents only if their clients do not reconnect automatically.

For rollback, stop the new version and restore both the earlier application and its pre-upgrade database backup. Do not open a newer-schema database with an older runtime.

Peer provenance fields do not bump the current SQLite schema version 2; they are
additive fields in existing JSON records. That avoids a destructive migration,
but it does not replace the backup and rollback steps above. Verified
metadata-only snapshots remain in workflow runs after their source messages are
purged by terminal retention, so include workflow data in retention and privacy
reviews.

## Network and secret security

Loopback is the safest default. Before binding elsewhere, configure an administrative token, assign project tokens, terminate TLS at a trusted proxy, restrict inbound networks, disable proxy buffering for `/v1/events`, and protect the SQLite directory.

The database is not encrypted by the application. Use encrypted storage when messages require encryption at rest. Rotate a disclosed token and reconnect affected agents. Never expose the hub directly to the public internet.

## Capacity and failure behavior

The service uses one Node.js process, long-lived SSE connections, and one SQLite writer. Measure concurrent agents, request rate, event-loop delay, database size, disk latency, and reconnect frequency for your workload. The in-memory rate-limit ledger resets after process restart.

| Failure | Behavior | Recovery |
|---|---|---|
| Agent exits | Marked offline after the stale threshold | Restart with the same name to resume its ID |
| SSE drops | Client reconnects while heartbeats continue | Check network and proxy buffering if repeated |
| Hub or worker exits | SQLite keeps agents and messages; session binding manifests keep the active Pi scope | Restart; agents reconnect and queued or delivered work replays by the same message ID in the bound Pi session |
| Token rotates | Requests fail authentication | Restart agents with the new project token |
| Disk unavailable | Readiness or writes fail | Restore storage, then verify database integrity and readiness |
| Duplicate live name | Registration returns HTTP 409 | Stop the old session or choose another name |
| External callback is lost | Run stays `waiting` until its deadline | Retry with the same delivery ID or investigate the provider before timeout |
| External wait expires | Run and active stage fail; journal records the timeout and the coordinator receives a terminal notification | Fix delivery/routing, review side effects, then start a new safe workflow delivery |
| Pi executable cannot spawn | Worker records the process error and applies its normal restart/backoff limit | Repair `PATH` or `KXM_PI_COMMAND`; confirm the worker exits nonzero when retries are exhausted |
| Session binding manifest is corrupt | Worker quarantines it and starts the stable default binding without trusting a guessed run | Inspect `worker_session_state_recovered`, the `.corrupt-*` manifest, `kxm.db`, and workflow journal; re-drive unfinished work from durable message IDs |
| Session route request is rejected | Candidate remains queued; wrong-scope acknowledgement never occurs | Check worker generation, active scope, canonical run ID, state-directory permissions, and repeated `worker_session_request_rejected` logs |

Durable transport does not make peer execution exactly once. Use idempotent tasks and stable message idempotency keys, and store important artifacts in Git or another system of record.

## Remaining scale boundaries

Broader deployments need shared state and coordination, external identity and fine-grained authorization, distributed traffic controls, defined service-level objectives, load and chaos testing, and a formal long-term schema migration strategy.

## v0.5 context/state storage

The hub database (schema version 5) carries `context_items`, `leases`,
`sync_events` and `runtime_presence` alongside agents, messages, workflow runs,
and the journal. Temporal state,
knowledge records, and their audit trails live in the same SQLite file and
upgrade in place from v0.4 databases.

- **Backup and restore**: include the hub database file and, if used, the
  `.kxm/skills/` and `.kxm/knowledge/` trees. The wiki is a compiled view and
  can be regenerated (`kxm context wiki-compile`); skills history and state
  records are authoritative and must be backed up.
- **Recovery after restart**: runs, journal entries, transitions, captured
  oracles, and plan hashes reload from SQLite; temporal `asOf` queries are
  deterministic against the restored validity windows.
- **Project isolation**: context/state/skill operations are project-scoped.
  Agents authenticate to their own project; administrative operations require
  the hub token. Cross-project context requests fail closed
  (`context_isolation_violation`).
- **Rollback**: schema downgrades are not supported (a newer database refuses
  to open on an older runtime). Restore a database backup taken before the
  upgrade instead.

### Fenced leases over shared resources

`leases` holds one row per project-scoped resource: the holder, a monotonic
fencing token, and a deadline. `POST /v1/leases/:resource/acquire|renew|release`
are agent-authenticated and scoped to the caller's project, which the hub
prefixes onto the resource name — two projects naming the same branch never
contend. TTLs are bounded to 5 s–10 min and every decision is made on the **hub
clock** inside one store transaction, so a skewed client cannot extend its own
grip.

The token is the safety property. It starts at 1, stays put across renewals, and
increments only when a new holder takes over an expired lease. A holder that
comes back after its deadline is therefore told its token was superseded rather
than allowed to write behind whoever replaced it. Shared external effects
(`git-push` to a ref the run does not own, `pr-create`, `tracker-issue`,
`webhook`) take a lease before executing and re-present the token at commit; a
superseded token leaves the effect `in-flight` and the attempt
`blocked_uncertain` for an operator to resolve, and nothing retries it. An
unreachable hub refuses the effect (`effect_lease_unavailable`) rather than
running it unfenced.

Expired rows are **not** reaped immediately — their token is what the next
takeover has to increment past. The retention sweep drops rows whose deadline is
older than the run-retention window (7 days by default), far beyond any live
holder. `kxm_leases_granted_total`, `kxm_leases_refused_total` and
`kxm_leases_released_total` in `/metrics` report contention;
`lease_acquired`, `lease_renewed`, `lease_released`, `lease_denied` and
`lease_purged` are the structured log events.

### Runtime → hub run-fact sync

Every event the Runtime commits also writes one row to the event store's
`outbox` (event store v7), in the same transaction. The row holds only a derived
`kxm.sync-event.v1` object — allowlisted fields, registered secret values and
credential shapes replaced, absolute paths removed, text bounded, the default
sync policy revision recorded — never the local event. A field the allowlist
does not name is listed by name in `redaction.fieldsOmitted` and its value is
dropped.

The supervisor pushes outbound only: every `KXM_RUNTIME_SYNC_INTERVAL_MS` (10 s
by default) it posts `POST /v1/runtime/presence` for each open project, then
`POST /v1/sync/events` in outbox order, to `KXM_SERVER_URL` or the `kxm hub bind`
URL with that project's token. No bound hub means nothing is sent and rows stay
pending; local execution never waits on sync. The hub accepts each event once by
`{projectId, runId, sequence}`: the same bytes again are an idempotent
`duplicate`; different bytes under a used sequence, a run claimed by another
project, or a push for another Runtime's events are refused and logged as
`security_alert`. Out-of-order events are held, and the per-run cursor is the
gapless prefix, so a gap stays pending until it is filled.

The project on the wire is the project the sync events carry — the `prj_*` id in
`.kxm/project.yaml`, not the package name. The hub pins a project id to the first
hub project that claims it, so a Runtime that ever pushed under a second label
leaves its own later pushes refused; the supervisor's sync status names that
refusal instead of hiding it.

Two kinds of hub answer come back, and they are not the same thing. A
**transient** failure (unreachable hub, refused credential) leaves every row
pending, records the reason and backs the next attempt off exponentially. A
**durable** refusal (`sync_sequence_reused`, `sync_project_mismatch`,
`sync_home_runtime_mismatch`, `sync_event_invalid`, a row too large to carry)
takes *that row* out of the pending queue with the hub's code, so one row the hub
will never accept can neither block the rows behind it nor re-alert the hub every
ten seconds. Refused rows are not deleted: `kxm runtime sync-retry` re-queues them
once the hub-side state is corrected, and only an operator decides that a refusal
has become retryable.

`kxm runtime status` prints what the tick last saw per project — `ok`, `no_hub`,
`blocked` or `refusing`, with pending/acked/refused counts, the refusal codes, the
last failure and the next attempt — read from the supervisor's
`GET /v1/sync/status`. The same transitions are logged to
`$S/runtime/logs/kxm-runtime.jsonl` (`runtime_sync_state`,
`runtime_sync_stalled`), one line per change: the supervisor runs detached with no
stdio, so that file and that endpoint are its only voice.

`GET /v1/ops/snapshot` adds `homeRuntimes`: synchronized runs grouped by home
Runtime, each with its bounded title/status, `lastSequence`, `pendingGap`, and
`orphaned` once the Runtime's presence lease (`heartbeatAt + staleAfterMs`, hub
clock) has lapsed. Orphaned is view state; nothing is migrated.
`kxm_sync_events_accepted_total`, `kxm_sync_events_duplicate_total`,
`kxm_sync_events_refused_total`, `kxm_sync_conflicts_total` and
`kxm_runtime_heartbeats_total` are in `/metrics`.

## Hub Q&A / knowledge base

- [What is all stored on the hub?](kb/qa-what-the-hub-stores.md)
- [Storage engine — SQLite vs DuckDB](kb/qa-sqlite-vs-duckdb.md)
- [Hub on a public host — multiple users and projects?](kb/qa-hub-on-a-public-host.md)
- [Authentik at the edge: why the hub owns no browser identity](kb/qa-authentik-authentication.md)
- [Extension install → kxm CLI bootstrap + hub auto-connect](kb/qa-extension-install-and-hub-bootstrap.md)
