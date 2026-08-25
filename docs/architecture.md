# Architecture

Pi Mesh Comms is a durable, single-node transport and integration layer for running coding agents. It deliberately avoids becoming a shared-memory framework or autonomous workflow scheduler.

## Design goals

- Discover peers by declared purpose.
- Exchange bounded tasks without merging model contexts.
- Continue independent work using message IDs and explicit state.
- Survive hub restarts without losing identities or queued messages.
- Package one implementation for Pi, Agent Skills, Claude plugins, and MCP.
- Preserve each harness's safety, approval, and filesystem rules.

## Non-goals

- Automatic task decomposition or peer selection.
- Sharing hidden reasoning or complete conversation histories.
- Coordinating concurrent filesystem writes.
- Horizontal scaling, multi-primary storage, or exactly-once execution.
- Replacing verification of peer output.

## Components

```text
Pi extension ── HTTP/SSE ──┐
                           ├── Hub ── SQLite WAL
Claude MCP ─── HTTP/SSE ───┘    ├── SQLite WAL
     │                          ├── signed webhook workflows
     └── stdio MCP ── Claude    ├── readiness + metrics
                                └── operations + learning journal
```

The hub validates and authenticates requests, stores agents and messages, pushes addressed work over SSE, expires stale work, and purges terminal records after the configured retention window. SQLite is the source of restart recovery; in-memory maps are the live working set.

Signed webhook workflows add a durable run and coordinator message in one request. The stable provider delivery ID prevents duplicate Jira or GitHub retries. Ordered checkpoints enforce attempt limits and evidence counts. A separate journal preserves plans, decisions, contradictions, errors, and lessons for reviewed continuous improvement.

`MeshClient` owns registration, rotating agent credentials, heartbeats, bounded HTTP requests, SSE reconnects, and automatic re-registration after hub state loss. The Pi extension adds `mesh_list`, `mesh_send`, `mesh_get`, `mesh_await`, and `mesh_cancel`. Claude MCP adds the same outbound tools plus `mesh_inbox` and `mesh_reply`.

## Message lifecycle

```text
queued ── acknowledge ──> delivered ── reply ──> replied
   │                         │
   ├──── sender cancel ──────┴───────────────> cancelled
   └──── TTL elapsed ────────────────────────> expired
```

`error` is also terminal. The sender receives an ID immediately. An idempotency key deduplicates an exact retry by the same sender. It does not prevent the recipient from repeating external side effects, so tasks must still be designed to be safely retryable.

Queued and delivered records survive restart. Agents load offline and resume their prior ID when the same project and name reconnect; the hub rotates the agent key. Terminal records are retained for diagnostics and polling, then removed automatically.

## Trust boundaries

The administrative token manages administrative routes and acts as the project token only where no explicit project token exists. A configured project token can access only its project. Registration returns an agent key for identity-specific routes. Token comparisons are constant-time after hashing, and prompt or reply bodies are excluded from logs.

SQLite is not encrypted by the application and contains messages plus agent credentials. Protect its directory with operating-system permissions and encrypted storage where required. Peer content remains untrusted regardless of authentication.

## Source layout

| Path | Responsibility |
|---|---|
| `src/protocol.ts` | Types, limits, validation, and identifiers |
| `src/store.ts` | SQLite schema, persistence, and health checks |
| `src/hub.ts` | HTTP/SSE API, policy, lifecycle, and metrics |
| `src/client.ts` | Registration, transport, recovery, and polling |
| `src/extension.ts` | Native Pi integration |
| `src/mcp-server.ts` | Claude MCP and channel integration |
| `src/server.ts` | Hub executable and environment configuration |
| `src/workflow.ts` | Workflow definitions, checkpoints, prompt rendering, and improvement reports |
| `dist/mcp-server.js` | Generated self-contained Claude runtime |

The MCP bundle is committed because marketplace installation does not run a dependency-install step. Edit the source, run `npm run build:mcp`, and commit both source and bundle.
