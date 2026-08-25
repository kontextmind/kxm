# pi-mesh-comms

A small HTTP/SSE communication network for running Pi agents. It provides the same core shape as `coms-net`:

- discover online agents;
- send a request and receive a message ID;
- poll or await the response;
- push inbound work into the receiving Pi session;
- automatically return the receiving agent's settled final response.

The hub uses only Node.js built-ins. The Pi extension uses Pi's normal `typebox` tool schemas.

## Architecture

```text
Pi planner ──HTTP──┐
                   ├── pi-mesh hub ──SSE──> inbound Pi turns
Pi builder ──HTTP──┤       │
                   │       └── presence, heartbeats, request state
Pi reviewer ─HTTP──┘
```

The hub is deliberately a transport, not a shared-memory brain. Each agent keeps its own context. Messages are bounded, project-scoped, authenticated, and addressed to an agent name or ID.

## Requirements

- Node.js 22.6 or newer
- Pi with extension support

## Quick start

### 1. Start the hub

PowerShell:

```powershell
$env:PI_MESH_AUTH_TOKEN = "replace-with-a-long-random-token"
npm run hub
```

The hub binds to `127.0.0.1:7331` by default. It refuses non-loopback binding unless an authentication token is configured.

### 2. Start two Pi agents

Terminal one:

```powershell
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$env:PI_MESH_AUTH_TOKEN = "replace-with-a-long-random-token"
$env:PI_MESH_PROJECT = "demo"
$env:PI_MESH_AGENT_NAME = "planner"
$env:PI_MESH_AGENT_PURPOSE = "Plans work and coordinates handoffs"
pi -e ./src/extension.ts
```

Terminal two:

```powershell
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$env:PI_MESH_AUTH_TOKEN = "replace-with-a-long-random-token"
$env:PI_MESH_PROJECT = "demo"
$env:PI_MESH_AGENT_NAME = "builder"
$env:PI_MESH_AGENT_PURPOSE = "Implements scoped coding tasks"
pi -e ./src/extension.ts
```

Then ask either agent:

```text
List the mesh peers. Ask builder to inspect the repository and recommend the
first implementation step, then wait for its response.
```

## Pi tools

| Tool | Purpose |
|---|---|
| `mesh_list` | List online agents in the current project |
| `mesh_send` | Send a focused request; returns a message ID |
| `mesh_get` | Non-blocking status check |
| `mesh_await` | Wait for a settled peer response |

`followUp` is the default delivery mode. It lets the receiver finish its current work before handling the peer request. Use `steer` only for an active blocker; `nextTurn` queues information without triggering work.

## HTTP protocol

The MVP exposes:

```text
GET    /health
POST   /v1/agents/register
GET    /v1/agents
POST   /v1/agents/:id/heartbeat
DELETE /v1/agents/:id
GET    /v1/events?agentId=...       # SSE
POST   /v1/messages
POST   /v1/messages/:id/ack
POST   /v1/messages/:id/reply
GET    /v1/messages/:id
```

The shared bearer token authenticates access to the hub. Registration returns an ephemeral per-agent key; agent-specific routes require that key and the agent ID.

## Safety and scaling boundaries

- The hub never sends prompt bodies to its logs.
- Messages default to a five-hop limit.
- Content is limited to 32,000 characters.
- Agents become stale after 30 seconds without a heartbeat.
- Names are unique among live agents in a project.
- State is in memory; restarting the hub starts a fresh pool.
- This does not prevent filesystem write conflicts. Use one writer, path ownership, or separate Git worktrees.
- Put TLS in front of the hub before using it across an untrusted network.

## Verify

```powershell
npm test
npm run check
```

## Next production steps

1. Add durable SQLite storage for messages and resumable agent identity.
2. Add message expiration, cancellation, and idempotency keys.
3. Add per-project authorization rather than one hub-wide token.
4. Add OpenTelemetry metrics and redacted audit events.
5. Add an MCP bridge for Claude Code, Codex, and other harnesses.
6. Add a task ledger above the transport instead of encoding workflow state in chat messages.

