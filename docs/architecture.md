# Architecture

Pi Mesh Comms is a durable, single-node transport and integration layer for running coding agents. It deliberately avoids becoming a shared-memory framework or autonomous workflow scheduler.

## Workers

Agents and gates share one worker identity schema and one result envelope; they differ by driver.

| Kind | Driver | Operator command(s) | Meaning |
|---|---|---|---|
| `agent` | `ai` | `kxm agent worker --name <n> --project <p>` | Starts one long-lived Pi worker. Roster values in a workspace `agents.json` (model, thinking) are **not** applied by this command; pass `--model`, `--tools`, and related flags explicitly. |
| `gate` | `code` | `kxm gate validate`, `kxm gate artifacts-exist`, `kxm gate degrade`, `kxm gate signal`, `kxm gate github watch` | The five implemented deterministic operations. |

**Gate names in a workspace `gates.json` are records, not runners.** A record with `driver: "code"` is executable only if it maps to one of the five commands above. There is no `kxm gate run <name>` and no dispatcher; any other declared name (for example `quality`, `git-commit`, `jira-fetch`) is a planned gate that a stage instruction cannot cause to run. `kxm gate validate` parses workflow definitions; it does not check that a stage's named gates are runnable.

Shared schemas:

- `kxm.worker.v1` — worker identity (`kind`, `driver`, `name`, optional `project`, `model`, `thinking`, `purpose`)
- `kxm.worker-result.v1` — result envelope (`worker`, `command`, `ok`, `outcome`, `createdAt`, `summary`; additional fields are additive)

Envelope parity is a **shape** guarantee, not a **trust** guarantee. An agent-authored envelope, a gate-emitted envelope, and a hub-verified peer reply have different evidentiary weight; see *Trust boundaries*. Non-dry-run envelopes are written to `.kxm/logs/telemetry.jsonl` only by gate commands that use the shared result printer (`gate validate`, `gate artifacts-exist`, `gate degrade`, `gate signal`, and `gate github watch`). Live worker output, hub-side workflow checkpoints, and peer replies are not recorded there; the durable record of workflow activity is the hub's SQLite journal.

## Sessions (current behaviour)

`kxm session` is an early operator surface whose verbs do not yet share one lifecycle:

| Command | What it does today | What it does not do |
|---|---|---|
| `kxm session start --id <id> (--mix a,b \| --workflow <definitionId>)` | Resolves names against the workspace `agents.json` / `gates.json`, writes `.kxm/assets/sessions/<id>/session.json` (`kxm.session.v1`), creates `inputs/` and `outputs/` (plus `assets/workflows/<definitionId>/{inputs,outputs,generated}` in workflow mode), and exits. | Start any process, dispatch a workflow, run a gate, or set `KXM_SESSION_ID`. In `--workflow` mode it lists the **entire roster**, not the definition's participants, and does not read the definition. |
| `kxm session status` | Lists PID claim files and worker-recovery envelopes under `.kxm/state`. | Read `session.json` or report anything `session start` created. |
| `kxm session stop` | Requests shutdown of the hub **and every worker** with a PID file in the workspace. It takes no session ID and is the same operation as `kxm mesh stop`. | Stop one session. **Treat it as a global stop.** |

Treat `session.json` as a manifest for humans and dashboards. The effective execution primitives are `kxm mesh hub` (one hub process), `kxm agent worker` (one worker process), and `kxm workflow start` (one signed run).

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

The hub validates and authenticates requests, stores agents and messages, pushes addressed work over SSE, and exposes a separate administrative metadata-only operations SSE stream for dashboards. Operations wakeups and snapshots are project-scoped and never include request or reply bodies. The hub expires stale work and purges terminal records after the configured retention window. SQLite is the source of restart recovery; in-memory maps are the live working set.

**Source of truth.** Semantics are defined by the protocol and schema types (`src/protocol.ts`, `src/workflow.ts`), the hub's durable state (`.kxm/state/mesh.db`: agents, messages, workflow runs, journal), and reviewed workspace configuration in git (`.kxm/config`). The `kxm` CLI, the Pi extension, and the Claude MCP server are **clients** of that state. When a client's behaviour differs from the hub's or a definition's contract, the contract is authoritative and the client is the defect. One deliberate locality limitation remains: `kxm workflow list` / `get` read the local SQLite file rather than the configured hub, so they only describe runs when the operator is on the hub host. Start, signal, and GitHub watch now resolve credentials from the selected active definition and use the start secret as the documented callback fallback.

Signed webhook workflows add a durable run and coordinator message in one request. The stable provider delivery ID prevents duplicate Jira or GitHub retries. Ordered checkpoints enforce attempt limits and exact keyed evidence requirements. Local evidence can be accumulated when a coordinator enters a durable `waiting` state; a separately signed and deduplicated external result must complete the remaining named requirements before it can advance the stage. A separate journal preserves plans, decisions, contradictions, errors, and lessons for reviewed continuous improvement.

Peer-policy requirements add an evidence plane beside caller-authored strings.
At run creation, configured eligible agent selectors resolve to stable producer
IDs and are snapshotted into the run. The coordinator can create countable peer
work only for the current stage and attempt; the hub stamps immutable workflow
context on each authorized message. At checkpoint or wait, cited message IDs
are verified from durable state and converted into metadata-only snapshots with
producer identity, context, lifecycle timestamps, and request/reply hashes.
Quorum counts unique producers per requirement. The verified snapshot survives
normal terminal-message purging without retaining prompt or reply bodies in the
workflow record.

**The coordinator is never a producer.** The hub counts only replies to messages sent *by* the run's target *to* other agents. A policy whose `eligibleAgents` includes the target, or whose `minProducers` exceeds the number of other eligible agents, cannot be satisfied except through `kxm gate degrade`. The definition parser rejects the workflow target inside `eligibleAgents` and rejects `minProducers` beyond the eligible peer pool. Every lifecycle timestamp compared during verification is assigned by the hub's own clock, so worker clock skew does not affect provenance checks.

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

Stages form an ordered list. A failed checkpoint retries the **same** stage until `maxAttempts` is exhausted, after which the run is terminal; there are no back-edges (an instruction such as "failures return to build" is prose the engine cannot execute) and no resume verb. Workflow definitions are read from the single file or inline JSON the hub was started with. Each run records a secret-free semantic `definitionHash`, so credential rotation does not create false drift while behavior changes remain auditable.

`MeshClient` owns registration, rotating agent credentials, heartbeats, bounded HTTP requests, SSE reconnects, and automatic re-registration after hub state loss. The Pi extension adds peer messaging plus workflow checkpoint, wait, journal, and reporting tools. Claude MCP adds the same workflow plane plus `mesh_inbox` and `mesh_reply`.

## Message lifecycle

```text
queued ── acknowledge ──> delivered ── reply ──> replied
   │                         │
   ├──── sender cancel ──────┴───────────────> cancelled
   └──── TTL elapsed ────────────────────────> expired
```

`error` is also terminal. The sender receives an ID immediately. An idempotency key deduplicates an exact retry by the same sender. It does not prevent the recipient from repeating external side effects, so tasks must still be designed to be safely retryable.

Queued and delivered records survive restart. When the same project and agent name reconnect, the hub rotates the agent key and replays both states with the same message ID; live clients suppress duplicate notifications and simultaneous turns for that ID. Delivery remains at-least-once: a crash after external side effects but before reply can execute the work again, so handlers must be idempotent. Terminal records are retained for diagnostics and polling, then removed automatically.

## Trust boundaries

The administrative token manages administrative routes and acts as the project token only where no explicit project token exists. A configured project token can access only its project. Registration returns an agent key for identity-specific routes. Token comparisons are constant-time after hashing, and prompt or reply bodies are excluded from logs.

Provenance is bounded by those credentials. A project-token holder can register
a new agent or reclaim an offline agent name and its durable ID in that project,
so all holders of one project credential form a fully trusted provenance
domain. A verified peer reply proves the hub-observed durable producer and
context, not organizational or person independence, model identity,
non-collusion, correctness, or human approval. Deployments that use provenance
gates should reserve a distinct administrative token, issue explicit project
tokens per trust domain, protect network and state access, and keep
consequential repository or human gates authoritative.

`.kxm/state/mesh.db` is not encrypted by the application and contains messages plus agent credentials — message bodies are stored as sent, not redacted. Protect the `.kxm` runtime directories with operating-system permissions and encrypted storage where required. Structured hub logs omit message bodies, but raw worker agent logs (`pi-agent-*.log`) capture the Pi process's stdout and stderr verbatim and may contain model or tool output, including anything a tool printed. Peer content remains untrusted regardless of authentication.

**Filesystem write boundaries are not enforced.** The worker launcher's `PI_MESH_WORKER_TOOLS` allowlist restricts which Pi tools a worker may call (for example omitting `write`, `edit`, and the platform shell); it does not restrict paths. Any worker that has a write-capable tool can modify any file its OS user can reach, in any repository under its working directory. Workspace roster fields such as `ownership.writeAgent` and `roles` in `agents.json`, and `mode` or `notes` in `host.json`, are **not read by the hub, the CLI, or the launcher** (host mode is inferred from the `PI_MESH_SERVER_URL` hostname). They document intent for humans and prompts. Deployments that need a real boundary should give non-writer workers a tool allowlist without write tools and/or a separate read-only Git worktree, and review changed paths against the plan.

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
| `src/redact.ts` | Secret and token redaction helpers |
| `src/inbox.ts` | Deduplicated Claude MCP inbox notification delivery |
| `src/artifacts-exist.ts` | Asset containment and non-empty regular-file gate |
| `src/tui.ts` | Read-only SSE mesh observer dashboard |
| `src/cli.ts` | Operator CLI (agent, session, workflow, gate, mesh, improve); a client of the hub |
| `src/envelope.ts` | `kxm.worker.v1` / `kxm.worker-result.v1` constructors |
| `src/session.ts` | Roster loading and `kxm.session.v1` manifest writing; does not spawn processes |
| `src/telemetry.ts` | Appends redacted CLI result envelopes to `.kxm/logs/telemetry.jsonl` |
| `src/improve.ts` | Buckets telemetry events into a proposed-only improvement report; does not read the workflow journal |
| `src/github-watch.ts` | GitHub check polling to signed signals |
| `src/retrospective.ts` | Bounded Markdown/JSON export |
| `src/recovery.ts` | Worker recovery envelope consume |
| `dist/cli.js` | Generated self-contained operator CLI runtime |
| `dist/server.js` | Generated self-contained hub runtime |
| `dist/mcp-server.js` | Generated self-contained Claude runtime |

The generated runtimes are committed because installed packages must work without a development toolchain or runtime TypeScript stripping. Edit the source, run `npm run build`, and commit the source and corresponding files under `dist/`.

The command groups described in this document (`agent`, `session`, `workflow`, `gate`, `mesh`, `improve`) are defined in `src/cli.ts`. The committed `plugins/kxm-mesh/dist/cli.js` that `scripts/kxm.mjs` launches may lag the source: if `kxm --help` prints a flat command list (`init | validate | status | hub | worker | stop | workflow … | signal | github watch | retrospective export | smoke`), the bundle predates the Commander groups and must be rebuilt and committed before the operator surface here is what actually runs.

Peer-policy fields are additive to SQLite schema version 2 because agents,
messages, and workflow runs are stored as JSON records. Existing schema-v2
databases and legacy workflow history remain readable; legacy evidence cannot
satisfy a newly declared peer policy. Back up the database before upgrading as
described in [Operations](operations.md).
