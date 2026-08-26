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

Signed webhook workflows add a durable run and coordinator message in one request. The stable provider delivery ID prevents duplicate Jira or GitHub retries. Ordered checkpoints enforce attempt limits and exact keyed evidence requirements. Local evidence can be accumulated when a coordinator enters a durable `waiting` state; a separately signed and deduplicated external result must complete the remaining named requirements before it can advance the stage. A separate journal preserves plans, decisions, contradictions, errors, and lessons for reviewed continuous improvement.

## Workflow lifecycle

```text
running ── checkpoint passed ──> next stage / completed
   │
   ├── checkpoint warning or failure ──> retry / failed
   │
   └── explicit external wait ──> waiting
                                  ├── signed result ──> retry / next stage / completed
                                  └── deadline ──────> failed
```

An ordinary coordinator reply while `running` is a failure because required work was abandoned. A reply while `waiting` is expected: it releases compute and context until the callback creates a fresh message. Signal receipts live inside the persisted workflow record, so provider retries remain deduplicated after restart.

`MeshClient` owns registration, rotating agent credentials, heartbeats, bounded HTTP requests, SSE reconnects, and automatic re-registration after hub state loss. The Pi extension adds peer messaging plus workflow checkpoint, wait, journal, and reporting tools. Claude MCP adds the same workflow plane plus `mesh_inbox` and `mesh_reply`.

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

`.kxm/state/mesh.db` is not encrypted by the application and contains messages plus agent credentials. Protect the `.kxm` runtime directories with operating-system permissions and encrypted storage where required. Structured hub logs omit message bodies, but raw worker agent logs may contain model or tool output. Peer content remains untrusted regardless of authentication.

## Source layout

| Path | Responsibility |
|---|---|
| `.kxm/config/` | Tracked workspace workflow and harness configuration |
| `.kxm/logs/` | Ignored hub, worker, and Pi process logs |
| `.kxm/assets/` | Intentional workflow inputs and outputs |
| `.kxm/state/` | Ignored SQLite and restart-recovery state |
| `src/protocol.ts` | Types, limits, validation, and identifiers |
| `src/store.ts` | SQLite schema, persistence, and health checks |
| `src/hub.ts` | HTTP/SSE API, policy, lifecycle, and metrics |
| `src/client.ts` | Registration, transport, recovery, and polling |
| `src/extension.ts` | Native Pi integration |
| `src/mcp-server.ts` | Claude MCP and channel integration |
| `src/server.ts` | Hub executable and environment configuration |
| `src/workflow.ts` | Workflow definitions, checkpoints, prompt rendering, and improvement reports |
| `src/diagnostics.ts` | Allowlisted failure classes and 403 hints |
| `src/cli.ts` | Command-first operator surface |
| `src/github-watch.ts` | GitHub check polling to signed signals |
| `src/retrospective.ts` | Bounded Markdown/JSON export |
| `src/recovery.ts` | Worker recovery envelope consume |
| `dist/cli.js` | Generated self-contained operator CLI runtime |
| `dist/server.js` | Generated self-contained hub runtime |
| `dist/mcp-server.js` | Generated self-contained Claude runtime |

The generated runtimes are committed because installed packages must work without a development toolchain or runtime TypeScript stripping. Edit the source, run `npm run build`, and commit the source and corresponding files under `dist/`.
