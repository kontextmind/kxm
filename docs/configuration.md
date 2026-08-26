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

Project tokens are an authorization boundary. A project-specific token can register only in its mapped project and see only that project's agents and messages. The administrative token remains a fallback for projects without an explicit entry.

PowerShell example:

```powershell
$env:PI_MESH_AUTH_TOKEN = "replace-with-an-admin-token"
$env:PI_MESH_PROJECT_TOKENS = '{"web":"web-token","api":"api-token"}'
$env:PI_MESH_WORKSPACE_DIR = "D:\work\product\.kxm"
pi-mesh hub
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
| Default `mesh_await` timeout | 30 minutes |
| Default workflow signal wait | 24 hours |
| Workflow signal wait range | 1 second to 30 days |

The `ttlMs` field can override the default TTL per message. Automated senders should set a stable `idempotencyKey` so an exact retry returns the original message instead of creating a duplicate. Reusing the key with different content returns a conflict.

`mesh_fanout` derives a bounded idempotency key from `idempotencyKeyPrefix`, the correlation ID when supplied, and the normalized target name. Reuse the same prefix and correlation ID for an exact retry of one workflow run. A later workflow may safely reuse the human-readable prefix with a different correlation ID without colliding with retained peer messages.

When a Pi peer produces more than 32,000 characters, the extension returns a bounded truncated reply instead of leaving the request pending. The full output may remain in the replying agent's local Pi session or `.kxm/logs/pi-agent-<name>.log` when the long-lived worker is used.

## Long-lived worker settings

| Variable | Default | Description |
|---|---|---|
| `PI_MESH_WORKDIR` | Current directory | Repository used by the headless Pi worker |
| `PI_MESH_WORKER_LOG_PATH` | `.kxm/logs/pi-mesh-worker-<agent>.jsonl` | Structured worker lifecycle log |
| `PI_MESH_AGENT_LOG_PATH` | `.kxm/logs/pi-agent-<agent>.log` | Captured headless Pi stdout and stderr |
| `PI_MESH_PI_COMMAND` | `pi` or `pi.cmd` | Explicit Pi executable path when it is not on `PATH` |
| `PI_MESH_WORKER_CONTINUE` | `true` | Resume the most recent Pi session after a restart |
| `PI_MESH_WORKER_DRAIN_MS` | `15000` | Graceful SIGTERM wait before SIGKILL |
| `PI_MESH_WORKER_MODEL` | Pi default | Optional model selector passed to Pi |
| `PI_MESH_WORKER_MAX_RESTARTS` | Unlimited | Non-negative process restart limit; service managers may set their own policy |
| `PI_MESH_SMOKE` | unset | Set to `1` to enable the opt-in real multi-Pi smoke command |
| `PI_MESH_SMOKE_MODELS` | unset | Two distinct comma-separated model IDs for the real-Pi release smoke |
| `PI_MESH_SMOKE_TIMEOUT_MS` | `120000` | Per-phase real-Pi smoke timeout (`30000`–`600000`) |
| `PI_MESH_SMOKE_PI_COMMAND` | discovered `pi` | Optional explicit Pi executable for a self-hosted runner |

`PI_MESH_AGENT_NAME` and `PI_MESH_PROJECT` are required by `pi-mesh worker`. The remaining agent settings are inherited by the spawned Pi RPC process. The worker resolves `.kxm` inside `PI_MESH_WORKDIR`, creates the standard directories, and passes their absolute paths to Pi. A fast `--continue` failure writes `.kxm/state/worker-recovery-<agent>.json` and retries once without `--continue`.

## Operator CLI

`pi-mesh` is additive and does not replace `pi-mesh-hub` or `pi-mesh-worker`.

| Command | Purpose |
|---|---|
| `pi-mesh init` | Create `.kxm` directories |
| `pi-mesh validate` | Parse workflow definitions using env names, not printed secrets |
| `pi-mesh status` | Check `/health` and `/ready` |
| `pi-mesh github watch` | Poll required GitHub checks and post the existing signed signal |
| `pi-mesh retrospective export <runId>` | Export proposed Markdown/JSON from local durable state under `.kxm/assets/retrospectives` |
| `pi-mesh smoke` | Opt-in two-worker real-Pi release harness; verifies transport, fanout, restart/resume, journal, and checkpoint |

Global flags: `--json`, `--dry-run`, `--workspace`. `workflow start <definitionId> --payload <JSON|@file>` creates a signed webhook delivery using `PI_MESH_WORKFLOW_SECRET`. `worker --name <name> --project <project> [--model <provider/model>]` and `hub` honor the same workspace flag. GitHub watch posts an exact signed `failed` signal on timeout and exits `4`, preserving the distinction from a successful gate.

## Webhook workflow settings

Configure either `PI_MESH_WEBHOOK_WORKFLOWS` or `PI_MESH_WEBHOOK_WORKFLOWS_FILE`, never both. A definition selects a provider source, project, coordinator, event and payload filters, prompt template, and ordered stages. Use `secretEnv` to resolve the workflow-start HMAC secret from another environment variable. Use the optional `signalSecretEnv` for a separate callback secret; otherwise external signals use the workflow-start secret. Do not store either secret in JSON.

See [Webhook workflows](webhook-workflows.md) for the schema and the complete Jira configuration under `.kxm/config/workflows`.

## Delivery modes

| Mode | Use it when | Effect |
|---|---|---|
| `followUp` | Normal delegation | Handle after current work settles |
| `steer` | An active blocker requires a course change | Deliver at the next decision boundary |
| `nextTurn` | Information should wait for a later turn | Queue context without immediate work |

`followUp` is the safe default. Use [`.kxm/config/env.example`](../.kxm/config/env.example) as a reference, but load values through your shell, supervisor, container platform, or secret manager. Never commit real tokens.
