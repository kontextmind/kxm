# Configuration reference

Pi Mesh Comms uses environment variables for the hub and Pi extension. The Claude Code plugin maps its settings to the same client values.

## Hub settings

| Variable | Default | Description |
|---|---:|---|
| `PI_MESH_HOST` | `127.0.0.1` | Listening interface |
| `PI_MESH_PORT` | `7331` | TCP port; `0` selects an available port |
| `PI_MESH_AUTH_TOKEN` | None | Administrative bearer token and fallback project token |
| `PI_MESH_PROJECT_TOKENS` | None | JSON object mapping project names to bearer tokens |
| `PI_MESH_DATA_PATH` | `.pi-mesh/mesh.db` | SQLite database path; use `:memory:` only for disposable runs |
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
$env:PI_MESH_DATA_PATH = "D:\pi-mesh\mesh.db"
npm run hub
```

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

The `ttlMs` field can override the default TTL per message. Automated senders should set a stable `idempotencyKey` so an exact retry returns the original message instead of creating a duplicate. Reusing the key with different content returns a conflict.

## Long-lived worker settings

| Variable | Default | Description |
|---|---|---|
| `PI_MESH_WORKDIR` | Current directory | Repository used by the headless Pi worker |
| `PI_MESH_PI_COMMAND` | `pi` or `pi.cmd` | Explicit Pi executable path when it is not on `PATH` |
| `PI_MESH_WORKER_CONTINUE` | `true` | Resume the most recent Pi session after a restart |
| `PI_MESH_WORKER_MODEL` | Pi default | Optional model selector passed to Pi |
| `PI_MESH_WORKER_MAX_RESTARTS` | Unlimited | Non-negative process restart limit; service managers may set their own policy |

`PI_MESH_AGENT_NAME` and `PI_MESH_PROJECT` are required by `npm run worker`. The remaining agent settings are inherited by the spawned Pi RPC process.

## Webhook workflow settings

Configure either `PI_MESH_WEBHOOK_WORKFLOWS` or `PI_MESH_WEBHOOK_WORKFLOWS_FILE`, never both. A definition selects a provider source, project, coordinator, event and payload filters, prompt template, and ordered stages. Use `secretEnv` to resolve the HMAC secret from another environment variable instead of storing it in JSON.

See [Webhook workflows](webhook-workflows.md) for the schema and the complete Jira example.

## Delivery modes

| Mode | Use it when | Effect |
|---|---|---|
| `followUp` | Normal delegation | Handle after current work settles |
| `steer` | An active blocker requires a course change | Deliver at the next decision boundary |
| `nextTurn` | Information should wait for a later turn | Queue context without immediate work |

`followUp` is the safe default. Copy `.env.example` as a reference, but load values through your shell, supervisor, container platform, or secret manager. Never commit real tokens.
