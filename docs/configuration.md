# Configuration reference

Pi Mesh Comms uses environment variables for the hub and Pi extension. The Claude Code plugin maps its settings to the same client values.

## Hub settings

| Variable | Default | Description |
|---|---:|---|
| `PI_MESH_HOST` | `127.0.0.1` | Listening interface |
| `PI_MESH_PORT` | `7331` | TCP port; `0` selects an available port |
| `PI_MESH_AUTH_TOKEN` | None | Administrative bearer token and fallback project token |
| `PI_MESH_PROJECT_TOKENS` | None | JSON object mapping project names to bearer tokens |
| `PI_MESH_WORKSPACE_DIR` | `.kxm` | Root for repository-local configuration, logs, assets, and state |
| `PI_MESH_CONFIG_DIR` | `.kxm/config` | Reviewable workspace configuration directory |
| `PI_MESH_LOGS_DIR` | `.kxm/logs` | Runtime log directory |
| `PI_MESH_ASSETS_DIR` | `.kxm/assets` | Durable workspace workflow assets |
| `PI_MESH_STATE_DIR` | `.kxm/state` | Restart-recovery state directory |
| `PI_MESH_DATA_PATH` | `.kxm/state/mesh.db` | SQLite database path; use `:memory:` only for disposable runs |
| `PI_MESH_LOG_PATH` | `.kxm/logs/pi-mesh-hub.jsonl` | Structured hub JSON Lines log |
| `PI_MESH_MESSAGE_TTL_MS` | `86400000` | Default message lifetime, from 1 second through 7 days |
| `PI_MESH_MESSAGE_RETENTION_MS` | `604800000` | Time to keep terminal messages; minimum 1 second |
| `PI_MESH_RATE_LIMIT_MAX` | `600` | Requests accepted per client bucket and window |
| `PI_MESH_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window; minimum 100 milliseconds |
| `PI_MESH_WEBHOOK_WORKFLOWS` | None | Inline JSON array of signed webhook workflow definitions |
| `PI_MESH_WEBHOOK_WORKFLOWS_FILE` | None | Path to the workflow-definition JSON file |

The hub refuses a non-loopback bind without `PI_MESH_AUTH_TOKEN`. Use a long random administrative token even when project tokens are configured, because administrative endpoints such as `/metrics` require it outside loopback.

Project tokens are an authorization boundary. A project-specific token can register only in its mapped project and see only that project's agents and messages. The administrative token remains a fallback for projects without an explicit entry. For provenance-gated workflows, configure an explicit project token and give workers only that token; reserve a distinct administrative token for operations such as quorum degradation approval.

PowerShell example:

```powershell
$env:PI_MESH_AUTH_TOKEN = "replace-with-an-admin-token"
$env:PI_MESH_PROJECT_TOKENS = '{"web":"web-token","api":"api-token"}'
$env:PI_MESH_WORKSPACE_DIR = "D:\work\product\.kxm"
kxm mesh hub
```

The four derived directories stay together when only `PI_MESH_WORKSPACE_DIR` is set. Specific directory and file overrides exist for operator-managed volumes, but a normal repository should keep its configuration, logs, assets, and state under `.kxm`. Runtime logs and state are ignored by Git; configuration and intentional reusable assets may be reviewed and committed. Secrets remain in environment variables or a secret manager.

## Agent settings

| Variable | Default | Description |
|---|---|---|
| `PI_MESH_SERVER_URL` | `http://127.0.0.1:7331` | Hub base URL |
| `PI_MESH_AUTH_TOKEN` | None | Project token, or the shared administrative token |
| `PI_MESH_PROJECT` | Current directory name | Discovery and message namespace |
| `PI_MESH_AGENT_NAME` | Harness-derived name | Unique live identity within a project |
| `PI_MESH_AGENT_PURPOSE` | Harness default | Capability description shown to peers |

Names are case-insensitively unique among online agents in one project. A clean shutdown marks an identity offline. Reconnecting with the same project and name resumes its durable ID and rotates its agent key.

## Claude Code plugin settings

| Plugin field | Environment value |
|---|---|
| Mesh server URL | `PI_MESH_SERVER_URL` |
| Authentication token | `PI_MESH_AUTH_TOKEN` |
| Agent name | `PI_MESH_AGENT_NAME` |
| Agent purpose | `PI_MESH_AGENT_PURPOSE` |
| Mesh project | `PI_MESH_PROJECT` |

`PI_MESH_PROJECT_DIR` is supplied internally to derive a default project. Users normally should not set it.

## Protocol limits

| Behavior | Value |
|---|---:|
| Maximum message content | 32,000 characters |
| Maximum HTTP request body | 256 KiB |
| Default hop limit | 5 |
| Maximum accepted hop limit | 20 |
| Agent heartbeat interval | 10 seconds |
| Agent stale threshold | 30 seconds |
| Client request timeout | 15 seconds |
| Default message TTL | 24 hours |
| Default `mesh_await` timeout | 30 minutes |
| Default workflow signal wait | 24 hours |
| Workflow signal wait range | 1 second to 30 days |

The `ttlMs` field controls how long a request remains valid from the moment it is sent, including time queued behind other work. It is independent of `mesh_fanout.timeoutMs`, which only bounds how long the caller waits locally. Normally omit `ttlMs` for model work and keep the 24-hour default. A local wait timeout returns `status: pending`, the durable `messageId`, current message status, expiry, and `waitStatus`; it does not cancel or fail the request.

Automated senders should set a stable `idempotencyKey` so an exact retry returns the original message instead of creating a duplicate. Reusing the key with different content returns a conflict. Do not create a new key while the original request is pending: use `mesh_get`, or repeat the exact fanout with the same correlation ID and idempotency prefix.

`mesh_fanout` derives a bounded idempotency key from `idempotencyKeyPrefix`, the correlation ID when supplied, and the normalized target name. Reuse the same prefix and correlation ID for an exact retry of one workflow run. A later workflow may safely reuse the human-readable prefix with a different correlation ID without colliding with retained peer messages. Pending panel members have not supplied evidence and cannot satisfy a multi-agent workflow checkpoint.

For a peer-policy requirement, transport correlation and idempotency do not
establish provenance. Supply `workflowContext` with the exact run, stage,
requirement, and active 1-based attempt. The hub authorizes and stores that
context, and a checkpoint or wait cites the replied message IDs through
`evidenceRefs`. Each reference set accepts 1–16 message IDs; quorum counts unique
eligible stable producer IDs.

When a Pi peer produces more than 32,000 characters, the extension returns a bounded truncated reply instead of leaving the request pending. The full output may remain in the replying agent's local Pi session or `.kxm/logs/pi-agent-<project>-<agent>-<identity>.log` when the long-lived worker is used.

## Long-lived worker settings

| Variable | Default | Description |
|---|---|---|
| `PI_MESH_WORKDIR` | Current directory | Repository used by the headless Pi worker |
| `PI_MESH_WORKER_LOG_PATH` | `.kxm/logs/pi-mesh-worker-<project>-<agent>-<identity>.jsonl` | Structured worker lifecycle log |
| `PI_MESH_AGENT_LOG_PATH` | `.kxm/logs/pi-agent-<project>-<agent>-<identity>.log` | Captured headless Pi stdout and stderr |
| `PI_MESH_PI_COMMAND` | `pi` or `pi.cmd` | Explicit Pi executable path when it is not on `PATH` |
| `PI_MESH_WORKER_CONTINUE` | `true` | Resume the active binding's most recent Pi session after a restart |
| `PI_MESH_WORKER_INITIAL_CONTINUE` | same as `PI_MESH_WORKER_CONTINUE` | Set `false` to start this supervisor generation fresh but still resume later recoveries |
| `PI_MESH_WORKER_SESSION_ISOLATION` | `off` for upgrade compatibility | `workflow` keeps ordinary work in one stable default Pi session and gives each durable workflow run a separate Pi session directory; `off` preserves the pre-isolation shared session |
| `PI_MESH_WORKER_MAX_RUN_SESSIONS` | `128` | Maximum retained workflow-specific Pi sessions per exact project/agent worker; integer `1`–`1024`, with least-recently-used inactive runs evicted |
| `PI_MESH_WORKER_DRAIN_MS` | `15000` | Graceful SIGTERM wait before SIGKILL |
| `PI_MESH_WORKER_MODEL` | Pi default | Optional model selector passed to Pi |
| `PI_MESH_WORKER_FALLBACK_MODELS` | unset | Up to eight comma-separated model selectors, tried in order after a final provider failure; requires a primary model |
| `PI_MESH_WORKER_PROVIDER_RETRY_MS` | `60000` | Retry delay (`1000`–`3600000`) after a final provider failure when no unused fallback remains |
| `PI_MESH_WORKER_TOOL_TIMEOUT_MS` | `1860000` | Maximum runtime for one Pi tool call (`1000`–`86400000`); the default leaves a one-minute supervisor grace above the longest 30-minute mesh wait, and `0` disables the watchdog |
| `PI_MESH_WORKER_ACTIVATION_TIMEOUT_MS` | `60000` | Supervised-worker deadline (`1000`–`600000`) for a delivered custom message to start its model turn; expiry requests a restart while preserving the hub claim |
| `PI_MESH_WORKER_TOOLS` | Pi defaults | Optional comma-separated allowlist passed to Pi; use it to enforce read-only or single-writer roles |
| `PI_MESH_WORKER_EXTENSION_PATHS` | unset | Optional extension files separated by the platform path delimiter (`;` on Windows, `:` elsewhere); relative paths resolve inside `PI_MESH_WORKDIR` |
| `PI_MESH_WORKER_SKILL_PATHS` | unset | Optional skill files or directories using the same delimiter and relative-path base |
| `PI_MESH_WORKER_MAX_RESTARTS` | Unlimited | Non-negative process restart limit; service managers may set their own policy |
| `PI_MESH_SMOKE` | unset | Set to `1` to enable the opt-in real multi-Pi smoke command |
| `PI_MESH_SMOKE_MODELS` | unset | Two distinct comma-separated model IDs for the real-Pi release smoke |
| `PI_MESH_SMOKE_TIMEOUT_MS` | `120000` | Per-phase real-Pi smoke timeout (`30000`–`600000`) |
| `PI_MESH_SMOKE_PI_COMMAND` | discovered `pi` | Optional explicit Pi executable for a self-hosted runner |

`PI_MESH_AGENT_NAME` and `PI_MESH_PROJECT` are required by `kxm agent worker`. Session isolation is opt-in for upgrade compatibility: pass `--session-isolation workflow` or set the environment variable to `workflow` after reviewing the fresh scoped-session behavior. Both the CLI and direct `scripts/pi-mesh-worker.mjs` default to `off`, so existing shared `--continue` histories are not silently abandoned. The remaining agent settings are inherited by the spawned Pi RPC process. The worker resolves `.kxm` and explicit package paths inside `PI_MESH_WORKDIR`, creates the standard directories, and passes absolute paths to Pi. When either resource-path variable is set, the worker disables discovery for that resource category and loads only the listed files or directories; setting just one category leaves discovery unchanged for the other. Missing paths and extension directories fail before the restart loop. A skill may be a `SKILL.md` file or a directory Pi scans for skills. Restart the worker after changing any resource or path.

Use exact paths for release verification or an uninstalled worktree. Include every provider extension the selected models require because extension discovery is isolated:

```powershell
$separator = [IO.Path]::PathSeparator
$env:PI_MESH_WORKER_EXTENSION_PATHS = @(
  "plugins/kxm-mesh/src/extension.ts"
  "$env:USERPROFILE/.pi/agent/npm/node_modules/pi-antigravity/src/index.ts"
) -join $separator
$env:PI_MESH_WORKER_SKILL_PATHS = "plugins/kxm-mesh/skills/kxm-mesh"
$coordinatorTools = @(
  "read", "powershell", "edit", "write", "grep", "find", "ls",
  "mesh_list", "mesh_send", "mesh_fanout", "mesh_get", "mesh_await",
  "mesh_workflow_get", "mesh_workflow_checkpoint", "mesh_workflow_wait",
  "mesh_workflow_record", "mesh_improvement_report"
) -join ","
kxm agent worker --name coordinator --project product `
  --model antigravity/claude-sonnet-4-6 `
  --fallback-models xai/grok-4.6 --tools $coordinatorTools `
  --session-isolation workflow --fresh-start
```

With workflow isolation enabled, the hub stamps every internal workflow prompt, callback resume, timeout notification, and authorized peer-evidence request with a canonical `workflowRunId`. Before acknowledging a queued message, the Pi extension compares that hub-owned binding with the active worker scope. A mismatch is left `queued`; the extension atomically requests a route change and shuts down cleanly. Only after the child closes does the supervisor start one replacement Pi RPC child with `--session-dir .kxm/state/pi-sessions/<workerKey>/default` or `.../runs/<runId>`. This gives the stable default work and each `{agent, workflowRunId}` an independent Pi JSONL history without concurrent writers. Correlation IDs alone never select a workflow session. Binding manifests and requests are identity-, supervisor-generation-, child-incarnation-, timestamp-, and schema-checked, and malformed manifests are quarantined before a safe default binding is created.

Explicit extension code runs with the worker's repository, network, and model credentials, and skills supply privileged instructions. These are trusted service-administrator settings: never derive them from a webhook or workflow payload. Absolute and parent-relative paths outside `PI_MESH_WORKDIR` are intentionally supported for reviewed provider extensions. Review and protect every configured resource like an executable dependency. A fast `--continue` failure writes a collision-safe `.kxm/state/worker-recovery-<project>-<agent>-<identity>.json` envelope and retries once without `--continue`; the reader can consume an exact-name legacy envelope during migration.

Pi performs its own transient retries before emitting the final settled event. If the final assistant outcome is still a provider error, the extension leaves the durable inbound message delivered instead of replying with an error. The supervisor closes the RPC session gracefully, records only an allowlisted diagnostic class in its structured log, selects the next configured fallback, and resumes the current Pi session so completed tool and peer results remain available. If continuation is structurally invalid, the existing fresh-session recovery path takes over. Raw provider output remains only in the protected `pi-agent-*.log` stream; even oversized or malformed RPC frames are reduced to bounded metadata in supervisor memory and lifecycle logs.

The tool allowlist is a capability boundary inside Pi, not a prompt suggestion — but it bounds **tool names, not filesystem paths**. A worker that keeps `write`, `edit`, or a shell tool can modify any file its OS user can reach; there is no path jail, and workspace roster fields such as `ownership` or `roles` are not read by the launcher. A review-only worker can use `read,grep,find,ls`; a coordinator should add only the mesh and mutation tools required by its workflow. The example above is a full-lifecycle, single-writer PowerShell coordinator; replace `powershell` with `bash` on macOS or Linux. Omit both platform shell tools, `edit`, and `write` from peers that must not mutate a shared checkout. Durable coordinators need `mesh_workflow_checkpoint`, and workflows that pause for external gates or capture learning also need `mesh_workflow_wait`, `mesh_workflow_record`, and `mesh_improvement_report`. If an enabled tool exceeds the watchdog duration, the worker preserves recovery metadata, closes or force-stops the RPC process tree within the drain deadline, and resumes the delivered request. Choose a timeout above the longest expected build or browser test and keep an external service-manager limit as a second boundary.

## Operator CLI

`kxm` is additive and does not replace `pi-mesh-hub` or `pi-mesh-worker`. The current hub command groups are `agent`, `session`, `workflow`, `gate`, `mesh`, and `improve`; the root `init` command is the first configuration-only vNext slice. If the installed `kxm --help` prints the former flat command list (`validate | status | hub | worker | stop | …`), the committed `plugins/kxm-mesh/dist/cli.js` predates these groups and needs `npm run build` and a commit. The CLI is an operator **client**: the hub's durable state, the protocol and schema types, and reviewed Git configuration define behaviour; where the CLI diverges from them, the CLI is the defect.

| Command | Purpose |
|---|---|
| `kxm init` | In an uninitialized Git worktree, atomically create the minimal vNext `project`, `repository`, `agent`, and `default` workflow YAML resources after full validation. Repeated use validates without rewriting. `--dry-run` classifies state and validates new-project inputs without writing. Legacy, mixed legacy/vNext, or invalid partial state is reported without conversion or overwrite. This configuration slice does **not** activate a vNext Runtime |
| `kxm agent worker` | Start a long-lived Pi worker. Use `--session-isolation workflow` to enable per-workflow Pi contexts; the upgrade-compatible default is `off`. Does not read a workspace `agents.json`; pass `--model`, `--tools`, and related flags explicitly |
| `kxm session start --id <id> (--mix a,b \| --workflow <definitionId>)` | Write a `kxm.session.v1` manifest under `.kxm/assets/sessions/<id>/` and create asset directories. **Does not start any process.** `--workflow` records the whole roster, not the definition's participants |
| `kxm session status` | Show PID claim files and recovery envelopes under `.kxm/state`; does not read `session.json` |
| `kxm session stop` | Request shutdown of **every** managed hub and worker process in the workspace — the same operation as `kxm mesh stop`; not scoped to a session |
| `kxm workflow list \| get \| start \| export` | Inspect, start, or export workflow runs. `list`/`get`/`export` read the **local** `.kxm/state/mesh.db`, not the configured hub |
| `kxm gate validate` | Parse the same active source the hub loads without printing secrets. Explicit `--file` wins; otherwise configure exactly one of `PI_MESH_WEBHOOK_WORKFLOWS_FILE` or inline `PI_MESH_WEBHOOK_WORKFLOWS`. Missing or ambiguous sources exit 2 |
| `kxm gate artifacts-exist --path <asset>` | Verify one non-empty regular file resolves within the configured workspace assets root; lexical or real-path escape fails closed |
| `kxm gate degrade <runId> <stageId> --requirement <key> --reason <text>` | Use the administrative token to approve a policy-declared lower peer minimum for the current attempt |
| `kxm gate signal` | Post a signed workflow callback |
| `kxm gate github watch` | Poll required GitHub checks and post the existing signed signal |
| `kxm mesh init` | Create empty `.kxm` directories; configuration remains project-owned and no package dogfood templates are copied |
| `kxm mesh status` | Check `/health` and `/ready` |
| `kxm mesh tui` | Open the read-only SSE observer dashboard; non-TTY output is one ANSI-free snapshot |
| `kxm mesh hub` | Start the mesh hub |
| `kxm mesh stop` | Request managed hub and worker shutdown |
| `kxm mesh smoke` | Opt-in two-worker real-Pi release harness |
| `kxm improve` | Bucket `.kxm/logs/telemetry.jsonl` events into a proposed-only improvement report; does not read the workflow journal |

Improvement telemetry is classified as `project` whenever a project or workflow identity is present, and as `cli` for unscoped operator behavior. Set `KXM_IMPROVE_TARGET=cli` or `KXM_IMPROVE_TARGET=project` only when an operator needs to override that generic classification; this changes report bucketing, not workflow state.

The gate group contains exactly the five implemented gates listed above. Names declared in a workspace `gates.json` that do not map to one of them (for example `quality`, `git-commit`, `jira-fetch`) are records with no runner; there is no `kxm gate run <name>`.

Global flags: `--json`, `--dry-run`, `--workspace`. Project-root `kxm init` discovers from the current directory, rejects `--workspace`, and intentionally ignores legacy `PI_MESH_*` workspace overrides; `--workspace` continues to scope current hub commands. `kxm workflow start <definitionId> --payload <JSON|@file>` creates a signed webhook delivery. With an active definition source, start, signal, and GitHub watch resolve that definition's `secretEnv` / `signalSecretEnv`; when no separate signal secret is declared, callbacks use the workflow-start secret, matching the hub. Generic credential variables are used only when no active definition source is configured. `--dry-run` never appends telemetry. Non-dry-run gate evidence and summaries are written to the protected telemetry JSONL after configured-value redaction; do not place unnecessary sensitive text in evidence. `kxm gate degrade` requires `PI_MESH_AUTH_TOKEN` to contain the administrative token; use `--dry-run --json` first and never put a secret in its reason. `kxm agent worker --name <name> --project <project>` and `kxm mesh hub` honor the same workspace flag. `--no-continue` disables every session resume; `--fresh-start` skips only the initial resume. `--session-isolation workflow` enables isolated contexts and starts a fresh scoped default history on first use; `--session-isolation off` is the upgrade-compatible default and keeps the former shared Pi history. GitHub watch posts an exact signed `failed` signal on timeout and exits `4`, preserving the distinction from a successful gate.

## Webhook workflow settings

Configure either `PI_MESH_WEBHOOK_WORKFLOWS` or `PI_MESH_WEBHOOK_WORKFLOWS_FILE`, never both. A definition selects a provider source, project, coordinator, event and payload filters, prompt template, and ordered stages. Use `secretEnv` to resolve the workflow-start HMAC secret from another environment variable. Use the optional `signalSecretEnv` for a separate callback secret; otherwise external signals use the workflow-start secret. Do not store either secret in JSON.

See [Webhook workflows](webhook-workflows.md) for the base schema and the complete Jira configuration under `.kxm/config/workflows`. See [Peer provenance and quorum gates](provenance-gates.md) for `evidencePolicies`, `workflowContext`, `evidenceRefs`, and explicit degradation.

## Delivery modes

| Mode | Use it when | Effect |
|---|---|---|
| `followUp` | Normal delegation | Handle after current work settles |
| `steer` | An active blocker requires a course change | Deliver at the next decision boundary |
| `nextTurn` | Information should wait for a later turn | Queue context without immediate work |

`followUp` is the safe default. Use [`.kxm/config/env.example`](../.kxm/config/env.example) as a reference, but load values through your shell, supervisor, container platform, or secret manager. Never commit real tokens.
