---
schema: "kxm.doc.v1"
id: "RES-A2A-CROSS-HOST"
type: "research"
title: "Cross-host agent communication and the hosted control plane"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-17"
updated: "2026-09-24"
authority: "hypothesis"
confidence: "uncertain"
summary: "Web research with options, trade-offs and recommendations for agent-to-agent communication across hosts and the surrounding control plane: context, memory, restarts, discovery, coordination, tasks, plans, steering, improvement, wiki, MCP apps, telemetry, secrets, per-account hosting and agent lifecycle. Reconciled against Tracking on 2026-09-20; schedules nothing."
tags: ["research", "a2a", "cross-host", "transport", "memory", "telemetry", "steering", "wiki", "mcp", "secrets", "hosting", "lifecycle"]
related:
  - implementation-plan.md
  - plan-per-tenant-hosting.md
  - plan-cross-host-phase.md
  - plan-unified-kxm-milestones.md
  - plan-ssh-remote-execution.md
  - plan-agent-communication-steering.md
  - research-memory-studio-forks.md
  - research-agent-producer-architecture.md
  - ../docs/contracts/architecture.md
  - ../docs/contracts/synchronization.md
  - history/agent-communication-envelopes-draft.md
  - research-jev-system-one.md
depends_on: []
blocked_by: []
details:
  research_status: "web_source_review"
  research_date: "2026-09-17"
  baseline_commit: "77beda4"
  method: "six parallel primary-source research passes, reconciled; unverified items listed"
  platform_repos: ["kontextmind/dev-vm-platform", "kontextmind/kxmd-auth", "kontextmind/kxmd-portal"]
  reconciled_against: "implementation-plan.md Tracking, 2026-09-20"
  reconciled_at_commit: "87b428f"
  sequencing_status: "2026-09-17 M0–M9 mapping rejected; delivery is Tracking's S0–S5 queue"
  contracts_path: "docs/vnext/ was renamed to docs/contracts/; body wording left as dated"
---

# Research: cross-host agent communication and the hosted control plane

Tracking: [`implementation-plan.md`](implementation-plan.md). This is a
research record, not an execution tracker; the Status against Tracking
section is the reading guide; the sequencing section at the end records a
rejected proposal.

Research date 2026-09-17. Every version and date was checked against a
primary source on that day unless marked unverified. Recommendations are
constrained by the accepted vNext contracts: a local Runtime owns execution;
the hub coordinates; only allowlisted, pre-redacted events sync; shared
mutable actions need a fenced lease; unknown side effects are never replayed;
credentials and repository contents stay Runtime-local; memory and learned
content never grant tools, secrets, approvals or policy; learned executable
behavior activates only through a reviewed Git change.

## Status against Tracking (2026-09-20)

This section is the reading guide for everything below it. [Tracking](implementation-plan.md#tracking-working-tree-not-a-release)
is the only execution tracker; this file schedules nothing, and the dated
bodies in §1 to §18 are unchanged 2026-09-17 web-source evidence. Where a
body and this section disagree, this section is current.

- **Delivery is S0–S5.** Tracking's "The one queue" is the only delivery
  sequence. S0, S1 (PR #253) and S3 (PR #256) are delivered; S2 (portal reads
  authoritative state) is next. No topic in this file is in that queue, and
  S0–S5 make zero event-store or hub-store schema change, so every table,
  endpoint and lease proposed below is outside MVP by construction.
- **Hosting is one tenant, one box, one hub.** The hub carries a tenant
  label, binds loopback, and interprets no browser identity; Authentik and the
  portal own the browser; the portal's server-side backend is the hub's hosted
  client with existing machine credentials; there is no PostgreSQL write path.
  §16's `kxm-hubs` VM with per-account hub processes, §16's hub-as-OAuth-2.1
  resource server with RFC 9728 metadata, and §18's ledger, firewall and
  split-DNS changes are superseded by those rulings. Hub-side JWT verification,
  token broker and OIDC callback are rejected, not deferred; reopening any of
  them needs a new written decision in Tracking.
- **Cross-host today is `kxm peer`.** Live agent-to-agent traffic is
  `kxm peer send`, `await`, `reply` and `fanout` over the hub HTTP API with
  the existing bearer tokens, and in-hub handoffs use the
  `kxm.assignment-request.v1` envelope family. The signed outbox and inbox,
  roster, presence leases and fenced run leases in §1, §2, §3 and §6 belong to
  Phase 8 (distributed synchronization), which stays post-MVP. Remote MCP on
  the hub (§1, §14) is not selected and has no trigger.
- **A2A Protocol is a projection of the journal, never its transport.** That
  2026-09-17 reconciliation stands. No Agent Card, A2A binding or push surface
  is scheduled; the mapping is documented here and implemented only when a
  concrete external caller exists and Tracking records that decision.
- **Coordinator inboxes and steering are post-MVP behind triggers.** §3 waits
  on Tracking's coordinator intake dispatch or rebinding trigger; §11 waits on
  "polling proved insufficient". `plan-agent-communication-steering.md` is a
  design reference, not a backlog. Polling is the MVP visibility model.
- **Wiki compile and ingest (§13) are unselected.** The "punt until public
  npm" reason expired when `@kontextmind/kxm@0.7.0` shipped. Expiry is not
  selection; a new decision is required.
- **Peer-reply evidence (§8, §9).** `producerPolicy.acceptedStatuses` is a
  recorded gap with its trigger in Tracking, not scheduled work; nothing here
  changes settlement semantics.
- **Naming.** Where the dated bodies say "vNext contracts" they mean the
  contracts now under `docs/contracts/`. The product is KXM; no old name in
  the bodies is a current surface.
- **Sequencing.** The M0–M9 mapping at the end of this file is the rejected
  2026-09-17 proposal, kept for the record. The current mapping is in
  "Sequencing against Tracking (2026-09-20)".

## Summary of recommendations

| # | Topic | Recommendation | First slice | Deferred | Status (2026-09-20) |
|---|---|---|---|---|---|
| 1 | Transport | Signed pull-first outbox/inbox between Runtimes and hub; hub as remote MCP server for agent calls; SSH or Tailscale as substrate; A2A as an edge projection only | Outbox and peer-link tables, two peer endpoints, tools over Streamable HTTP with bearer token | NATS, SLIM, gRPC, stateless MCP mode, A2A push | Post-MVP (Phase 8); remote MCP and RFC 9728 not selected; A2A projection ruling kept |
| 2 | Discovery | Signed roster with pinned keys plus hub presence leases; Tailscale tags for admission; A2A cards only with 1C | `roster.json`, presence heartbeats, `kxm_state` offline view | Registries, DHTs, mDNS | Post-MVP (Phase 8); per-workspace roster assumed §16, superseded there |
| 3 | Coordinator | One coordinator per run under a hub-issued fenced lease; persistent identities with durable inboxes; wake hint plus mandatory polling | `run_lease` with generation, inbox cursors, SSE hint, rate limits | Email/SMS bindings, auto takeover, multi-hub election | Post-MVP; trigger: coordinator intake dispatch or rebinding selected |
| 4 | Shared context | Event-sourced outbox plus a capped `kxm.context-bundle.v1` at stage boundaries; digests for blobs | The bundle event with a 16 KB cap | CRDTs, artifact store | Not selected (Phase 9 / proposed M5 scope) |
| 5 | Memory | Git-backed markdown tree with promotion as a reviewed commit; per-Runtime FTS5 cache; `memoryRev` pinned | `memory/` tree, `kxm promote` commit, FTS5 recall | Embeddings, hub store, Mem0/Graphiti/Cognee | Not selected (Phase 9 / proposed M5 scope) |
| 6 | Restarts | Keep the event-sourced Runtime; hub `leases` with fencing; heartbeats mark runs orphaned; Restate-style pause for unknown effects; Claude `SessionStore` mirror | Leases table, heartbeat rows, session mirror | Restate, Temporal, auto migration | Local restart path exists (S1); cross-host leases post-MVP (Phase 8) |
| 7 | Telemetry | OTel-shaped JSONL as source of truth; trace-context contract; journal kept separate; Phoenix as first sink | Trace ids on every record, `TRACEPARENT` at spawn, cursor exporter | Native SDK, Langfuse v4 | Not selected; cost tracking is a Decided requirement, the exporter is not |
| 8 | Workflows and gates | Gates as in-toto signed receipts; two-phase transitions; declarative stage graph with lint | `kxm.receipt.v1`, per-host keys, `kxm workflow lint` | A2A bindings, m-of-n UI | Existing receipts unchanged; signed receipts and lint not selected |
| 9 | Tasks and goals | Hub journal as claim authority with leases and fencing; git for intent; trackers as projections | `attempts` table and claim protocol | Postgres, NATS, Beads | Not selected; peer-evidence gap recorded with trigger; Postgres ruled out as write path |
| 10 | Plans | Git-authoritative plans with digest read model, schema lint, digest-bound tasks with drift flags | `revision` digest, `kxm plan lint`, `stale` flag | OpenSpec layout, CRDT | Plan authority settled by S0 prose; digest and lint not selected |
| 11 | Steering | Hub-relayed signed envelopes bound to attempt and fence with queued, acknowledged, applied states; tool narrowing at the Runtime | `seq`/`fence`/`ttl` on steer, ack and applied receipts, `PreToolUse` enforcement | Cedar/OPA, direct mTLS | Post-MVP; trigger: polling proved insufficient; design reference only |
| 12 | Improvement | ACE-style delta candidates from each host, hub dedupe, PR-only activation; eval runner second | `kxm improve` deltas, weekly PR | GEPA/DSPy loops | Not selected (Phase 9) |
| 13 | Wiki | Git-backed `docs/kb/` with provenance and `written_by`; hub as index and linter | `kxm kb lint`, `kxm kb index`, `kxm kb compile` design (shipping stays punted until public npm) | Graphs, CRDT editing, hosted mirrors | Unselected; npm reason expired, no new decision |
| 14 | MCP apps | Remote MCP hub plus stdio shim first; read-only app views over Studio read models second | Streamable HTTP endpoint, shim forwarding | Decision apps, A2A | Superseded for MVP by S2 portal reads; remote MCP not selected |
| 15 | Secrets | Hub owns references and grants, never values; Proton Pass PAT per workspace as interim resolver; gitleaks gate | Env schema, `pass://` resolver, gitleaks gate | Hub-native store, OpenBao | Not selected; rotation stays with existing token resolution |
| 16 | Hosted hub | One `kxm-hubs` VM on VLAN 30 with a hub process and SQLite per account; Authentik tokens; Caddy route; local Runtime per workspace | Systemd template, route, provider, roster enrol | Postgres RLS, Tailscale on workspaces | Superseded by the four per-tenant hosting rulings |
| 17 | Agent lifecycle | Four classes (`task`, `session`, `resident`, `daemon`); "always-on" is a hub-side `resident` identity, not a process; Runtime launches systemd transient units inside workspace VMs; hub is the only scheduler and lease authority; cross-host launch is an admitted command with a spawn lease | `kxm.agent-spec/v1` with `task` and `session`, `kxm agent run --spec`, `POST /v1/launches`, `lost` state, orphan reconciliation | Hub cron, VM wake-on-launch, Podman, Firecracker, orchestrators | Not selected; VM launch substrate superseded with §16; taxonomy stays hypothesis |
| 18 | Platform fit | The kxmd platform fits; three configuration changes needed | Ledger entry, one firewall rule, split DNS | Nothing architectural | Superseded; tenant box is already provisioned; S5 owns edge DNS/TLS/Authentik |

## How the pieces fit

```text
tenant box (one tenant = one box = one hub; Tracking rulings 2026-09-20)
  reverse proxy + Authentik ── TLS and browser sessions on the portal's own routes
        │ server-side only
  portal backend ── existing machine credentials ──► hub (loopback)
                                                        ▲
  Runtime (loopback) ── execution, worktrees, harness ──┘
  state set: .kxm/state/kxm.db, Runtime registry, per-project event stores,
             bindings, prompt sidecars, configuration (backed up as one set)

operator laptop (default, unchanged)
  kxm hub start ── local token-authenticated hub
  kxm peer send / await / reply / fanout ── over the hub HTTP API, bearer tokens
  kxm hub bind <url> ── labelled loopback or remote; refused without a credential

not drawn, not scheduled: signed outbox/inbox, roster, fenced leases (Phase 8);
remote MCP on the hub (no decision); A2A Protocol (projection only, on demand)
```

Two shapes, no third. The hosted shape adds one supervised process to a box
the portal already owns; the browser never reaches the hub, and the hub
never interprets browser identity. The local shape is what every existing
command does today. The rest of this file describes mechanisms that would
sit between Runtimes and a hub on different hosts; none of them exists, and
Tracking has selected none of them.

## 1. Cross-host transport and protocol

### State of the art (2026)

Agent transport has consolidated around two Linux Foundation protocols with
different scopes. **A2A v1.0.0** shipped 2026-03-12 and was patched to
**v1.0.1** on 2026-05-28; it defines JSON-RPC, gRPC and HTTP+JSON bindings, a
Task state machine, SSE streaming, webhook push notifications, JWS-signed
Agent Cards (§8.4) and an extension mechanism. The official JS SDK
`@a2a-js/sdk` 1.1.0 implements all three bindings. IBM's ACP merged into A2A
on 2025-08-29. **MCP 2026-07-28** went the other way: it is now stateless and
strictly client-to-server ("servers do not initiate JSON-RPC requests"), the
GET SSE stream, `Mcp-Session-Id` and `Last-Event-ID` resumability were removed,
server-initiated interactions became Multi Round-Trip Requests, and async work
moved to the `io.modelcontextprotocol/tasks` extension (SEP-2663, Final). The
2026 MCP roadmap adds no new transports and treats "agent communication" as
iterating Tasks. Cisco's AGNTCY SLIM is an IETF draft (draft-01, 2026-02-24)
with 0.x crates. NATS Server 2.14 (2026-04-30), Redis 8.10 (`XNACK`, `CLAIM`)
and Kafka 4.3 share groups (KIP-932) are the broker options. OpenSSH 10.3
(2026-04-02) improved multiplexing introspection. RFC 9421 HTTP Message
Signatures is being adopted for agent identification; MCP's DPoP (SEP-1932)
and Workload Identity Federation (SEP-1933) proposals are still open.

### Options

**1A. KXM-native signed envelope over HTTPS, pull-first outbox/inbox.**
Add `GET /v1/peer/outbox?cursor=` and `POST /v1/peer/inbox`. Each envelope is a
detached JWS (Ed25519, `kid`, `iat`, `exp`, `jti`) over a canonical JSON body
that carries the existing idempotency key, `messageId`, run id and a
schema-allowlisted, pre-redacted payload. Either side can be the puller, so a
laptop behind NAT pulls from a team server that never dials in; a push is only
a "you have mail" hint. This is the accepted sync-safe outbox contract made
cross-host.
Pros: no new protocol or broker, no second source of truth, replay is trivial
(`jti` plus idempotency key), works unchanged over SSH tunnels or Tailscale.
Cons: latency bounded by the poll interval without a hint channel; KXM owns the
envelope format; no third-party interop by itself.
Ops low. Security: pinned keys, replay window, TLS or overlay. Maturity: the
pattern is decades old; `jose` and Node `crypto` are mature.

**1B. Hub as a remote MCP server (Streamable HTTP) for agent-to-hub calls.**
Serve the existing tool set (`kxm_send`, `kxm_await`, `kxm_reply`,
`kxm_fanout`, `kxm_inbox`, `kxm_workflow_*`) at `https://<hub>/mcp`. Map
`kxm_await`, awaited `kxm_fanout` and `kxm_workflow_wait` to the Tasks
extension (`resultType: "task"`, `tasks/get`, `pollIntervalMs`); the SQLite
journal is the durable task store the extension requires. Identity moves from
static project tokens to OAuth 2.1 with RFC 9728 protected-resource metadata,
RFC 8707 audience binding, and the OAuth Client Credentials extension (RFC 7523
JWT bearer assertions, one client per agent instance). The stdio plugin becomes
a thin shim that forwards to the remote hub when `KXM_HUB_URL` is set; the
Claude Code channel stays local stdio.
Pros: every host reaches the same hub with the same tool names; Claude Code,
Pi (via `@mariozechner/pi-mcp`), Claude web and ChatGPT can all connect.
Cons: KXM must implement or front an authorization server; the hub moves from
loopback to a real origin with TLS; the 2026-07-28 stateless mode is only
worth adopting once the SDK v2 client is default in the harnesses.
Ops medium. Security: the strongest available for agent-to-hub. Maturity: spec
stable; KXM implementation new.

**1C. A2A as the interop dialect.**
Publish an Agent Card per coordinator identity at
`/.well-known/agent-card.json` and map `send` to `SendMessage`, `await` to
`GetTask`/`SubscribeToTask`, `reply` to task completion with artifacts,
`fanout` to N sends sharing a `contextId`, and gates to `INPUT_REQUIRED`.
Pros: the only protocol with a signed-card discovery story and cloud-platform
adoption (Bedrock AgentCore, Azure AI Foundry, Google); an extension slot for
KXM provenance and quorum semantics.
Cons: A2A is request/response around Tasks, not a durable inbox; no replay
protection beyond `messageId`; push notifications need a reachable webhook;
KXM's peer primitives already exceed its task model, so for intra-KXM traffic
it adds a second protocol without new capability.
Ops moderate. Maturity: v1.0.1.

**1D. Message broker as the agent bus (NATS JetStream first).**
One NATS server per team; per-agent inbox streams with durable consumers,
work-queue streams for anycast, KV presence with TTL. The Cotal write-up
(NATS blog, 2026-08-01) shows exactly this shape.
Pros: push delivery, offline buffering, late-join replay, "exactly one claims"
work queues, KV leases, outbound-only client connections (no NAT problem).
Cons: a second always-on durability system and a second identity system
(NKeys/JWT) that must be reconciled with the SQLite journal.
Ops medium. Maturity: NATS 2.14 stable.

**1E. SSH-multiplexed RPC (the existing draft plan).**
ControlMaster with pinned host keys carrying stdio JSON-RPC and event cursors.
Pros: no new listeners, SSH keys are already the team trust root, workspace
transfer rides the same channel. Cons: strictly initiator-driven; a Runtime
cannot originate a message without the tunnel up. Keep as a reachability
substrate, not a peer protocol.

SLIM, raw gRPC bidi and WebSockets are later substrate choices: SLIM is
pre-1.0 and Rust-centric; raw streams give push but no durability, no NAT
answer and no spec.

### Comparison

| Criterion | 1A signed envelope | 1B remote MCP hub | 1C A2A | 1D NATS | 1E SSH RPC |
|---|---|---|---|---|---|
| Role | Runtime-to-hub durable sync | Agent-to-hub tool calls | External interop | Bus | Reachability |
| Push vs pull | Pull plus hint | Client-initiated; Tasks polled | Push plus SSE/webhook | Push | Initiator push |
| NAT/firewall | Either side pulls | Client dials hub | Callee needs URL | Clients dial out | SSH port only |
| At-least-once | Outbox, cursor, idempotency key | Per call; Tasks durable | `messageId` "MAY" dedupe | Ack/redeliver | Event cursors |
| Identity | Pinned Ed25519, JWS | OAuth 2.1, RFC 7523 client credentials | OAuth2, API key, mTLS, signed cards | NKey/JWT | SSH keys |
| Replay protection | `jti`, `iat`/`exp` | Token audience, `jti` | Not specified | Sequence numbers | Session |
| Interop | None | High (any MCP host) | High (150+ orgs) | None | None |
| Ops cost | Low | Medium | Moderate | Medium | Low |
| Maturity | Pattern mature, code new | Spec stable | v1.0.1 | 2.14 | OpenSSH 10.3 |

### Recommendation

Layer them rather than pick one. **1A** is the durable core between Runtimes
and the hub. **1B** is how an agent on any host calls the hub. **1E** or a
Tailscale overlay is the network substrate where no public origin exists.
**1C** is an edge projection: document the mapping now, implement only when an
external platform must call in. **Defer 1D** until fan-in latency or volume
outgrows polling; it buys push latency at the price of a second durability and
identity system.

The two research passes disagreed on A2A timing (one proposed an Agent Card
per coordinator in the first slice, the other none until needed). The
reconciliation above follows the vNext rule that the journal is the single
source of truth: A2A becomes a projection of it, never its transport.

**First slice:** an `outbox` table with monotonic `seq` and a `peer_links`
table (peer id, pinned public key, base URL, direction, cursor); the two peer
endpoints with `kid` lookup, `jti` uniqueness within 24 h, `iat` skew of at
most 5 min and schema allowlisting before insert through the existing
idempotency path; a jittered poll loop with an optional SSE hint; the existing
tool set over Streamable HTTP on the legacy MCP revision behind a bearer
project token, with RFC 9728 metadata and audience checks; the stdio plugin
forwarding when `KXM_HUB_URL` is set. **Defer:** 2026-07-28 stateless mode,
enterprise-managed auth, A2A push notifications, gRPC, SLIM, brokers,
mTLS/SPIFFE, RFC 9421 (JWS on the body first).

### Sources

1. A2A Protocol Specification v1.0.x, <https://a2a-protocol.org/latest/specification/> (viewed 2026-09-17)
2. A2A releases (v1.0.0 2026-03-12, v1.0.1 2026-05-28), <https://github.com/a2aproject/A2A/releases>
3. Linux Foundation, "A2A Protocol Surpasses 150 Organizations", 2026-04-09, <https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year>
4. `@a2a-js/sdk` 1.1.0, <https://www.npmjs.com/package/@a2a-js/sdk>
5. LF AI & Data, "ACP Joins Forces with A2A", 2025-08-29, <https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/>
6. MCP 2026-07-28 transports, <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports> and <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
7. MCP blog, "The 2026-07-28 Specification", <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
8. SEP-2663 Tasks extension (Final), <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md> ; extension site <https://tasks.extensions.modelcontextprotocol.io/>
9. MCP blog, "The 2026 MCP Roadmap", 2026-03-09, <https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/>
10. MCP 2026-07-28 Authorization, <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> ; OAuth Client Credentials extension, <https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials>
11. IETF draft-mpsb-agntcy-slim-01, 2026-02-24, <https://datatracker.ietf.org/doc/draft-mpsb-agntcy-slim/01/> ; <https://github.com/agntcy/slim>
12. NATS Server 2.14 release, 2026-04-30, <https://nats.io/blog/nats-server-2.14-release/> ; Cotal write-up, 2026-08-01, <https://nats.io/blog/coordinating-ai-agent-teams-on-nats/>
13. Redis XREADGROUP and release notes, <https://redis.io/docs/latest/commands/xreadgroup/> ; Kafka share groups GA, <https://www.confluent.io/blog/kafka-queue-semantics-share-consumer-ga/>
14. OpenSSH 10.3 release notes, 2026-04-02, <https://www.openssh.org/txt/release-10.3>
15. Tailscale identity docs, <https://tailscale.com/docs/concepts/tailscale-identity>
16. RFC 9421 HTTP Message Signatures, <https://www.rfc-editor.org/info/rfc9421/> ; MCP SEP-1933 (open), <https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1933>
17. Claude Code MCP docs (remote servers, v2 runtime, 2026-07-28 negotiation), <https://code.claude.com/docs/en/mcp>
18. the-shit/agent-bus (experimental NATS bus), <https://github.com/the-shit/agent-bus>

## 2. Mesh and auto-discovery

### State of the art (2026)

Three working tiers and one research tier. Self-description at a well-known
URL: A2A fixes `/.well-known/agent-card.json`, recommends an authenticated
extended card, and states that the spec "does not prescribe a standard API for
curated registries". Registries: the A2A registry proposal (discussion #741)
is still open with five incompatible implementations shipping as of
2026-05-26; the MCP Registry (preview since 2025-09-08, API frozen at v0.1) is
a catalog of public servers only and tells private operators to run their own;
AGNTCY Agent Directory v1.7.0 (2026-08-18) stores OASF records with Sigstore
signing and DHT routing. Presence with leases: NATS KV with TTL, etcd v3.7
(July 2026) leases, Consul sessions. Research tier: MIT's NANDA Index (signed
AgentFacts, CRDT updates) has no verified production deployment. LAN
zero-conf via mDNS/DNS-SD is discussed but not standardized. Tailscale gives
identity-based reachability through node keys, tagged nodes and grants.

### Options

**2A. Static signed roster with pinned keys.** A `roster.json` signed by a team
root key listing each agent or coordinator id, public keys with `kid` and
validity, endpoints, declared capabilities and a revocation list, distributed
out of band with a monotonic version. Extends the existing trusted-roster
policy loader. Pros: no runtime dependency, explicit auditable trust, roster
edits are governed. Cons: no presence; staleness by design. Ops near zero.

**2B. Hub presence with heartbeat leases.** Runtimes `POST /v1/presence` with
roster identity, capabilities hash and a 60 to 90 s lease renewed by
heartbeat; the hub stores `presence(agent_id, last_seen, lease_expires,
endpoint)` in SQLite and serves it filtered by roster membership. Presence is a
hint; the roster is truth. Pros: cheap liveness and endpoint freshness. Cons:
needs hub-side monotonic time; registration must be signed.

**2C. A2A Agent Cards plus authenticated extended cards.** Each coordinator
serves a public card generated from the roster with `signatures[]` produced by
the roster key; the hub crawls and caches cards, verifying against roster keys
rather than the card's own `jwks`. Pros: standard and tool-supported. Cons:
static self-claims; needs reachable HTTPS per host; the card's trust anchor is
unspecified by the spec.

**2D. External registry or DHT (AGNTCY Directory, NANDA, libp2p Kademlia, MCP
Registry).** Cross-organization discovery with rich taxonomies. Cons: heavy
for a team; DHTs need bootstrap peers and are Sybil-exposed; the MCP Registry
covers servers, not agents. Ops medium to high.

**2E. LAN zero-conf and overlay identity.** `_kxm._tcp.local` SRV/TXT records
for same-LAN discovery; Tailscale MagicDNS names with tag-based grants so
reachability implies membership, verified via LocalAPI `whois`. Cons: mDNS is
unauthenticated and does not cross subnets; `tsnet` is Go-only so Node uses
the LocalAPI or Serve identity headers.

### Comparison

| Criterion | 2A signed roster | 2B presence leases | 2C A2A cards | 2D registry/DHT | 2E mDNS/Tailscale |
|---|---|---|---|---|---|
| Trust bootstrap | Root key, TOFU once | Inherits 2A | Card JWS bound to roster | Sigstore or weak | Tailscale IdP; mDNS none |
| Revocation | Roster bump | Lease expiry plus roster | Re-crawl | Slow | Key expiry; mDNS none |
| Staleness | High | Low | Medium | Medium to high | Low |
| Ops burden | Very low | Very low | Low | Medium to high | Low if overlay exists |
| Small trusted team | Excellent | Excellent | Good | Poor | Good complement |
| Open network | Poor | Poor | Good | Designed for it | Poor |

### Recommendation

**2A plus 2B** as truth and liveness, **2E (Tailscale tags)** as network
admission, **2C** only as the interop projection when 1C is built, **2D
deferred entirely**. Every registry still needs a trust anchor, and the roster
already is one.

**First slice:** signed `roster.json` (root key, per-agent `kid`, endpoints,
capabilities, revocations, `version`) loaded by hub and Runtime; presence
heartbeats with a 90 s lease in SQLite; presence surfaced in `kxm_state` and
the dash agents screen. **Defer:** extended-card auth, card crawling, mDNS,
registry publication.

### Sources

1. A2A "Agent Discovery", <https://a2a-protocol.org/latest/topics/agent-discovery/>
2. A2A discussion #741 (registry proposal, open), <https://github.com/a2aproject/A2A/discussions/741>
3. MCP Registry "About", <https://modelcontextprotocol.io/registry/about> ; launch post <https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/>
4. AGNTCY Agent Directory, <https://dir.agntcy.org/latest/dir/dir-overview/> ; changelog <https://agntcy.org/changelog>
5. etcd v3.7.0 announcement, <https://etcd.io/blog/2026/announcing-etcd-3.7/>
6. NANDA Index paper, arXiv 2507.14263, <https://arxiv.org/abs/2507.14263>
7. RFC 6763 DNS-SD, <https://tools.ietf.org/html/rfc6763>
8. `@libp2p/kad-dht` 16.3.1, <https://www.npmjs.com/package/@libp2p/kad-dht>
9. Tailscale identity docs, <https://tailscale.com/docs/concepts/tailscale-identity>

## 3. Coordinator patterns

### State of the art (2026)

Production consensus is orchestrator-worker with durable checkpoints, and the
newest guidance is about restraint. Anthropic's research-system write-up
(2025-06-13) has a lead agent save its plan before the context window
truncates, spawn parallel subagents and reconcile condensed results, at about
15x the tokens of a chat. Anthropic's follow-up (2026-01-23) says start with
one agent and use multi-agent only for context protection, parallelization or
specialization. Claude Code ships two relevant mechanisms: agent teams
(experimental, one machine, fixed lead, file-locked shared task list,
per-agent JSON mailboxes validated on read) and cross-session messaging
(v2.1.224+) where a message "never counts as your consent", inbound policy is
`accept`/`hold`/`refuse`, loops are throttled with per-sender rate limits and
duplicate suppression, and idle notifications are one-shot with a 12 h expiry.
Microsoft Agent Framework 1.0 (GA date 2026-04-03 is from secondary coverage)
unifies AutoGen and Semantic Kernel with checkpointed graph workflows and five
orchestrations; the Azure Architecture Center (2026-02-12) warns that "sharing
mutable state between concurrent agents" is an antipattern. OpenAI's Agents
SDK frames the choice as agents-as-tools versus handoffs. LangGraph 1.0
supervisor helpers, CrewAI hierarchical process, FIPA Contract Net and
blackboard systems remain the reference patterns. Inbox-first coordinators are
proliferating (Cotal, Cyclops, Paperclip, Herdr, ruflo, AgentMail). On
leases, Kleppmann's fencing-token argument (2016) is still the reference:
a lease alone is unsafe under pauses, so the resource must reject writes
carrying a stale monotonic token.

### Options

**3A. Single coordinator per run with a hub-issued fenced lease.**
`run_lease(run_id, holder_agent_id, generation, expires_at)`; `generation`
increments only on takeover; every shared mutable action (stage transition,
gate decision, promotion) carries it and is rejected if stale
(`UPDATE ... WHERE generation = ?`). This is the vNext "online lease with
fencing" made concrete. Pros: no consensus needed, survives zombie
coordinators. Cons: lease expiry needs a sweep and an explicit `orphaned`
state.

**3B. Persistent coordinator identities with durable inboxes.** Coordinators
are roster identities, not sessions; the hub owns their inbox with a cursor per
hosting Runtime; wake is an advisory hint (SSE, later email/SMS) plus
mandatory jittered polling. A coordinator is re-hosted by acquiring the run
lease and replaying its inbox from the cursor. This matches the operator
decision of 2026-09-14. Pros: cross-host handoff becomes lease transfer plus
cursor replay. Cons: wake latency bounded by poll interval; needs per-sender
limits.

**3C. Blackboard or event choreography over synchronized facts.** Agents react
to hub facts (journal entries, stage transitions, gate outcomes) via
subscriptions. Fits quorum gates; needs 3A underneath for any mutable action.

**3D. Contract-net across hosts.** Coordinator broadcasts a call for proposals
via `fanout`; Runtimes propose or refuse by a `reply-by` deadline; the
coordinator accepts one or a quorum. Right for heterogeneous hosts or
competing-hypothesis work; overhead otherwise.

**3E. Leader election among hubs.** Not needed while one process owns one
SQLite DB. If a second hub appears, use a lease table with a generation
column, never advisory locks or Redlock.

### Failure modes and mitigations

- Split brain: fenced lease; the loser's next write fails closed.
- Duplicate execution: idempotency keys on every command; attempts record
  `generation`; unknown outcomes stay in `blocked_uncertain` until a human or
  gate decides.
- Lost wake: hints are advisory, polling is mandatory; presence marks the
  coordinator `offline` and surfaces "unread since"; takeover after expiry is a
  governed decision at first.
- Zombie coordinator or clock skew: fencing plus hub monotonic time.
- Loops and floods: per-sender rate limit, duplicate window, bounded queue
  with backpressure (Claude Code uses 50 queued, 100 held).
- Poisoned inbox entry: validate per entry and quarantine; deliver the rest.
- Consent laundering: messages are data; only the permission system or a human
  grants approvals; a message body can never change roster, policy or leases.

### Comparison

| Criterion | 3A fenced lease | 3B durable inbox identity | 3C blackboard | 3D contract-net | 3E hub election |
|---|---|---|---|---|---|
| Ownership clarity | Explicit | Explicit via 3A | Implicit | Per task | Explicit |
| Split-brain safety | Fencing | Inherits | None alone | Coordinator-held | Consensus |
| Cross-host handoff | Lease transfer | Lease plus cursor replay | Natural | Natural | n/a |
| Coordination cost | Low | Low | Medium | Medium to high | n/a |
| KXM fit today | High (vNext) | High (decided) | Partial | High via fanout/quorum | Not needed |

### Recommendation

**3A plus 3B** as the core; **3D** only through the existing `fanout`, `await`
and quorum-gate primitives; **3C** as an event-trigger layer over synchronized
facts; **3E deferred**. Industry evidence converges on one lead, messages as
data not consent, checkpoint everything, throttle loops.

**First slice:** `run_lease` with `generation` and hub-side expiry, checked by
every mutating endpoint; inbox cursor per hosting Runtime with
`POST /v1/inbox/ack?cursor=`; a wake-hint SSE stream with 30 to 60 s jittered
fallback polling; `offline` and "unread since" in `kxm_state`; per-sender rate
limit and duplicate window on inbox insert. **Defer:** email/SMS bindings,
proposal scoring, multi-hub election, automatic lease takeover.

### Sources

1. Anthropic, "How we built our multi-agent research system", 2025-06-13, <https://www.anthropic.com/engineering/multi-agent-research-system>
2. Anthropic, "When to use multi-agent systems", 2026-01-23, <https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them>
3. Claude Code, "Orchestrate teams of Claude Code sessions", <https://code.claude.com/docs/en/agent-teams>
4. Claude Code, "Message your other Claude Code sessions", <https://code.claude.com/docs/en/cross-session-messaging>
5. Microsoft Agent Framework overview and orchestrations, <https://learn.microsoft.com/en-us/agent-framework/overview/> ; <https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/>
6. Azure Architecture Center, "AI Agent Orchestration Patterns", <https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns>
7. OpenAI Agents SDK orchestration and handoffs, <https://openai.github.io/openai-agents-python/multi_agent/>
8. LangGraph persistence and `langgraph-supervisor`, <https://docs.langchain.com/oss/python/langgraph/persistence> ; <https://reference.langchain.com/python/langgraph-supervisor>
9. CrewAI hierarchical process, <https://docs.crewai.com/en/learn/hierarchical-process>
10. FIPA Contract Net (SC00029H; fipa.org mirror unverified live), <https://www.fipa.org/specs/fipa00029/XC00029G.html>
11. awesome-agent-orchestrators, <https://github.com/andyrewlee/awesome-agent-orchestrators> ; ruflo, <https://github.com/ruvnet/ruflo> ; AgentMail, <https://www.agentmail.to/>
12. Kleppmann, "How to do distributed locking", 2016-02-08, <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>

## 4. Shared context across hosts

### State of the art (2026)

A2A 1.0 models `Task {id, contextId, status, artifacts[], history[]}` and
`Artifact {artifactId, parts[]}` with `TextPart | DataPart | FilePart`; the
spec has no trace or size guidance. MCP 2026-07-28 removed sessions and SSE
resumability, replaced `resources/subscribe` with `subscriptions/listen`, and
added `ttlMs`/`cacheScope` to list and read results, so cursors must be owned
by the application. Anthropic's context-engineering guidance names compaction,
structured note-taking and sub-agent architectures; Claude Code re-reads
`CLAUDE.md` after compaction and Pi records compaction as an explicit JSONL
entry. CRDT libraries are current and MIT (Yjs 13.6.32, Automerge 3.5.0 with
per-change author metadata, Loro 1.16.1). `AGENTS.md` joined the Agentic AI
Foundation on 2025-12-09. Letta's Context Repositories (2026-02-12) put agent
memory in a git repo with one worktree per subagent. Karpathy's llm-wiki gist
(2026-04-04) formalized `raw/`, `wiki/` and schema layers.

### Options

**4A. Handoff packets as A2A-shaped artifacts in sync events.** Define
`kxm.context-bundle.v1` with `{runId, stage, bundleHash, goal, decisions[],
openQuestions[], evidenceRefs[], producedBy{runtimeId, agent},
redactionPolicyVersion, sizeBytes}`, emitted by the Pi supervisor at stage
boundaries and on compaction, capped at 16 KB with evidence references only.
A peer loads it as a system-message block. Pros: fits the existing outbox,
summary-first by construction. Cons: lossy; quality depends on the summarizer.

**4B. Event-sourced context through the allowlisted outbox (as specified).**
Peers rebuild a projection from the run's sync-event stream. Borrow
`ttlMs`/`cacheScope` hints and explicit per-consumer cursors from MCP. Pros:
authoritative by construction, replayable. Cons: consumers must be idempotent.

**4C. CRDT documents for co-edited state.** A CRDT doc per run for checklists
and scratch notes; the home Runtime keeps the canonical doc. Cons: CRDT bytes
are opaque to the allowlist and redaction layer; breaks "who is authoritative"
unless one Runtime is canonical; adds a WASM dependency.

**4D. Content-addressed artifact store.** Blobs go to an S3-compatible store
keyed by SHA-256 (OCI 1.1 referrers via ORAS for linking); messages carry
`{digest, mediaType, size, uri}`. MinIO's community edition was archived
2026-04-25; Garage, SeaweedFS and RustFS are current self-host options.
Pros: immutable, deduplicated, verifiable. Cons: another service; presigned
URLs or a proxy per project token.

**4E. Git as the transport for context files.** `context/` in the repo,
committed by the home Runtime at stage boundaries, pulled by peers at a pinned
SHA. Pros: versioned and reviewable. Cons: not live; conflicts on shared
files; secrets can leak without a pre-commit redaction hook.

### Comparison

| Criterion | 4A handoff packets | 4B event-sourced outbox | 4C CRDT | 4D CAS store | 4E git transport |
|---|---|---|---|---|---|
| Authoritative source | Home Runtime | Home Runtime | Ambiguous | Digest | Commit SHA |
| Redaction before leaving host | Yes | Yes | Hard | Bytes never enter hub | Hook required |
| Size bound | Schema cap | Per-event cap | Grows | Off-hub | Repo growth |
| Liveness | Stage boundaries | Near real time | Real time | On upload | Minutes |
| New infra | None | None | WASM lib | Object store | None |
| Security | Strong | Strongest | Weak | Good | Good |

### Recommendation

**4B then 4A then 4D**, with **4E** as the promotion path for anything
durable. The home Runtime stays the single writer. **Defer CRDTs**: they solve
a concurrency problem KXM designed out and defeat the allowlist.

**First slice:** the one sync-event type `kxm.context-bundle.v1` with a hard
16 KB cap and a `kxm improve` bucket for rejected bundles. **Defer:** artifact
store (use repo-relative paths and git LFS until a second host needs
binaries), CRDTs, MCP `subscriptions/listen` integration.

### Sources

1. A2A specification (Task, Artifact, Part), <https://a2a-protocol.org/latest/specification/>
2. MCP 2026-07-28 changelog, <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
3. Anthropic, "Effective context engineering for AI agents", <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
4. Claude Code memory docs, <https://code.claude.com/docs/en/memory>
5. Pi session format, <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md>
6. Yjs 13.6.32, <https://registry.npmjs.org/yjs/latest> ; Automerge 3.5.0, <https://github.com/automerge/automerge/releases> ; Loro 1.16.1, <https://github.com/loro-dev/loro/releases>
7. Linux Foundation, Agentic AI Foundation formation, 2025-12-09, <https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation>
8. Letta, "Introducing Context Repositories", 2026-02-12, <https://www.letta.com/blog/context-repositories/>
9. Karpathy llm-wiki gist, 2026-04-04, <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
10. OCI Image and Distribution 1.1, <https://opencontainers.org/posts/blog/2024-03-13-image-and-distribution-1-1/>
11. MinIO community archive (secondary), <https://stormdevelopments.ca/blog/minio-s-community-edition-is-archived-what-still-runs-in-2026/>
12. Transactional outbox pattern, <https://microservices.io/patterns/data/transactional-outbox.html>

## 5. Memory

### State of the art (2026)

Four styles. Extraction layers: Mem0 OSS v3 collapsed to a single ADD-only
call, moved to hybrid retrieval and removed graph memory from OSS. Temporal
knowledge graphs: Graphiti 0.30.2 (2026-09-08) stores bi-temporal edges and
namespaces by `group_id` over Neo4j or FalkorDB. Agent-native memory: Letta's
docs now say "we do not recommend building on memory blocks anymore" and point
at git-backed MemFS; LangMem is still 0.0.x; Cognee exposes an MCP server.
Harness-owned files: Anthropic's `memory_20250818` tool is client-side under a
`/memories` prefix with an "assume interruption" protocol and explicit
traversal and size requirements; Claude Code auto memory (default since
v2.1.59) writes `MEMORY.md` plus topic files, loads 200 lines or 25 KB, is
machine-local, and is "context, not enforced configuration". Storage: pgvector
0.8.2, sqlite-vec 0.1.9 (still pre-1.0), LanceDB 0.38.0, Qdrant 1.19. OWASP's
agentic Top 10 (2025-12-09) lists ASI06 Memory and Context Poisoning; the
MPBench study reports high injection success on runtime memory.

### Options

**5A. Git-backed markdown memory with governed promotion.** A `memory/` tree
with `proposed/`, `approved/`, `quarantined/` and an `INDEX.md` capped like
`MEMORY.md`. Journal `lesson`, `hypothesis` and `skill-candidate` entries are
the proposed state; `kxm promote` writes a commit citing the journal id and
evidence refs; the run manifest pins `memoryRev` next to `repoRev`. Pros:
reproducible, reviewable, cross-host by `git fetch`, matches the reviewed-Git
activation rule. Cons: no semantic retrieval without an index; concurrent
promotion needs one promoting host or rebase-on-promote.

**5B. Per-Runtime local index (SQLite FTS5, sqlite-vec later).** A derived
hybrid index over the approved tree keyed by memory commit and embedding
model id, rebuilt on pull. Pros: zero infra, offline. Cons: sqlite-vec is
alpha; LanceDB is the fallback.

**5C. Hub-owned canonical store (Postgres plus pgvector).** One table with
scope, status, confidence, provenance and bi-temporal validity columns. Pros:
one source of truth across projects. Cons: violates Runtime-local content
unless only approved redacted text is stored; hub outage blocks recall.

**5D. External engine (Mem0, Graphiti, Cognee).** Entity extraction and
temporal invalidation out of the box. Cons: an LLM extractor in the trust
path is the ASI06 risk; fast-moving APIs; a graph DB for a single-node-first
product.

**5E. Anthropic memory tool plus context editing in-session.** Map `/memories`
to `memory/proposed/`; pair with context editing so the model saves before the
window is cleared. Claude-specific; Pi needs an equivalent skill.

### Comparison

| Criterion | 5A git markdown | 5B local index | 5C hub Postgres | 5D external engine | 5E memory tool |
|---|---|---|---|---|---|
| Scoping | Directory layout | Inherits | Column plus RLS | `group_id` | Directory |
| Pin to run | Commit SHA | SHA plus model id | Snapshot id needed | Not native | Via 5A |
| Cross-host | `git fetch` | Rebuild per host | Hub API | Shared service | Via 5A |
| Prevents memory-as-policy | Review gate, text only | Read-only cache | Status column | Weak | Needs 5A |
| New infra | None | None | Postgres | Graph or vector DB | None |
| Maturity | High | Medium | High | Medium | GA |

### Recommendation

**5A** canonical, **5B** retrieval cache, **5E** in-session capture for Claude
sessions with a Pi skill writing the same files. Enforce "memory informs,
never grants" structurally: approved memory is loaded only into prompt
context, never into permission, tool or policy resolution. Required fields per
memory file: `id, status, scope, confidence, producedBy{runId, agent,
runtimeId}, evidenceRefs[], validFrom, invalidatedAt, supersededBy,
redactionPolicyVersion`. **Defer 5C** until cross-project recall is needed and
**5D** indefinitely.

**First slice:** the `memory/` tree, `kxm promote` writing the commit,
`memoryRev` in the run manifest, FTS5-only retrieval. **Defer:** embeddings,
hub store, graph memory, per-team scope.

### Sources

1. Mem0 OSS v2 to v3 migration, <https://docs.mem0.ai/migration/oss-v2-to-v3>
2. graphiti-core 0.30.2, <https://pypi.org/project/graphiti-core/> ; namespacing <https://help.getzep.com/graphiti/core-concepts/graph-namespacing>
3. Letta shared memory (deprecation note), <https://docs.letta.com/guides/agents/multi-agent-shared-memory/>
4. LangMem launch (version from secondary), <https://www.langchain.com/blog/langmem-sdk-launch>
5. Cognee MCP server, <https://github.com/topoteretes/cognee/blob/main/cognee-mcp/README.md>
6. Claude memory tool and context editing, <https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool> ; <https://platform.claude.com/docs/en/build-with-claude/context-editing>
7. Claude Code memory docs, <https://code.claude.com/docs/en/memory>
8. pgvector, sqlite-vec, LanceDB, Qdrant releases, <https://github.com/pgvector/pgvector/releases> ; <https://github.com/asg017/sqlite-vec/releases> ; <https://github.com/lancedb/lancedb/releases> ; <https://qdrant.tech/blog/qdrant-1.19.x/>
9. OWASP Top 10 for Agentic Applications, 2025-12-09, <https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/>
10. MPBench memory poisoning study, arXiv 2606.04329, <https://arxiv.org/abs/2606.04329>

## 6. Restarts, durability and recovery

### State of the art (2026)

Durable execution comes in three shapes. Server plus workers: Temporal (1.30
and 1.31 lines; Worker Versioning and Task Queue Priority GA at Replay 2026)
treats activities as at-least-once, recommends idempotency keys, and gets
at-most-once only with `maximumAttempts=1`. Single-binary journaling: Restate
1.7.8 with TypeScript SDK 1.17.0 (2026-08-31) journals every `ctx.run` and
adds `onJournalMismatchErrors: retry|pause|fail`. Library in your database:
DBOS 4.25.x (MIT) checkpoints into Postgres; SQLite is confirmed for Go only.
Managed: Cloudflare Workflows V2 (each instance a Durable Object with SQLite),
Azure Durable Task Scheduler, Inngest 1.0 (SSPL converting to Apache 2.0),
Resonate (Apache 2.0), Golem (WASM; Cloud GA timing unverified). Agent
frameworks are weaker: LangGraph checkpointers give time travel but no
supervisor; Microsoft Agent Framework checkpoints per superstep with manual
restore, which Diagrid's 2026-03-02 critique calls conflating state
persistence with reliability. Cross-host session resume became first-class in
the Claude Agent SDK: a `SessionStore{append, load, ...}` adapter mirrors JSONL
entries to S3, Redis or Postgres with best-effort semantics and dedupe by
`entry.uuid`. Pi stores a v3 JSONL tree with `parentSession`; Codex resumes by
rollout id (secondary). Kleppmann's fencing tokens and Stripe's idempotency
contract (24 h retention, request fingerprint compared) remain the reference
designs. NATS 2.11 per-key TTL and etcd 3.6 leases supply liveness primitives.

### Options

**6A. Keep KXM's event-sourced Runtime; add leases, fencing and a resume
protocol.** A hub `leases` table `{resource, holderRuntimeId, fencingToken,
expiresAt}` acquired by compare-and-swap; every shared action carries the token
and targets reject stale ones. On restart the supervisor replays the journal
to the last committed attempt, reissues the outbox from its cursor, and parks
any attempt with an unknown side effect in `blocked_uncertain` with its
idempotency key. Pros: no new dependency; matches every vNext contract. Cons:
KXM owns correctness (heartbeat timeouts, token plumbing).

**6B. Embed Restate per host.** Workflow runs as Restate Workflows, side
effects as `ctx.run` with idempotency keys, cross-host waits as awakeables,
`onJournalMismatchErrors: "pause"`. Pros: journaling, retries, timers and
pause-on-mismatch for free; TypeScript-native; single binary. Cons: replaces
the KXM journal or creates two sources of truth; RocksDB state per host.

**6C. Embed DBOS as a library.** Least architectural change, but the
TypeScript SDK needs Postgres, which breaks "one process owns one SQLite DB".

**6D. Temporal as the cross-host coordinator.** Heartbeats, timeouts, worker
versioning and visibility all solved, at the cost of a cluster plus database
and a rearchitecture into workflow/activity shapes; `blocked_uncertain` still
has to exist because non-idempotent activities remain the app's problem.

**6E. Session-level resume via mirrored transcripts.** A `SessionStore`
adapter for Claude sessions and a Pi equivalent syncing JSONL by `id/parentId`,
keyed by `{project, agent, workflowRunId}` so history never crosses runs.
Transcripts are the most sensitive data KXM would hold off-host: encrypt,
scope per project token, never through the hub outbox.

### Comparison

| Criterion | 6A own journal plus leases | 6B Restate | 6C DBOS | 6D Temporal | 6E transcript mirror |
|---|---|---|---|---|---|
| One process, one SQLite | Yes | No | Postgres needed | No | Yes plus store |
| Uncertain side effects | `blocked_uncertain` | Pause on mismatch | Step checkpoint | At-most-once activity | n/a |
| Fencing and leases | KXM builds | Virtual object keys | Postgres locks | Server-owned | n/a |
| Dead-host detection | KXM builds | Built in | Built in | Built in | n/a |
| Ops cost | Low | Moderate | Moderate | High | Low to moderate |
| Maturity | KXM's | Production | High | Highest | New |

### Recommendation

**6A now, 6E for the conversation layer, re-evaluate 6B after two hosts are
live.** Every engine surveyed still leaves the non-idempotent decision to the
application, so adopting one moves the journal without removing the problem.
Copy Restate's `pause` semantics verbatim into `blocked_uncertain`: park and
surface, never auto-retry.

**First slice:** the `leases` table with CAS acquire, TTL and monotonic
`fencingToken`; `{leaseId, fencingToken}` on every `kxm.sync-event.v1` and
shared action; a Runtime heartbeat row every 15 s with 45 s expiry that marks
the Runtime's runs `orphaned` (never auto-migrated, since a run has one
immutable home); a `SessionStore`-style mirror for Claude sessions. **Defer:**
Restate or Temporal, automatic run migration, Pi session sync, tmux/mosh
reattach tooling (human reattach, not run recovery).

### Sources

1. Temporal activity execution and definition; Replay 2026 announcements, <https://docs.temporal.io/activity-execution> ; <https://temporal.io/blog/replay-2026-product-announcements>
2. Restate TypeScript SDK changelog (1.17.0) and server 1.7.8 notes, <https://docs.restate.dev/changelog/typescript-sdk> ; <https://github.com/restatedev/restate/blob/main/release-notes/v1.7.8.md>
3. DBOS June 2026 update and `@dbos-inc/dbos-sdk`, <https://www.dbos.dev/blog/new-in-dbos-june-2026> ; <https://www.npmjs.com/package/@dbos-inc/dbos-sdk>
4. Cloudflare Workflows GA and V2 coverage, <https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/> ; <https://www.infoq.com/news/2026/05/cloudflare-dynamic-workflows/>
5. Diagrid, "Still not durable", 2026-03-02, <https://www.diagrid.io/blog/still-not-durable-how-microsoft-agent-framework-and-strands-agents-repeat-the-same-mistake> ; MS Agent Framework checkpoints, <https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints>
6. OpenAI Agents SDK sessions, <https://openai.github.io/openai-agents-python/sessions/>
7. Claude Agent SDK session storage and sessions, <https://code.claude.com/docs/en/agent-sdk/session-storage> ; <https://code.claude.com/docs/en/agent-sdk/sessions>
8. Codex CLI session persistence (secondary), <https://codex.danielvaughan.com/2026/04/13/codex-cli-session-persistence-resume-fork-analytics/>
9. Stripe idempotent requests, <https://docs.stripe.com/api/idempotent_requests>
10. NATS KV TTL and etcd v3.6 API, <https://docs.nats.io/learn/key-value/ttl-and-limits> ; <https://etcd.io/docs/v3.6/learning/api/>
11. Inngest 1.0 self-hosting, <https://www.inngest.com/blog/inngest-1-0-announcing-self-hosting-support> ; Resonate, <https://github.com/resonatehq/resonate>

## 7. Telemetry

### State of the art (2026)

OpenTelemetry's GenAI semantic conventions are still entirely Development
status; as of semantic-conventions v1.42.0 (2026-06-12) every `gen_ai.*`
attribute, span, metric and event moved to a dedicated
`semantic-conventions-genai` repository with no versioned release yet. The
breaking history matters: v1.27.0 renamed token attributes, v1.37.0 renamed
`gen_ai.system` to `gen_ai.provider.name` and replaced per-message events with
`gen_ai.input.messages`/`gen_ai.output.messages`. Current agent spans are
`create_agent`, `invoke_agent`, `execute_tool`, `chat`, `embeddings`,
`retrieval` and `plan`, with content opt-in only. MCP conventions exist
(`mcp.method.name`, `mcp.session.id`) and SEP-414 (Final, adopted in
2026-07-28) carries `traceparent`, `tracestate` and `baggage` in
`params._meta`. A2A 1.0 does not define trace propagation; the Python SDK's
`telemetry` extra implements it by convention. Claude Code is itself an OTel
source: `CLAUDE_CODE_ENABLE_TELEMETRY=1` emits cost and token metrics, events
with prompt and tool content redacted by default, beta spans, `TRACEPARENT`
inheritance by bash subprocesses and a `traceparent` header on HTTP MCP
requests. Products: Langfuse v4 (2026-08-17; MIT core, ClickHouse 25.12 or
newer), Arize Phoenix (Elastic License 2.0, single container), OpenLLMetry
(Apache 2.0), Logfire (self-host is Enterprise), MLflow 3.3+, W&B Weave,
Braintrust, LangSmith (self-host needs enterprise license), Honeycomb agent
observability (May 2026). LiteLLM's price map is the de facto open cost table.

### Options

**7A. Local-first JSONL, OTel-shaped, optional OTLP exporter.** Keep
`telemetry.jsonl` as the durable record; make each line an OTel-compatible
span or event with `gen_ai.*` fields and a pinned `kxm.semconv.version`; add a
cursor-based `kxm telemetry export --otlp`. Pros: no dependency by default;
survives hub and Collector outages; `kxm improve` keeps reading the same file.
Cons: KXM maintains the mapping as semconv moves.

**7B. Native OTel SDK plus a Collector per host.** Real distributed traces with
zero custom code, at the cost of a Collector per host and exposure to
attribute renames.

**7C. Trace-context propagation as a KXM contract.** `traceparent`,
`tracestate` and bounded `baggage` (`runId`, `projectId`, `stage` only) in
every sync-event envelope, every peer message `metadata`, MCP `params._meta`
per SEP-414, and the `TRACEPARENT` env when spawning Pi or Claude Code;
`gen_ai.conversation.id = workflowRunId` so separate root traces on different
hosts still correlate.

**7D. Self-hosted sink.** Phoenix first (single container), Langfuse v4 later
(Postgres, ClickHouse, Redis, S3). Both store whatever they receive, so the
redaction boundary must be upstream.

**7E. Keep the improvement journal separate from ops telemetry.** Journal
entries carry `traceId`/`spanId` references; spans carry `journalEntryId`;
neither copies the other's payload. Already KXM's design and Anthropic's
production practice.

### Comparison

| Criterion | 7A JSONL plus OTLP | 7B native SDK | 7C trace contract | 7D sink | 7E journal split |
|---|---|---|---|---|---|
| Works offline | Yes | Buffered only | n/a | No | Yes |
| Cross-host correlation | With 7C | Yes | Enables | Displays | Via ids |
| Redaction boundary | KXM write plus Collector | Collector | n/a | Upstream required | Structural |
| Semconv drift exposure | Pinned internal schema | High | Low | Medium | Low |
| New infra | None | Collector per host | None | One container or four services | None |

### Recommendation

**7A plus 7C plus 7E now; 7D with Phoenix as the first team sink; 7B later.**
Record `{provider, model, input_tokens, output_tokens, cache_read_tokens,
cache_creation_tokens, priceMapVersion}` per call and compute cost at export
from a pinned copy of the LiteLLM price map so historical spend is
reproducible. Apply the sync allowlist to spans: never set
`gen_ai.input.messages`; hash tool arguments rather than copying them.

**First slice:** `traceId`, `spanId`, `parentSpanId` and
`gen_ai.conversation.id` on every `telemetry.jsonl` line and sync event;
`TRACEPARENT` set when spawning Pi and Claude Code with Claude Code telemetry
pointed at a local Collector; the cursor-based exporter; Phoenix in
docker-compose. **Defer:** native SDK instrumentation, Langfuse v4, metrics
beyond token and cost counters.

### Sources

1. OpenTelemetry blog, GenAI observability (2026), <https://opentelemetry.io/blog/2026/genai-observability/>
2. Status of GenAI semconv (July 2026; secondary), <https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/>
3. semantic-conventions-genai agent spans and MCP conventions, <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md> ; <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md>
4. MCP SEP-414 trace context in `_meta`, <https://modelcontextprotocol.io/seps/414-request-meta>
5. a2a-python telemetry extra, <https://github.com/a2aproject/a2a-python>
6. Claude Code monitoring docs, <https://code.claude.com/docs/en/monitoring-usage>
7. Langfuse v4 changelog, compatibility and self-hosting, <https://langfuse.com/changelog/2026-08-17-langfuse-v4> ; <https://langfuse.com/self-hosting>
8. Arize Phoenix license, <https://arize.com/docs/phoenix/self-hosting/license>
9. OpenLLMetry license, <https://github.com/traceloop/openllmetry/blob/main/LICENSE> ; Logfire self-hosted, <https://pydantic.dev/docs/logfire/deploy/self-hosted-deployment/overview/>
10. MLflow tracing, <https://mlflow.org/docs/latest/genai/tracing/search-traces/> ; Weave deployment, <https://docs.wandb.ai/weave/guides/platform> ; Braintrust self-hosting, <https://www.braintrust.dev/docs/guides/self-hosting> ; LangSmith self-hosted, <https://docs.langchain.com/langsmith/self-hosted>
11. Honeycomb agent observability, <https://www.honeycomb.io/blog/honeycomb-launches-agent-observability-full-visibility-agentic-workflows>
12. LiteLLM cost map, <https://docs.litellm.ai/docs/proxy/custom_model_cost_map>
13. OpenTelemetry, handling sensitive data, <https://opentelemetry.io/docs/security/handling-sensitive-data/>

## 8. Workflows, handoffs and gates

### State of the art (2026)

Cross-agent handoff has converged on a task state machine plus a pause and
resume primitive. A2A v1.0 defines nine `TaskState` values (`SUBMITTED`,
`WORKING`, `INPUT_REQUIRED`, `AUTH_REQUIRED`, `COMPLETED`, `FAILED`,
`CANCELED`, `REJECTED`, `UNSPECIFIED`); a paused task resumes when a new
`Message` carries the same `taskId` and `contextId`; `referenceTaskIds` link
related work. LangGraph 1.0 uses `interrupt()` plus `Command(resume=...)` and
re-executes the interrupted node from its start. Temporal separates
fire-and-forget Signals from Updates that record `Accepted` and `Completed`
stages with validators that reject before anything hits history; child
workflows can run on another worker pool and outlive the parent with
`ABANDON`. Microsoft Agent Framework 1.0 persists pending human requests inside
the checkpoint. OpenAI Agents SDK handoffs are tools with input filters;
guardrails raise tripwires. Claude Code gates through hooks (`PreToolUse`,
`PermissionRequest`, `TaskCompleted`, `Stop`; exit code 2 blocks; `type: http`
hooks call a URL) and dynamic workflows. In CI, GitHub rulesets give required
reviews and status checks but environments only require one of up to six
reviewers; true m-of-n lives in Windmill approval steps and Vault control
groups. "Gate as signed receipt" is now a real pattern: in-toto attestation
v1.2 Statements in DSSE envelopes, with a September 2026 design whose subject
is a commit or tree digest, never a path, verified elsewhere with only the
public key. actionlint shows what static validation of a declarative workflow
buys.

### Options

**8A. A2A task vocabulary on KXM peer messages.** Adopt `Task`, `TaskState`,
`contextId` and `referenceTaskIds` as names; `assignmentId` maps to `Task.id`;
`input-required` maps to `kxm_workflow_wait`. No wire bindings. Cheap and
interoperable, but A2A says nothing about leases, fencing or evidence.

**8B. Temporal-style two-phase transitions.** Every stage transition is either
a Signal (durable, async, no reply) or an Update (validated, `accepted` then
`completed`, deduplicated by id). A stage on another host is a child with
`ABANDON` semantics. The deterministic `validate` gate runs before the journal
accepts the transition. Copy the semantics only; do not deploy Temporal.

**8C. Gates as signed receipts (in-toto Statement v1 over DSSE).** Every gate
emits `kxm.receipt.v1`: `subject = [{name: "git:<repo>", digest:
{gitCommit|gitTree}}, {name: "kxm:attempt", digest: {sha256}}]`,
`predicateType: https://kontextmind.dev/kxm/gate/v1`, `predicate: {gate,
verdict, inputsDigest, toolVersions, hostId, ts}`, signed by the executing
host's Ed25519 key (`ssh-keygen -Y sign` compatible). Quorum and provenance
gates count unique verified signer key ids; the coordinator verifies
signatures and digests with public keys only and never trusts worker prose.
Evidence blobs stay on the worker host, content-addressed, fetched by digest.
Pros: exactly answers "how does the coordinator verify without trusting the
worker"; separation of duties becomes assignee key differs from critic keys.
Cons: key distribution per host; non-reproducible gates only prove "this host
said so".

**8D. Declarative stage graph plus code-first stage bodies.** The graph
(stages, dependencies, gates, required critic count, allowed hosts) is a
static JSON or YAML manifest validated by JSON Schema and a KXM linter
(gate names exist, quorum at most eligible producers, no cycles). Bodies stay
code. `kxm workflow lint` runs in CI.

**8E. Human m-of-n approval with separation of duties.** An approval stage
suspends until N distinct approvers from a factor list sign; the trigger
identity cannot approve; per-approver single-use resume URLs bound to
`attemptId`. Composes with 8C. Defer the UI.

### Comparison

| Criterion | 8A A2A vocabulary | 8B two-phase semantics | 8C signed receipts | 8D hybrid DSL | 8E m-of-n approvals |
|---|---|---|---|---|---|
| Solves cross-host trust | No | Partly | Yes | No | Partly |
| Static validation | Weak | n/a | Verify-time | Strong | n/a |
| Fits "hub optional" | Yes | Yes (semantics) | Yes | Yes | Yes |
| Effort | Low | Low | Medium | Low to medium | Medium |
| Security | Neutral | Good | Best | Good | Good |

### Recommendation

**8C plus 8B semantics plus 8D**, borrow 8A's vocabulary, defer 8E. The single
most valuable move is making every gate outcome a signed, content-addressed
receipt: it converts "quorum of unique producers" into "quorum of distinct
verified signers", lets a cloud sandbox run a stage without the hub trusting
its prose, and makes `artifacts-exist` meaningful across hosts.

**First slice:** define `kxm.receipt.v1` as an in-toto Statement; per-host
Ed25519 keypair registered with the hub through a project token; `validate`
and `artifacts-exist` emit receipts; the quorum gate counts unique signer key
ids; `kxm workflow lint`. **Defer:** A2A wire bindings, Temporal or Nexus,
m-of-n UI, reproducible-gate tool pins.

### Sources

1. A2A specification and 2026 blog archive, <https://a2a-protocol.org/latest/specification/> ; <https://a2a-protocol.org/latest/blog/archive/2026/>
2. LangGraph interrupts, <https://docs.langchain.com/oss/python/langgraph/interrupts>
3. Temporal message passing, child workflows, Nexus, <https://docs.temporal.io/develop/typescript/workflows/message-passing> ; <https://docs.temporal.io/child-workflows> ; <https://temporal.io/blog/temporal-nexus-now-available>
4. Microsoft Agent Framework human-in-the-loop, <https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop>
5. OpenAI Agents SDK handoffs and guardrails, <https://openai.github.io/openai-agents-python/handoffs/> ; <https://openai.github.io/openai-agents-python/guardrails/>
6. CrewAI Flows, <https://docs.crewai.com/en/concepts/flows>
7. Claude Code hooks and dynamic workflows, <https://code.claude.com/docs/en/hooks> ; <https://code.claude.com/docs/en/workflows>
8. GitHub rulesets and environments, <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets> ; <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>
9. Windmill approval steps, <https://www.windmill.dev/docs/flows/flow_approval> ; Vault control groups, <https://developer.hashicorp.com/vault/docs/enterprise/control-groups>
10. Argo suspend, Prefect interactive, n8n Wait, Inngest waitForEvent, <https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/> ; <https://docs.prefect.io/v3/advanced/interactive> ; <https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait> ; <https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event>
11. in-toto attestation v1.2, <https://github.com/in-toto/attestation/blob/main/spec/README.md>
12. brigade issue #1404, public-key receipt signing (2026-09-02), <https://github.com/escoffier-labs/brigade/issues/1404>
13. "A Deterministic Control Plane for LLM Coding Agents", arXiv 2606.26924, <https://arxiv.org/abs/2606.26924>
14. actionlint, <https://github.com/rhysd/actionlint>

## 9. Tasks and goals

### State of the art (2026)

Agent-native trackers moved from markdown to graph stores with leases. Beads
v1.3.0 (2026-09-15) is Dolt-only, uses hash ids and typed dependencies,
`bd ready`, atomic `--claim`, and new work leases (`lease_expires_at` with a
5 min default, `bd heartbeat`, `bd reclaim`, `granted_node` so reclaim skips
other replicas). Linear, GitHub and Atlassian expose official remote MCP
servers. Claude Code's task list stores under `~/.claude/tasks/{team}/`, claims
with file locking, unblocks dependencies automatically, and lets
`TaskCreated`/`TaskCompleted` hooks veto. Cursor, Devin and Jules expose
follow-up and message queues over REST. For cross-host claiming, Postgres
`FOR UPDATE SKIP LOCKED` underlies pg-boss, graphile-worker and River; NATS
JetStream gives server-side leases (`AckWait`, `InProgress`, `Nats-Msg-Id`
dedupe); BullMQ's client-side lock renewal can double-process on an event-loop
stall. Kleppmann's fencing argument still applies.

### Options

**9A. Hub as the single claim authority (SQLite, HTTP API) with leases and
fencing.** An `attempts` table `{assignment_id, attempt_id, worker_id,
host_id, lease_expires_at, heartbeat_at, fence, granted_node}` and endpoints
`ready`, `claim`, `heartbeat`, `complete`, `reclaim`. Every side-effecting call
carries `(attemptId, fence)`; `complete` requires a receipt digest. Pros: no
new infrastructure; SQLite single-writer makes atomicity trivial. Cons: hub is
the claim SPOF (Runtimes keep executing and journal locally).

**9B. Postgres queue (pg-boss or graphile-worker).** Proven multi-writer
semantics and transactional enqueue, but no fencing token natively and a new
dependency unless Postgres is the hub. Design 9A's schema so it ports here
unchanged.

**9C. NATS JetStream work queue.** Good for sandboxes behind NAT, but a queue
is not a tracker: readiness and dependency graphs need a separate store.

**9D. Git-tracked tracker (Beads or Dolt) as authoritative.** Offline and
reviewable in PRs, but leases in a git-synced store are safe only within one
replica, and Dolt is a Go binary dependency.

**9E. External tracker (GitHub, Linear, Jira via MCP) as authoritative.**
Humans already live there, but no leases, rate limits, and MCP servers are
tools, not event sources.

### Comparison

| Criterion | 9A hub SQLite | 9B Postgres queue | 9C JetStream | 9D Beads/Dolt | 9E external |
|---|---|---|---|---|---|
| Atomic claim across hosts | Yes | Yes | Yes | Per replica | No |
| Fencing token | Add (easy) | Add (easy) | Not native | Not native | No |
| Readiness and dependency queries | Yes | Yes | No | Yes | Partial |
| Works offline | Journal locally, sync later | No | No | Yes | No |
| New infra | None | Postgres | NATS | Dolt | None |
| Fits vNext | Best | Good if hub is Postgres | Partial | Partial | Poor |

### Recommendation

**9A now, designed to port to 9B unchanged.** Authority rule: the hub journal
is authoritative for claims, leases, attempts and receipts; git-tracked
artifacts are authoritative for intent and decision history; external
trackers are outbound projections written through MCP with an
`external_ref`, never read back as truth. Model the hierarchy explicitly:
goal (long-lived, `contextId`-like, in a plan doc), task (tracker item with
`blockedBy`), assignment (closed manifest), attempt (`attemptId` plus
`fence`). "Ready" means no open blockers, no live lease, and the manifest hash
matches the plan digest.

Claim protocol: `claim(assignmentId, workerId, hostId, idemKey)` returns
`{attemptId, fence, leaseExpiresAt}`; `heartbeat(attemptId, fence)` extends;
`complete(attemptId, fence, receiptDigest)`; `reclaim` moves expired attempts
to ready and increments the fence so a late `complete` is rejected. Lease TTL
5 min, heartbeat 60 s.

**First slice:** the `attempts` table, `kxm task ready`, `claim`, `heartbeat`, `complete`, `reclaim`,
and a fence check in `kxm_reply`. **Defer:** Postgres, NATS, Beads, Linear or
Jira write-through.

### Sources

1. Beads README and v1.3.0 release (2026-09-15), <https://github.com/steveyegge/beads/blob/main/README.md> ; <https://github.com/steveyegge/beads/releases/tag/v1.3.0>
2. Linear MCP, GitHub MCP, Atlassian Rovo MCP, <https://linear.app/docs/mcp> ; <https://github.com/github/github-mcp-server> ; <https://github.com/atlassian/atlassian-mcp-server>
3. Claude Code agent teams and todo tracking, <https://code.claude.com/docs/en/agent-teams> ; <https://code.claude.com/docs/en/agent-sdk/todo-tracking>
4. Cursor Cloud Agents API, Devin v3 messages, Jules API, <https://cursor.com/docs/cloud-agent/api/endpoints> ; <https://docs.devin.ai/api-reference/v3/sessions/post-enterprise-sessions-messages> ; <https://jules.google/docs/api/reference/>
5. PostgreSQL SELECT locking clause, <https://www.postgresql.org/docs/current/sql-select.html>
6. pg-boss, River, <https://github.com/timgit/pg-boss> ; <https://github.com/riverqueue/river>
7. NATS JetStream acknowledgment and streams, <https://docs.nats.io/learn/jetstream/acknowledgment> ; <https://docs.nats.io/nats-concepts/jetstream/streams>
8. BullMQ important notes, <https://docs.bullmq.io/bull/important-notes>
9. Kleppmann, distributed locking, <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>

## 10. Plans

### State of the art (2026)

Every major coding agent has a plan artifact with an approval gate, but few
version it. Claude Code plan mode saves to `plansDirectory`, is editable before
approval, and Anthropic's cloud docs say to plan locally, commit the plan
file, then execute it in the cloud, which makes git the cross-host transport.
Cursor plan mode saves a markdown plan with "save to workspace". Jules
requires plan approval when `requirePlanApproval` is set. Spec-driven layouts
formalized: Kiro `.kiro/specs/<feature>/{requirements,design,tasks}.md` with
EARS criteria; GitHub spec-kit's constitution/specify/plan/tasks/implement
flow under `.specify/`; OpenSpec's `specs/` plus `changes/<name>/` with
ADDED/MODIFIED/REMOVED requirement deltas and SHALL statements; Tessl's
spec-as-source. Fowler's October 2025 review notes these gate phases with
checklists, not enforcement. Planning algorithms (plan-and-execute, ReWOO,
LLMCompiler DAGs, LLM plus HTN hybrids) remain research inputs. Drift
detection is mostly manual. For concurrent editing, HTTP optimistic
concurrency (`If-Match` and 412) is the lightweight alternative to CRDTs.

### Options

**10A. Git-authoritative plans plus a hub read model keyed by content digest.**
The hub indexes each plan as `(id, path, gitCommit, sha256(body), revision)`;
writes through the hub require `If-Match: <sha256>` and return 412 on
conflict; cloud sandboxes get plans by clone. Pros: no new storage; git is
the audit trail. Cons: no live co-editing.

**10B. Structured schema plus linter.** Extend `kxm.doc.v1` with `revision`
(digest), `requirements[{id, text (SHALL), scenarios}]` and
`tasks[{id, requires[], status}]`; `kxm plan lint` validates against JSON
Schema, checks referential integrity and forbids status transitions outside
draft, reviewed, accepted, superseded. Critics sign the digest.

**10C. OpenSpec-style change deltas as the layout.** Explicit drift model, but
heavier than KXM's single-file plans and third-party tooling moves fast.
Borrow only a `supersedes: <planId>@<digest>` field.

**10D. Plan-to-task decomposition with digest binding and drift flags.** When
a plan reaches accepted, `kxm plan decompose` creates tasks carrying
`plan: <id>@<sha256>`; a later edit bumps the digest and marks dependent tasks
`stale` and open attempts `input-required`; receipts must cite the digest; a
deterministic `drift` gate compares touched files against declared
`scope.paths`; any LLM drift critic is advisory only.

**10E. Hub-authoritative CRDT documents.** Real concurrent editing, but it
inverts git-first authority and reviewers lose PR diffs. Defer.

### Comparison

| Criterion | 10A git plus digest | 10B schema plus lint | 10C OpenSpec deltas | 10D digest-bound tasks | 10E CRDT |
|---|---|---|---|---|---|
| Cross-host sharing | Clone and push | n/a | Git | Hub plus git | Live sync |
| Concurrent-edit safety | If-Match / 412 | n/a | Git merge | n/a | CRDT merge |
| Static validation | No | Yes | Partial | Deterministic part | No |
| Drift detection | No | Enables | Structural | Yes | No |
| Fits `kxm.doc.v1` | Yes | Extends | Replaces | Yes | Replaces |

### Recommendation

**10A plus 10B plus 10D**; borrow OpenSpec's delta idea as a frontmatter
field; defer 10E. The missing pieces today are a stable revision identifier
that survives hosts (a content digest, not mtime), a linter so critics review
semantics rather than syntax, and a mechanical link from plan digest to tasks
and attempts.

**First slice:** `revision` = sha256 of body in `kxm.doc.v1`; `kxm plan lint`;
`kxm plan index` populating the hub; tasks carry `plan@digest`; `stale` on
digest change. **Defer:** OpenSpec or spec-kit adoption, semantic drift
critic, CRDT.

### Sources

1. Claude Code permission modes and cloud usage, <https://code.claude.com/docs/en/permission-modes> ; <https://code.claude.com/docs/en/claude-code-on-the-web>
2. Cursor plan mode, <https://cursor.com/docs/agent/planning>
3. Jules API, <https://jules.google/docs/api/reference/>
4. Kiro specs, <https://kiro.dev/docs/specs/>
5. GitHub spec-kit, <https://github.com/github/spec-kit> (v1.0.7 release date unverified)
6. OpenSpec, <https://github.com/Fission-AI/OpenSpec>
7. Fowler and Vettiger, "Understanding Spec-Driven-Development", 2025-10-15, <https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html>
8. LangChain plan-and-execute, LLMCompiler, <https://www.langchain.com/blog/planning-agents> ; <https://arxiv.org/abs/2312.04511>
9. LLM plus HTN planning, arXiv 2605.07707 and 2511.12901
10. RFC 9110 If-Match and 412, <https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match>
11. CRDT library comparison 2026 (secondary), <https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026>

## 11. Steering

### State of the art (2026)

Every harness offers mid-run steering and they agree on one thing: inject at
a step boundary, never mid-tool. Pi's RPC mode delivers `steer` after the
current turn's tool calls and before the next model call, `follow_up` only
when idle, `set_steering_mode` all or one-at-a-time, and `abort` waits for
idle. Codex CLI maps Enter to steer, Tab to queue, Esc to interrupt; Codex issue 45967
documents accepted steers lost when a turn is interrupted before
persistence. Cursor steers without interruption and follow-ups wait for the
next tool call. Claude Code Remote Control queues mid-turn prompts, uses
outbound HTTPS only with short-lived credentials, and reports takeover;
`claude -p "msg" --cloud <id>` queues to a cloud session; cross-session
messaging delivers between tool calls, is `accept|hold|refuse` by policy, and
a received message can never approve a permission, change config or run a
slash command. Tool narrowing: subagent `tools`, `disallowedTools`,
`permissionMode`; a `PreToolUse` deny applies even in bypass mode; OpenAI's
SDK filters MCP tools statically or dynamically with per-tool approval.
Policy engines: OPA 1.0 (Rego v1), Cedar 4.5 (`permit`/`forbid` with schema
validation at write time; forbid-overrides-permit not re-verified), Oso's OSS
library deprecated. Capability attenuation: Biscuit tokens and the IETF
draft on attenuating agent tokens (2026-06-15) define a lattice where a
derived token can never widen authority.

### Options

**11A. Hub-relayed signed steering envelopes bound to attempt identity.**
`{project, host, workspace, session, assignmentId, attemptId, fence, seq,
kind: steer|follow_up|abort|stop, body (at most 64 KiB), ttl, idemKey, sig}`.
The target Runtime pulls it (outbound only), verifies the signature and that
`(attemptId, fence)` is current, and replies with a signed receipt whose state
walks `queued` (hub accepted) to `delivered` to `acknowledged` (bound and
scheduled at the next boundary) to `applied` (a receipt names the model step
that consumed it) or `superseded|expired|rejected`. `abort` must not drop
already-acknowledged steers. Pros: no inbound ports; replay-safe; every state
is evidence. Cons: latency is the poll interval; needs per-host keys shared
with Topic 8.

**11B. Vendor steering channels as adapters.** Remote Control, `--cloud`,
cross-session messaging, a KXM channel plugin, Pi RPC `steer`, Cursor
followup. Zero protocol work, but no attempt binding, preview-grade, and
traffic transits vendor servers. Use under 11A, never as the contract.

**11C. Tool narrowing enforced at the Runtime boundary, attenuation only.**
The closed manifest carries `allowed_tools[]` and argument constraints;
enforced by a `PreToolUse` HTTP hook (Claude Code), Pi tool filters, or MCP
static filters; a steer may add constraints but a request to widen is
rejected and logged; sub-agent spawns derive narrower capabilities.

**11D. Policy engine for steering and tool decisions.** Start with a small
JSON `permit`/`forbid` evaluator validated against a schema; adopt Cedar or
OPA when rule count or auditors demand it. Policies are artifacts under
two-critic review, never derived from memory.

**11E. Direct host-to-host mTLS.** Lowest latency but inbound ports on
workstations and sandboxes and loss of the journal as replay anchor. Defer.

### Comparison

| Criterion | 11A hub-relayed signed | 11B vendor channels | 11C tool narrowing | 11D policy engine | 11E direct mTLS |
|---|---|---|---|---|---|
| Bound to attempt and fence | Yes | No | Yes (manifest) | Yes (subject) | Yes |
| Queued vs acknowledged vs applied | Yes | Queued only | n/a | n/a | Yes |
| Replay-safe across hosts | Journal plus `seq` | Vendor-dependent | n/a | n/a | Needs own journal |
| Works behind NAT | Yes | Yes | Yes | Yes | No |
| Maturity | Composed from proven pieces | Preview | GA hooks | Stable engines | Standard |

### Recommendation

**11A as the contract, 11C as enforcement, 11B as adapters, 11D as the rule
format; defer 11E.** Fix the semantics now: `steer` delivers at the next turn
boundary; `follow_up` only when idle; `abort` cancels the in-flight step but
preserves acknowledged steers; `stop` terminates the attempt and releases its
lease with a receipt. Anything the Runtime cannot bind to a live
`(attemptId, fence)` is `rejected`, never silently queued. That is the
difference between "queued input" and "acknowledged active steering" the
draft steering plan asks for. Steering can only attenuate: a body is plain
text plus an optional `constraints` block and can never carry tools, secrets,
approvals or policy.

**First slice:** add `seq`, `attemptId`, `fence`, `ttl` and a size cap to
`agent_control.steer` and `agent_control.stop`; Runtime emits `steer.ack` and `steer.applied`
receipts; enforce `allowed_tools[]` with a `PreToolUse` HTTP hook calling the
local Runtime and Pi's RPC tool filter; a small JSON `permit`/`forbid`
evaluator for "who may steer what". **Defer:** Cedar or OPA embedding,
Biscuit-style delegation tokens, direct mTLS, the channel-plugin adapter.

### Sources

1. Pi RPC mode, <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md>
2. Codex CLI docs and issues #45967, #23615, #37883, <https://learn.chatgpt.com/docs/codex/cli> ; <https://github.com/openai/codex/issues/45967>
3. Cursor changelog 2026-08-19 and Cloud Agents API, <https://cursor.com/changelog/08-19-26> ; <https://cursor.com/docs/cloud-agent/api/endpoints>
4. Claude Code Remote Control, cloud, cross-session messaging, channels, <https://code.claude.com/docs/en/remote-control> ; <https://code.claude.com/docs/en/claude-code-on-the-web> ; <https://code.claude.com/docs/en/cross-session-messaging> ; <https://code.claude.com/docs/en/channels>
5. Claude Agent SDK permissions, subagents, permission modes, <https://code.claude.com/docs/en/agent-sdk/permissions> ; <https://code.claude.com/docs/en/sub-agents> ; <https://code.claude.com/docs/en/permission-modes>
6. OpenAI Agents SDK MCP tool filters, <https://openai.github.io/openai-agents-python/mcp/>
7. OPA v1.0.0, Cedar 4.5, Oso deprecation, <https://github.com/open-policy-agent/opa/releases/tag/v1.0.0> ; <https://docs.cedarpolicy.com/> ; <https://github.com/osohq/oso>
8. Biscuit, <https://doc.biscuitsec.org/getting-started/introduction> ; IETF draft-niyikiza-oauth-attenuating-agent-tokens-01, <https://datatracker.ietf.org/doc/draft-niyikiza-oauth-attenuating-agent-tokens/>
9. KAIJU intent-gated execution, arXiv 2604.02375, <https://arxiv.org/abs/2604.02375>

## 12. Improvement and reflection circuits

### State of the art (2026)

The research line runs from Reflexion, Self-Refine and Voyager (2023) to the
"evolve the context, not the weights" wave. ACE (Agentic Context Engineering,
arXiv 2510.04618, ICLR 2026) is the reference design: a Generator produces
trajectories, a Reflector extracts lessons, a Curator merges them as delta
bullets with stable ids and helpful/harmful counters using deterministic
merge logic, then de-duplicates by embedding. Its headline failure is
"context collapse": a monolithic rewrite shrank a context from 18,282 tokens
to 122 and dropped accuracy below baseline. GEPA (ICLR 2026 oral, `dspy.GEPA`)
is the optimizer variant. Karpathy's autoresearch (2026-03-07) is the loop
template: one editable file, a fixed metric and budget, keep-or-revert; a
widely shared 53 percent speedup from such a loop was flagged as overfit and
left unmerged (secondary). "Harness Updating Is Not Harness Benefit" (arXiv
2605.30621) shows update plausibility and benefit decouple, so evaluation must
measure benefit on the consuming agent. Products converged with different
gates: Claude Code auto memory (`type`, `modified`, 200 lines or 25 KB,
machine-local, "context, not enforced configuration"), `/insights`, Cursor
memories requiring approval, Devin knowledge with trigger plus content, Codex's
two-phase memory extraction with redaction and an open RFC (#40575) for
ADD/NARROW/REPLACE/RETIRE "rule metabolism" on AGENTS.md. Anthropic's
skill-creator ships an eval loop (with-skill versus without-skill trials, a
grader, `benchmark.json`), and "Demystifying evals" (2026-01-09) recommends 20
to 50 tasks from real failures and distinguishes pass@k from pass^k. Threats:
OWASP ASI06 memory poisoning; MPBench (2026-06-18) finds "agents designed to
write and retrieve memory more aggressively are more exploitable".

### Options

**12A. Host-local reflection, git-only activation.** Each host runs
`kxm_workflow_record` and `kxm improve` locally; output becomes ACE-style
candidate bullets as `kxm.doc.v1` files with `authority: hypothesis`; the hub
receives only allowlisted redacted candidates, de-duplicates by content hash
then embedding, and opens or updates a PR. Nothing activates until merge.
Smallest attack surface; humans are the eval.

**12B. Hub-run evaluator for skill candidates (skill-creator style).** For
each `skill-candidate` in `proposed`, run a fixed suite in with-skill and
without-skill configurations, N trials, code graders first; publish
`benchmark.json` as the evidence the promotion API already requires. Eval
sandboxes are network-restricted and hold no hub credentials.

**12C. Automated optimizer loop (GEPA, DSPy, autoresearch-style) over one
bounded artifact.** Highest throughput; Goodhart risk is the documented
failure mode; output is still a diff through a PR; a path allowlist must keep
it away from gates, policy and permissions.

**12D. Delegate to vendor memory, aggregate reports only.** Zero surface but
machine-local, no evidence trail, no Pi equivalent.

**12E. Lessons only, no learned executable behavior.** Simplest, but teams
copy lessons into skills by hand, unreviewed.

### Comparison

| Criterion | 12A journal to PR | 12B hub eval runner | 12C optimizer loop | 12D vendor memory | 12E lessons only |
|---|---|---|---|---|---|
| Cross-host aggregation | Hub dedupes | Hub dedupes and evaluates | Hub runs loop | None | Hub aggregates |
| Evidence quality | Human review | Quantitative | Metric-driven | Anecdotal | Refs only |
| Poisoning surface | Low | Low to medium | Medium to high | Vendor | Low |
| Fits vNext | Yes | Yes | Only with path allowlist | Partially | Yes |
| Ops cost | Low | Medium | High | Near zero | Low |

### Recommendation

**12A now, 12B as the second slice, 12C as a bounded experiment, 12D as an
input only.** Design points: represent candidates as deltas, never rewritten
documents (one file per candidate, stable `id`, `helpful`/`harmful` counters,
`evidence[]`, `area`); never let a host rewrite another host's candidate; the
hub merges deterministically. Separate three record kinds explicitly: lesson
(fact plus evidence, wiki-bound), candidate (proposed executable change,
eval-bound), policy (gates, permissions, workflow manifests; PR-only, never
loop-produced). Poisoning controls: candidates carry run, stage and attempt
provenance; the hub rejects candidates whose evidence refs do not resolve;
candidate text renders in PRs inside a quoted untrusted block; keep write
channels to one schema-validated tool and never auto-retrieve candidates into
agent context.

**First slice:** extend `kxm improve` to emit `docs/kb/candidates/*.md` in the
delta format; a hub endpoint that ingests only those files, dedupes by hash,
and posts one PR per improvement area per week; reuse retrospective exports
for evidence links. **Defer:** GEPA or DSPy, automatic hypothesis generation,
model-graded rubrics beyond a first code-graded regression suite.

### Sources

1. ACE, arXiv 2510.04618, <https://arxiv.org/abs/2510.04618>
2. Dynamic Cheatsheet, arXiv 2504.07952; GEPA, arXiv 2507.19457, <https://dspy.ai/api/optimizers/GEPA/overview/>
3. karpathy/autoresearch, <https://github.com/karpathy/autoresearch>
4. "Harness Updating Is Not Harness Benefit", arXiv 2605.30621
5. Claude Code memory and commands, <https://code.claude.com/docs/en/memory> ; <https://code.claude.com/docs/en/commands>
6. Cursor memories (secondary), <https://forum.cursor.com/t/0-51-memories-feature/98509> ; Devin knowledge, <https://docs.devin.ai/product-guides/knowledge>
7. Codex RFC #40575, <https://github.com/openai/codex/issues/40575> ; Codex memory internals (secondary), <https://mem0.ai/blog/how-memory-works-in-codex-cli>
8. anthropics/skills skill-creator, <https://github.com/anthropics/skills/tree/main/skills/skill-creator> ; "Demystifying evals for AI agents", <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
9. OpenAI to acquire Promptfoo, 2026-03-09, <https://openai.com/index/openai-to-acquire-promptfoo/>
10. OWASP Top 10 for Agentic Applications 2026, <https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/> ; MPBench, arXiv 2606.04329; sleeper memory poisoning, arXiv 2605.15338
11. Willison, "The lethal trifecta", <https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/>
12. Autoresearch overfit coverage (secondary, unverified), <https://www.techtimes.com/articles/316804/20260519/karpathys-autoresearch-loop-spreading-fast-shopifys-53-speed-claim-still-unmerged-flagged.htm>

## 13. Wiki

### State of the art (2026)

Karpathy's llm-wiki gist (2026-04-04) is the canonical pattern: `raw/`
immutable sources, `wiki/` LLM-written pages, a schema file, three operations
(ingest, query, lint), an `index.md` catalog and an append-only `log.md`. It
has no provenance, confidence or authority fields and no multi-writer story.
"Knowledge Compounding" (arXiv 2604.11243) argues the economics: four
sequential queries cost 47K tokens against a compounded wiki versus 305K with
re-derived RAG. Tooling caught up: Obsidian's Local REST API plugin serves MCP
itself with `vault_read`, `vault_patch` and `search_query`; Outline has
community MCP servers; Notion and Atlassian have official remote MCP; wiki.js
v3 has no ETA; Dendron is discontinued. Docs-as-code lint is standard
(markdownlint-cli2, Vale, lychee, `remark-lint-frontmatter-schema`). Graph
stores (Graphiti, Cognee, LightRAG, GraphRAG) compete on vendor benchmarks.
The Skills over MCP extension is the clearest statement that
instruction-bearing content must be verified (SHA-256 manifests, approval
bound to the manifest, "treat skill content as untrusted input").

### Options

**13A. Git-backed markdown wiki in-repo, hub as read model plus search plus
linter.** `docs/kb/` pages with `kxm.doc.v1` frontmatter; git is the
transport; the hub indexes the checked-out tree into SQLite FTS5 and serves
`kxm_recall` and Studio read models; a `compile` step turns journal `lesson`
and `state-change` entries into pages; `lint` runs Karpathy's checks plus
schema validation in CI. Agent-written pages are data; `authority:
instruction` is grantable only by a human-merged PR.

**13B. Per-host Obsidian vaults through the Local REST API MCP, hub
compiles.** Best human UX, but workstation-only and two sources of truth.

**13C. Hosted wiki (Outline, Notion, Confluence) over remote MCP.** Teams
already read it, but pages are not diffable by CI and the canonical copy
leaves git.

**13D. Knowledge-graph backend (Graphiti or Cognee) as the store.** Temporal
facts and multi-hop questions, but opaque to reviewers, not diffable, and the
extractor is itself a poisoning channel.

**13E. CRDT document store served by the hub.** Revision-safe concurrent
editing for Studio, but the CRDT log becomes authority instead of git.

### Comparison

| Criterion | 13A git plus hub index | 13B Obsidian per host | 13C hosted wiki | 13D knowledge graph | 13E CRDT store |
|---|---|---|---|---|---|
| Works on sandboxes and servers | Yes | No | Yes | Yes | Yes |
| Provenance and review gate | git plus PR | Vault history | Page history | Extraction logs | CRDT history |
| Diffable and lintable in CI | Yes | Partly | No | No | Via export |
| Prompt-injection posture | Pages are data | Same, personal | Same | Extraction writes | Peers write live |
| Ops cost | Low | Low to medium | Low | Medium to high | Medium |

### Recommendation

**13A is the wiki; 13E is a later Studio editing layer; 13D at most a derived
index.** Schema and policy: keep `authority` and `confidence`; add
`provenance[{kind: journal|run|commit|pr|doc, ref}]`, `written_by:
human|agent:<id>` and `reviewed_by`. Rule: any page with `written_by: agent:*`
MUST carry `authority: hypothesis`; the linter rejects otherwise and the hub
refuses to index a violating page. A wiki page is never loaded as a skill;
skills stay in `skills/` with their own review and a page may only link to
one. Lint in CI with `remark-lint-frontmatter-schema`, markdownlint-cli2,
lychee, plus a KXM lint for contradictions, stale verified pages whose
provenance commits no longer exist, orphans, and imperative text on
hypothesis pages (warn only). Search with FTS5 in the existing hub DB.
Cross-host sync is git: `merge=union` in `.gitattributes` for `docs/kb/log.md`
and append-only indexes; sandboxes push to a branch; the hub's compile job
rebases and opens one PR per day. Render pages to agents inside a delimiter
that shows `authority` and `written_by`; retrieve on demand, never auto-load.

**First slice:** `kxm kb lint` and `kxm kb index` over `docs/kb/`, a compile
that emits one page per approved lesson with provenance, FTS5 behind
`kxm_recall`. **Defer:** embeddings, Graphiti-style temporal index, CRDT
editing, Obsidian bridging, hosted mirrors. This respects the existing
decision to punt wiki compile and ingest until a public npm release; the
slice above is the design to have ready for it.

### Sources

1. Karpathy llm-wiki gist, <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
2. "Knowledge Compounding", arXiv 2604.11243
3. tobi/qmd, <https://github.com/tobi/qmd>
4. Obsidian Local REST API (MCP), <https://github.com/coddingtonbear/obsidian-local-rest-api>
5. mcp-outline, <https://pypi.org/project/mcp-outline/> ; wiki.js v3 status, <https://github.com/requarks/wiki/discussions/7011> ; Foam, <https://foam.md/>
6. remark-lint-frontmatter-schema, <https://github.com/JulianCataldo/remark-lint-frontmatter-schema>
7. Graphiti MCP server 1.0, <https://blog.getzep.com/graphiti-hits-20k-stars-mcp-server-1-0/> ; Cognee benchmarks (vendor), <https://www.cognee.ai/blog/deep-dives/knowledge-graph-memory-benchmarks>
8. Electric, "AI agents as CRDT peers", <https://electric.ax/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs>
9. Skills over MCP extension, <https://modelcontextprotocol.io/extensions/skills/overview>
10. Claude Code memory docs, <https://code.claude.com/docs/en/memory>

## 14. MCP apps

Two different things share the name: (a) MCP Apps, the UI extension for
interactive views served from MCP servers; (b) MCP as the app-integration
plumbing across hosts.

### State of the art (2026)

(a) SEP-1865 became the first official extension, Stable as of 2026-01-26
(`io.modelcontextprotocol/ui`). A tool declares `_meta.ui.resourceUri`
pointing at a `ui://` resource with MIME `text/html;profile=mcp-app`;
`_meta.ui.visibility` controls who may call the tool; `_meta.ui.csp` and
`_meta.ui.permissions` bound the iframe. Views render in sandboxed iframes and
act as MCP clients over postMessage JSON-RPC (`ui/initialize`,
`ui/notifications/tool-result`, `ui/update-model-context`, host-proxied
`tools/call`), so every UI action passes the host's consent path. SDK:
`@modelcontextprotocol/ext-apps`; MCP-UI is now the recommended host SDK.
Hosts: Claude web and desktop, ChatGPT, VS Code Copilot, Cursor, Goose and
others. Claude Code's CLI and Pi do not render MCP Apps.

(b) MCP 2026-07-28 is stateless with `Mcp-Method`/`Mcp-Name` headers,
Multi Round-Trip Requests replacing server-initiated sampling and elicitation,
`subscriptions/listen`, `ttlMs`/`cacheScope`, no SSE resumability, and a
12-month deprecation policy for Roots, Sampling, Logging, HTTP+SSE and Dynamic
Client Registration. Tasks are the `io.modelcontextprotocol/tasks` extension
with a required durable task store. Authorization: OAuth 2.1 with PKCE, RFC
9728 metadata, RFC 8707 `resource`, CIMD; the OAuth Client Credentials
extension (RFC 7523 JWT bearer) for agents with no user present;
Enterprise-Managed Authorization (stable 2026-06-18 per secondary coverage).
The registry is still preview. Claude Code channels remain a research
preview: local stdio only, and Claude Code will not register a channel server
that negotiates 2026-07-28. Pi has no native MCP; `@mariozechner/pi-mcp`
registers MCP servers as tools.

### Options

**14a1. Read-only MCP App views over hub read models.** `ui://kxm/inbox`,
`ui://kxm/workflow/{runId}`, `ui://kxm/plans` rendered from the same read
models Studio will use; refresh tools with `visibility: ["app"]`; CSP limited
to the hub origin; `ui/update-model-context` hands the model a short status
summary. Works in Claude web and desktop, ChatGPT, VS Code, Cursor; not in
Claude Code CLI or Pi, which is where KXM's agents actually run.

**14a2. Interactive decision apps (promotion, approvals) inside the host.**
Decisions where the conversation is, but the iframe only has the connector's
identity and the audit trail is the host's. Acceptable only with per-call
host approval and a hub-side admin check.

**14a3. Standalone Studio with an MCP App shell.** One codebase; sandbox CSP
and no cookies mean token-in-postMessage auth.

**14b1. Hub as a remote Streamable HTTP MCP server.** Covered in Topic 1
option 1B: same tool names, Tasks extension for waits, `subscriptions/listen`
for inbox changes, OAuth with client credentials for agents and EMA later for
humans.

**14b2. Keep the stdio plugin as a thin shim.** Required for channels and for
Pi; forwards to 14b1 with a client-credentials token from the environment.

**14b3. Adopt A2A for host-to-host calls.** Covered in Topic 1 option 1C:
edge projection only.

**14b4. Claude Code channel fed by hub subscriptions.** The local channel
server subscribes to the hub and re-emits `notifications/claude/channel`;
unavailable on Bedrock, Vertex or Foundry sessions and only while a session
is open, so `kxm_inbox` polling stays the fallback.

### Comparison

| Criterion | a1 read-only apps | a2 decision apps | a3 Studio shell | b1 remote MCP hub | b2 stdio shim | b4 channel via hub |
|---|---|---|---|---|---|---|
| Reaches Claude Code CLI and Pi | No | No | No | Yes | Yes | Claude Code only |
| Reaches Claude web, ChatGPT, VS Code | Yes | Yes | Yes | Yes | No | No |
| Auth model | Host connector OAuth | Same plus admin check | KXM auth | OAuth 2.1 plus client credentials | Env credential | Local |
| Security | Strong (sandbox) | Needs per-call approval | Strong | Strong | Inherits b1 | Sender-gated |
| Maturity | Stable spec, uneven hosts | Medium | Medium | High | High | Research preview |

### Recommendation

**14b1 plus 14b2 first; 14a1 second; 14a2 and 14b3 deferred.** The multi-host
question is an auth-and-transport question, and the stateless core plus the
client-credentials extension were designed for "agents on other hosts calling
a hub". MCP Apps are worth doing once the hub is remote, because the same
read models power app views and Studio, but they are a convenience for humans
in chat clients, not the path by which agents communicate. Keep promotion and
admin decisions in Studio where KXM controls auth and the append-only audit
trail. Keep the channel local and legacy. Publish a registry `server.json`
only once the hub has a public origin.

**First slice:** the current tool set over Streamable HTTP on the legacy
revision behind a bearer project token with RFC 9728 metadata and audience
checks; the stdio plugin forwarding when `KXM_HUB_URL` is set; the remote
endpoint config for `@mariozechner/pi-mcp`. **Defer:** 2026-07-28 stateless
mode until the SDK v2 client is default in Claude Code, EMA, registry
publication, app views, any A2A surface.

### Sources

1. MCP Apps specification 2026-01-26, SEP-1865, launch post, overview and client matrix, <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx> ; <https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp> ; <https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/> ; <https://modelcontextprotocol.io/extensions/apps/overview> ; <https://modelcontextprotocol.io/extensions/client-matrix>
2. Anthropic, "Interactive connectors and MCP Apps", 2026-01-26, <https://claude.com/blog/interactive-tools-in-claude>
3. OpenAI Apps SDK reference, <https://developers.openai.com/apps-sdk/reference> ; MCP-UI, <https://github.com/MCP-UI-Org/mcp-ui>
4. MCP 2026-07-28 blog, changelog, authorization, <https://blog.modelcontextprotocol.io/posts/2026-07-28/> ; <https://modelcontextprotocol.io/specification/2026-07-28/changelog> ; <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
5. MCP Tasks extension, OAuth Client Credentials extension, Enterprise-Managed Authorization, <https://tasks.extensions.modelcontextprotocol.io/> ; <https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials> ; <https://blog.modelcontextprotocol.io/posts/enterprise-managed-auth/>
6. MCP registry and server.json, <https://github.com/modelcontextprotocol/registry>
7. Claude Code channels, MCP, desktop docs, <https://code.claude.com/docs/en/channels> ; <https://code.claude.com/docs/en/channels-reference> ; <https://code.claude.com/docs/en/mcp>
8. Pi and pi-mcp (secondary), <https://pi.dev/> ; <https://composio.dev/content/top-pi-extensions>
9. A2A joins the Agentic AI Foundation (Forbes, secondary), <https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/>

## 15. Env vars and secrets by project

### State of the art (2026)

Three ideas converged this year. "The agent never holds the value": exe.dev
(April 2026), Daytona 0.196 (July 2026) and Claude Code cloud environments
inject credentials at an egress proxy so the sandbox sees only a placeholder.
Identity instead of stored secrets: OpenBao 2.6.x (MPL-2.0) and Infisical
(MIT core) authenticate workloads by JWT, OIDC, SPIFFE or cloud IAM and mint
short-lived leases; Authentik 2026.8 (2026-09-01) added RFC 8693 token
exchange with delegation and agent accounts (Enterprise); Tailscale workload
identity federation is GA; GitHub App installation tokens stay one hour.
Redaction as a product feature: Cursor's Runtime Secret type rewrites values
to `[REDACTED]` in tool results, transcript and commits; Codex cloud strips
secrets before the agent phase and blocks agent-phase internet by default.
HashiCorp Vault is BUSL-licensed; OpenBao is the fork self-hosters pick. The
threat everyone designs against is the lethal trifecta (private data plus
untrusted content plus an exfiltration channel); a June 2026 incident with a
forged Sentry report exfiltrating cloud and GitHub credentials made it
concrete.

KXM vNext already states the boundary: sync events carry only a secret's
name, scope, status, source and version, never a value, and "secret values:
host secret store, never replicated". The platform's CP-10 design (metadata,
versions, bindings, bootstrap tokens and access-event tables; envelope
encryption; a dedicated broker VM on VLAN 47 delivering values over mTLS to a
workspace identity; tmpfs delivery; audit without values) is the host-side
implementation of exactly that contract. The question is what the hub owns,
and what to do while the broker is disabled in owner alpha.

### Options

**15A. Hub owns references and grants; the CP-10 broker owns values.** The
hub gains a per-project env schema `{name, scope: project|repository|host,
source: secret-ref|plain, ref, version, required_for[], status}`; runs pin
the env set. At `preparing`, the local Runtime resolves each reference
through the broker with the CP-10 workspace identity, places the value in
tmpfs or process env, registers it with the in-memory redactor, and reports
`resolved`. Grants are hub-side policy: project P may bind secret S to runs
of kind K on hosts tagged T. Pros: no crypto in the hub; matches the platform
decisions D-019 and D-022; a hub compromise yields metadata only. Cons:
nothing resolves until VLAN 47 is routed; plain env still needs a home.

**15B. Hub-native encrypted store.** Envelope encryption with a root key under
systemd `LoadCredentialEncrypted=`, per-project data keys, versions, per-run
grants, audit. Works today and is the simplest developer story, but it
duplicates CP-10, contradicts vNext, turns the hub on VLAN 30 into a
credential store reachable from every workspace, and makes every hub backup a
secrets backup. Ops medium to high.

**15C. External manager (OpenBao 2.6.2 or Infisical).** Namespaces map to
accounts; JWT/OIDC auth from Authentik or the CP-10 identity; leases,
rotation, dynamic Postgres credentials. The hub still stores references
(`bao://ns/kv/path#v`). Another stateful service on a 62 GiB host (estimate
200 to 400 MiB) that overlaps the broker. Note that OpenBao 2.6 deprecates its
cloud KMS seals and file storage backend.

**15D. Proxy injection and identity-issued credentials.** An injecting HTTP
proxy on the workspace path for API secrets, a GitHub App minting one-hour
installation tokens per run, an LLM gateway with virtual keys and budgets
(LiteLLM, Bifrost) for API-key harness paths, workload identity federation
for cloud APIs. Strongest answer to the trifecta, but HTTP-header auth only
and nothing off the shelf for Proxmox.

**15E. Proton Pass CLI 2.3.3 today.** `pass-cli run -- <cmd>` injects values
for `pass://vault/item/field` URIs found in the environment; personal access
tokens allow non-interactive login; headless VMs need
`PROTON_PASS_KEY_PROVIDER=fs`, which Proton's own FAQ calls unsafe; telemetry
is on by default. Already deployed by the harness snippets, but login is
interactive today, there are no per-run leases, and a PAT is a long-lived
bearer on the VM.

Not recommended as the primary store: Doppler (SaaS only), 1Password
Environments (beta; `op run --env-file` with `op://` refs is the stable
analogue), Bitwarden Secrets Manager, SOPS plus age (right for committed
non-secret config, wrong for runtime secrets because keys land on every VM).

### Provider keys for the LLM harnesses

Claude Code subscription login is OAuth; `claude setup-token` yields a
one-year token for headless hosts. Codex uses ChatGPT OAuth or an API key.
Grok CLI is OAuth-only against auth.x.ai with a manual-paste login. Kimi uses
a device-code flow. Antigravity is Google sign-in with no documented scripted
flow. A hub-issued virtual key gives revocation, spend caps and per-project
attribution but only for harnesses in API-key mode, and it forfeits
subscription pricing. Treat harness login tokens as host-local credentials,
record only `{provider, status, expires}` in the hub, and use LiteLLM or
Bifrost virtual keys only for the API-key path with a monthly budget per
project. Never store subscription OAuth tokens in Proton Pass or the broker.

### Comparison

| Criterion | 15A refs plus grants | 15B hub store | 15C OpenBao/Infisical | 15D proxy/identity | 15E Proton Pass today |
|---|---|---|---|---|---|
| Hub sees values | Never | Yes | Never | Never | Never (VM does) |
| Per-run short-lived grant | Yes (broker leases) | Build it | Yes | Per request | No |
| Audit | Hub requests plus broker delivery | Hub | Manager log | Proxy log | Proton activity only |
| Works in owner alpha | Needs interim | Yes | If deployed | Partially | Yes |
| Trifecta exposure | Value in tmpfs for run | Value on VM and in hub | Value in tmpfs | None on VM | Value in VM env |
| New ops burden | Low | High | Medium | Medium | Low |

### Recommendation

**15A as the contract, 15E as the interim resolver, 15D for HTTP-API secrets
once a workspace proxy exists.** The hub owns schema, grants, per-run
resolution status and an audit of requests; it never owns values, ciphertext
or keys. Plain non-secret env is stored inline with `source: plain`. The
`secret-ref` is a URI with a scheme per resolver: `cp10://<binding>@v7`,
`pass://vault/item/field`, optionally `bao://`; the Runtime picks the
resolver and the hub validates that the scheme is allowed for the project.
Interim: the VM bootstrap creates a per-workspace Proton PAT scoped to the
project vault, never shared, stored under `/run` (tmpfs), resolved at
`preparing`, recorded in the hub as a host credential status, revoked at VM
destroy; swap to `cp10://` when the broker is routed with no schema change.
Threat controls: gitleaks v8.30.1 or TruffleHog as a deterministic gate on
every run diff and on memory promotion; Cursor-style `[secret:<name>@v]`
placeholder rewriting in tool output before persistence; a per-project egress
allowlist on OPNsense or a workspace-local proxy before secrets meet untrusted
content; VM destroy revokes workspace identity, PAT and any virtual key in the
same step as the roster delete.

**First slice:** env schema with `secret-ref` validation and status in run
pins; the `pass://` resolver in the Runtime with redactor registration; the
gitleaks gate; a portal "Environment" tab that edits names, scopes and
bindings only. **Defer:** 15B entirely, 15C unless dynamic Postgres
credentials or a second tenant boundary is needed, virtual keys until an
API-key harness path exists.

### Sources

1. OpenBao 2.6.x release notes, agent, JWT auth, <https://openbao.org/community/release-notes/2-6-0/> ; <https://openbao.org/docs/agent-and-proxy/agent/> ; <https://openbao.org/docs/auth/jwt/>
2. HashiCorp Vault releases and licensing FAQ, <https://github.com/hashicorp/vault/releases> ; <https://www.hashicorp.com/en/blog/hashicorp-updates-licensing-faq-based-on-community-questions>
3. Infisical machine identities, <https://infisical.com/docs/documentation/platform/identities/machine-identities> (release dates unverified)
4. Proton Pass CLI docs and releases (2.3.3, 2026-08-25), <https://protonpass.github.io/pass-cli/commands/login/> ; <https://protonpass.github.io/pass-cli/commands/contents/run/> ; <https://protonpass.github.io/pass-cli/help/faq/> ; <https://github.com/protonpass/pass-cli/releases>
5. 1Password service accounts, <https://developer.1password.com/docs/service-accounts/use-with-1password-cli/> ; Bitwarden Secrets Manager CLI, <https://bitwarden.com/help/secrets-manager-cli/> ; Doppler CLI, <https://docs.doppler.com/docs/cli>
6. SOPS 3.13.2, <https://github.com/getsops/sops/releases> ; gopass 1.17.2, <https://github.com/gopasspw/gopass/releases>
7. Authentik client credentials, token exchange, 2026.8 release, <https://docs.goauthentik.io/add-secure-apps/providers/oauth2/client_credentials/> ; <https://docs.goauthentik.io/add-secure-apps/providers/oauth2/token_exchange/> ; <https://goauthentik.io/blog/2026-09-01-authentik-version-2026-8/>
8. SPIFFE JWT-SVID, <https://spiffe.io/docs/latest/deploying/svids/> ; GitHub App installation tokens, <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation> ; Tailscale WIF GA, <https://tailscale.com/blog/workload-identity-ga>
9. LiteLLM virtual keys and budgets, <https://docs.litellm.ai/docs/proxy/virtual_keys> ; Bifrost, <https://github.com/maximhq/bifrost> ; Portkey budgets, <https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits>
10. Claude Code cloud environments, self-hosted environments, authentication, <https://code.claude.com/docs/en/cloud-environments> ; <https://code.claude.com/docs/en/self-hosted-environments> ; <https://code.claude.com/docs/en/authentication>
11. Codex cloud environments and internet access, <https://learn.chatgpt.com/docs/environments/cloud-environment> ; <https://learn.chatgpt.com/docs/cloud/internet-access>
12. Cursor Cloud Agents security and network, <https://cursor.com/docs/cloud-agent/security-network> ; Devin environment, <https://docs.devin.ai/onboard-devin/environment> ; Codespaces secrets, <https://docs.github.com/en/codespaces/managing-codespaces-for-your-organization/managing-development-environment-secrets-for-your-repository-or-organization>
13. Daytona secrets, <https://www.daytona.io/docs/en/secrets/> ; E2B env vars, <https://e2b.dev/docs/sandbox/environment-variables> ; Modal secrets, <https://modal.com/docs/guide/secrets> ; exe.dev proxy secrets, <https://blog.exe.dev/http-proxy-secrets>
14. Grok CLI, <https://github.com/Moore-developers/grok-cli> ; Kimi CLI login, <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html>
15. Willison, lethal trifecta, <https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/> ; 2026 incident roundup, <https://airia.com/blog/ai-security-in-2026-prompt-injection-the-lethal-trifecta-and-how-to-defend/>
16. gitleaks v8.30.1, <https://github.com/gitleaks/gitleaks> ; TruffleHog releases, <https://github.com/trufflesecurity/trufflehog/releases>

## 16. Hosted per-account hub topology

**Superseded on 2026-09-20.** The topology below (one `kxm-hubs` VM on
VLAN 30, a hub process and SQLite tree per account, the hub verifying
Authentik tokens as an OAuth 2.1 resource server, roster enrolment from
workspace VMs) predates the four per-tenant hosting rulings in
[Tracking](implementation-plan.md#decided) and
[plan-per-tenant-hosting.md](plan-per-tenant-hosting.md): one tenant is one
box with one loopback hub and a tenant label, Authentik and the portal own
the browser, the hub interprets no browser identity, and there is no
PostgreSQL write path. It is kept as dated evidence for the option
comparison; nothing in it is scheduled, and its "First slice" is not a slice.

### State of the art (2026)

Small operators choose one SQLite database per tenant over shared Postgres
with row-level security when tenants are few and isolation matters: Turso
database-per-tenant, Cloudflare Durable Objects (one SQLite per object), and
Litestream v0.5.17 (2026-08-31; LTX format, VFS read replicas, LiteFS folded
in) make per-tenant backup and restore routine. Postgres RLS write-ups in
2026 list the same footguns: owner bypass, `SET` leaking across poolers,
missing tenant-leading indexes, no resource isolation. MCP 2026-07-28 made
every MCP server an OAuth 2.1 resource server with RFC 8707 and RFC 9728;
the machine-to-machine client-credentials extension is still Draft with no
client implementing it, so agent-to-hub auth must be KXM's own. Dev-VM
platforms bind identity at workspace creation and treat the VM as disposable
with state elsewhere.

### Options, concrete for the Proxmox host

Shared facts: one node, 62 GiB, about 44 GiB reserved for host and platform
services, about 18 GiB for workspaces. The hub is Node 22.19+ or 24 with
`node:sqlite` and no native dependencies; expect roughly 80 to 150 MiB RSS per
idle hub (estimate; measure and cap with `MemoryMax=384M`).

**16A. One hub process and one SQLite tree per account on a single
`kxm-hubs` VM on VLAN 30.** `kxm-hub@<account>.service` systemd template with
`StateDirectory=kxm/%i` giving `/var/lib/kxm/<account>/{state/kxm.db,
memory/, plans/}`, `DynamicUser=yes`, `ProtectSystem=strict`, one loopback
port or Unix socket per account fronted by Caddy VM 230. Litestream per DB to
a path on VLAN 31 plus a nightly git push of memory and plans to a bare repo
there. Ten accounts cost about 1 to 1.5 GiB; a 3 GiB VM fits. Isolation is
process plus filesystem plus DB per account; restore and upgrade are per
account.

**16B. One multi-account hub with Postgres (VM 220) and RLS.** Requires a
storage backend KXM does not have, a tenant id on every table, per-request
`SET LOCAL`, and pooler discipline. Logical isolation only, whole-cluster
restore, all-at-once upgrade. Right at hundreds of tenants, wrong for one
node with an inactive Postgres VM.

**16C. Hub inside each workspace VM.** Today's loopback hub per VM. Zero
platform RAM and perfect isolation, but memory and plans die with the VM and
two VMs of one account cannot see each other. Only acceptable as the local
Runtime half of 16D.

**16D. vNext shape: local Runtime per workspace plus the per-account hub from
16A.** Each workspace runs the Runtime (execution, worktrees, harness
sessions, secret resolution, redaction) against its local event store; only
allowlisted events sync to the account hub. This is what makes VM destruction
safe: durable truth is on the hub; the VM holds a replica and an unsynced
tail.

**Network path from a workspace (VLAN 50) to its hub.** Alpha egress is DNS,
NTP, TCP 80/443 to the internet, TCP 443 to the bootstrap broker, RFC1918
blocked. Recommended: a Caddy route `hub-<account>.kxmd.dev`, an OPNsense
allow from VLAN 50 to Caddy VM 230:443 (the same shape as the bootstrap-broker
rule), and split-horizon DNS in Unbound so `*.kxmd.dev` resolves to Caddy's
VLAN 30 address from inside. This keeps "Caddy is the only HTTPS edge" true
and gives workstations and cloud sandboxes the same URL. A direct VLAN 30
rule saves a hop but adds a second TLS terminator. Tailscale stays
operator-only; do not put node keys on disposable workspaces.

**Auth against Authentik 2026.8.2 (verified).** Client credentials with a
static secret or with a JWT assertion signed by a configured Federated OIDC
Source; RFC 8628 device code (needs a stage-configuration flow as the brand's
default code flow); RFC 8693 token exchange (delegation with `act` requires
Agent accounts, Enterprise); per-provider RS256 signing keys; token lifetime
by user attributes. `private_key_jwt` client auth is unverified. Recommended:
one confidential provider `kxm-hub-<account>` with an RS256 key and 10 to 15
minute tokens; the hub verifies `aud`, `iss` and `exp` as an OAuth 2.1
resource server against the JWKS at id.kxmd.dev and publishes RFC 9728
metadata. Workspaces: the CP-10 bootstrap broker or pilot API publishes a
JWKS registered as a Federated OIDC Source, and the Runtime does JWT-assertion
client credentials with its workspace identity; interim, the pilot API
creates one Authentik service account per workspace with an app password
expiring at the VM's TTL, delivered by cloud-init next to the bootstrap token
and deleted on destroy. Humans use device code (`kxm login`) with
`offline_access`. Groups `kxm:<account>:owner|member|viewer` and
`kxm:<account>:<project>:writer` flow into a `groups` claim; a workspace's
`sub` gets per-project rights from the roster, not from groups.

**Scoping memory, plans and journal.** `/var/lib/kxm/<account>/state/kxm.db`
holds journal, roster, runs and read models with project as a column; memory
and plans are one git repo per account with per-project directories and
`memory/_account/` for cross-project memory; `kxm.doc.v1` gains required
`account:` and `project:` fields. Per-host memory on a disposable VM is a
cache plus an unsynced tail, never a source of truth: on destroy the pilot
API triggers `kxm runtime drain --deadline 60s`, then deletes the roster
entry; host facts worth keeping (toolchain versions, harness login status,
template id) are roster attributes so a re-cloned VM inherits them by
identity. Export is `git bundle` plus a Litestream restore.

**Operational model.** cloud-init on clone installs the guest agent, the
Runtime and pass-cli, writes the one-use bootstrap token to
`/run/kxm/bootstrap`, and starts `kxm-runtime.service`. First boot exchanges
the bootstrap token at the broker for a workspace identity, obtains a hub
token from Authentik, and enrols with `POST /v1/roster/hosts` and the VM's
public key; the hub marks the host `pending` until an owner approves in the
portal (auto-approve for the owner's own VMs). Subsequent connections must
present the pinned key. Destroy: pilot API, hub drain, roster delete,
Authentik and PAT and virtual-key revocation, `qm destroy`. The portal shows
per account: hub health and version, backup age, roster with last-seen and
pending approvals, memory and plan counts by project, open runs and gates,
and an export action.

### Comparison

| Criterion | 16A hub plus SQLite per account | 16B one hub plus Postgres RLS | 16C hub in each VM | 16D 16A plus local Runtime |
|---|---|---|---|---|
| Data isolation | Process and file per account | Row policies | Total | Same as A; VM holds replica |
| Blast radius of a data bug | One account | All accounts | One VM | One account |
| Per-account restore | Litestream plus git | Whole-cluster PITR | None | Same as A |
| Platform RAM for ten accounts | 1 to 1.5 GiB (est.) | 3 to 5 GiB with Postgres | 0 | 1 to 1.5 GiB |
| Survives VM destroy | Yes | Yes | No | Yes, with drain |
| Engineering to reach | Unit template, routes, auth | New storage backend, RLS, pooler | None | A plus vNext sync |

### Recommendation

**16D on 16A's topology.** One `kxm-hubs` VM on VLAN 30 (2 vCPU, 3 GiB),
`kxm-hub@<account>` units with per-account SQLite and git trees, Litestream
and git backups to VLAN 31, Caddy routes with split-horizon DNS and one
OPNsense rule, Authentik as token issuer, and the local Runtime on every
workspace syncing allowlisted events. It is the only option that satisfies
isolation, per-account restore and VM disposability with the available RAM,
and it needs no new storage code in KXM.

**First slice:** the systemd template, state layout and Litestream for the
operator's own account; the Caddy route, Unbound override and OPNsense rule;
the Authentik provider with RS256 key and device-code flow, the hub verifying
`aud`, `iss`, `exp` and mapping groups; roster enrol, drain and delete
endpoints wired to the pilot API's clone and destroy; required `account:` and
`project:` in `kxm.doc.v1`; portal cards for hub health, backup age and
roster. **Defer:** JWT assertion through the broker's JWKS until CP-10 is
live; RFC 9728 metadata and MCP client credentials until a client implements
the Draft; Tailscale for workspaces; any Postgres backend; per-account VMs
unless an account needs its own RAM ceiling or residency promise.

### Sources

1. Litestream v0.5.17 and VFS, <https://github.com/benbjohnson/litestream/releases> ; <https://litestream.io/reference/vfs/> ; Fly, "Litestream: Revamped", <https://fly.io/blog/litestream-revamped/>
2. Turso multi-tenancy, <https://turso.tech/multi-tenancy> ; Cloudflare SQLite Durable Objects and SaaS data isolation, <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/> ; <https://developers.cloudflare.com/use-cases/saas/data-isolation>
3. Postgres RLS in practice (2026), <https://queryplane.com/blog/postgres-row-level-security-in-practice/> ; <https://www.thenile.dev/blog/multi-tenant-rls>
4. MCP 2026-07-28 post and changelog; EMA and M2M status (secondary), <https://blog.modelcontextprotocol.io/posts/2026-07-28/> ; <https://mcp.directory/blog/mcp-enterprise-managed-authorization-2026> ; <https://dev.to/webofmike/mcp-agent-identity-one-spec-shipped-three-still-open-1889>
5. Authentik OAuth2 provider, device code, client credentials, token exchange, account types, user attributes, 2026.8 release notes, <https://docs.goauthentik.io/add-secure-apps/providers/oauth2/> ; <https://docs.goauthentik.io/add-secure-apps/providers/oauth2/device_code/> ; <https://docs.goauthentik.io/users-sources/user/account-types/> ; <https://docs.goauthentik.io/releases/2026.8/>
6. Tailscale tsidp and WIF, <https://tailscale.com/docs/features/tsidp> ; <https://tailscale.com/docs/features/workload-identity-federation>
7. Coder secrets and external auth, <https://coder.com/docs/admin/security/secrets> ; <https://coder.com/docs/admin/external-auth>
8. Claude Code self-hosted environments, <https://code.claude.com/docs/en/self-hosted-environments>
9. Ona secrets, <https://www.gitpod.io/docs/flex/secrets> ; DevPod, <https://github.com/loft-sh/devpod>
10. Firecracker, <https://firecracker-microvm.github.io/> ; Northflank sandboxing guide, <https://northflank.com/blog/how-to-sandbox-ai-agents>
11. Proxmox cloud-init, <https://pve.proxmox.com/wiki/Cloud-Init_Support>
12. dev-vm-platform docs 03, 04 (CP-10), 05, 12; kxmd-auth compose and blueprints; kxmd-portal (private repos, read 2026-09-17)

## 17. Agent lifecycle: short-lived, long-running and always-on, launched dynamically or from a workflow

### State of the art (2026)

Every serious platform converged on the same three-way split. Ephemeral
run-to-completion agents are the default unit of work: Claude Code subagents
and dynamic-workflow `agent()` calls (16 concurrent, 1,000 per run), Agent SDK
`query()` one-shots, OpenAI Agents SDK runs with `max_turns`, and per-task
sandboxes with explicit lifetime knobs (E2B default 5 min with
`on_timeout: "pause"`; Modal `timeout` plus `idle_timeout`; Vercel Sandbox 24 h
since 2026-06-16; Bedrock AgentCore `idleRuntimeSessionTimeout` default 900 s
and `maxLifetime` default 28,800 s, rangeable to 14 days). Long-running but
bounded sessions are the second class: Claude Code cloud sessions reclaim the
VM after inactivity and restore history on reopen; Anthropic's self-hosted
runner exposes `--capacity`, `--release-idle-session-min`,
`--kill-session-after-min`, `--startup-timeout-min`, `--drain-*` and
`--retire-at`; Cursor's self-hosted machines (2026-09-02) snapshot idle
machines and restore under the same worker id; Devin sessions sleep and wake
on a message. Always-on identity without always-on compute is the third
class and where the field moved most: Cloudflare Agents hibernate a Durable
Object after 70 to 140 s and wake on HTTP, WebSocket, alarm or email with
`schedule()` multiplexed through one alarm; Microsoft Foundry hosted agents
(GA, 2026-09-11) run per-session VM sandboxes with a 2 to 60 min idle timeout;
OpenClaw wakes agents on a 30 min heartbeat; Paperclip (2026-03-04) runs
agents on heartbeats and event triggers with hard monthly budgets; Cotal puts
inboxes on NATS with `spawn`, `join` and `retire`. OpenAI's Agents API entered
beta on 2026-09-10 with bring-your-own sandboxes. On the substrate side
nothing new is required: systemd transient units support `RuntimeMaxSec`,
`MemoryMax`, `WatchdogSec` and `Restart`; Podman quadlets are the declarative
container path; Proxmox VE 9.2 exposes `qm guest exec`; Firecracker is at
v1.17.0; Nomad at 2.0.6.

### Proposed lifecycle taxonomy

KXM's contracts already fix the nouns: `assignmentId` is logical work,
`attemptId` one execution, a run has one immutable home Runtime, shared
mutable actions need a fenced lease, unknown side effects are never replayed.
Four classes layer on top of that:

| Class | What it is | Process lifetime | Identity lifetime | Woken by | Stopped by |
|---|---|---|---|---|---|
| `task` | One attempt of one assignment, run to completion | Seconds to hours; hard `maxWallClockSec` | Ends with the attempt; only the receipt survives | Launch command (tool call, stage, schedule, event) | Exit, deadline, budget, cancel |
| `session` | A resumable worker bound to one `{project, agent, workflowRunId}` session directory | Minutes to days; idle-released, `maxLifetimeSec` capped | Session dir persists; process is disposable | Inbox message, callback, operator | Idle release, lifetime cap, stop |
| `resident` | A named coordinator identity with a durable inbox, schedule, budget and memory pointer; no process while idle | Materialised as a `session` on wake; hibernates after idle | Lives in the hub journal until retired | Inbox, hub schedule, signed webhook, heartbeat tick | Retire (explicit) |
| `daemon` | A process that must actually run: the Runtime, the hub, a channel bridge | Until stopped; `Restart=always`, watchdog | Same as process | Boot | Operator, host shutdown |

The key decision: **"always-on" means `resident`, not `daemon`.** A
resident's identity survives the workspace VM idle-sleeping; only daemons pin
a VM awake. This is what Cloudflare, Foundry, Letta and Paperclip all sell:
always addressable, zero compute when idle, expressed here in KXM's own
journal (Topic 3's persistent coordinator identity is a `resident`).

### Fields a `kxm.agent-spec/v1` needs

Compare with Claude Code subagent frontmatter (`tools`, `disallowedTools`,
`permissionMode`, `maxTurns`, `background`, `isolation`), Kubernetes Job
(`activeDeadlineSeconds`, `backoffLimit`, `ttlSecondsAfterFinished`),
Cloudflare Agent options (`hibernate`, `keepAliveIntervalMs`), and Anthropic's
runner flags.

```yaml
apiVersion: kxm.agent-spec/v1
name: release-coordinator          # stable identity, unique per project
class: resident                    # task | session | resident | daemon
project: kxm
harness: pi                        # pi | claude-code | codex | grok | kimi | antigravity
model: { id: "...", effort: high } # pinned per run by the existing run pin
prompt: { systemRef: "...", initial: "..." }
capabilities:
  tools: { allow: [...], deny: [...] }        # narrowed at spawn
  mcpServers: [...]
  skills: [...]
  permissionMode: dontAsk                     # never inherited implicitly
  secrets: [ "cp10://github-deploy-key@v3" ]  # references only, never values
  network: { egress: allowlist, domains: [...] }
placement:
  hostClass: dev-small                        # VM template class
  requires: [ "repo:kxm", "tool:node22" ]     # labels a Runtime advertises
  home: sticky                                # one immutable home Runtime per run
  isolation: worktree                         # worktree | container | vm
lifecycle:
  maxWallClockSec: 7200        # task/session hard deadline (RuntimeMaxSec)
  idleReleaseSec: 900          # session/resident: release after idle
  maxLifetimeSec: 86400        # session: replace the process after this
  maxTurns: 200
  budget: { usd: 25, inputTokens: 5000000 }   # hard stop
  restartPolicy: never         # never | onFailure | always
  backoffLimit: 0              # a retry is a new attemptId, never a replay
  ttlAfterFinishedSec: 86400   # keep unit and logs, then collect
  stopGraceSec: 30             # SIGTERM to SIGKILL window (TimeoutStopSec)
  heartbeatSec: 30             # hub lease renewal plus WATCHDOG=1
  startupTimeoutSec: 900       # release the slot if the harness never signals ready
triggers:                      # resident/session only
  inbox: { wake: true }
  schedule: [ { cron: "0 */2 * * *", tz: UTC, idempotent: true } ]
  webhook: [ { source: github, event: pull_request.opened } ]
  workflowStage: [ "release:verify" ]
state:
  sessionDir: "{project}/{agent}/{workflowRunId}"   # what the supervisor does today
  checkpoint: journal
  pin: { config: sha, memory: sha, repo: rev }
observability:
  receipts: in-toto            # signed start, heartbeat, finish receipts (Topic 8)
```

Two rules make the spec safe rather than descriptive. A spawned agent's
`capabilities` are the intersection of the spec and the spawner's own; a
message from another agent can never widen them. `restartPolicy: onFailure`
never re-runs an attempt; it creates a new `attemptId` under a fresh lease,
and only after the hub has classified the previous attempt's side effects as
known.

### Options for the launcher and placement substrate

**17A. Runtime-driven systemd transient units inside each workspace VM.**
The Runtime launches every `task` or `session` as
`systemd-run --user --unit=kxm-<attemptId> --collect -p RuntimeMaxSec=7200
-p MemoryMax=3G -p CPUQuota=150% -p TasksMax=512 -p KillMode=mixed
-p TimeoutStopSec=30 --working-directory=<worktree> -- pi --mode rpc
--session-dir ...`, or `StartTransientUnit` over D-Bus from Node so the
Runtime can subscribe to unit exit. The existing supervisor script becomes
the unit body; the unit name embeds `attemptId`, so orphan reconciliation on
Runtime restart is `systemctl --user list-units 'kxm-*'` diffed against the
hub's open attempts. Liveness is `WatchdogSec` plus `WATCHDOG=1` on
`NOTIFY_SOCKET`; the same tick renews the hub lease. Pros: zero new
infrastructure; per-attempt cgroup limits, hard deadlines and per-unit logs
for free; works identically on any host. Cons: process and cgroup isolation
only, so untrusted tasks must not share a VM; `--user` units need
`loginctl enable-linger` or a system-level Runtime.

**17B. Rootless Podman quadlets per agent inside the VM.** A `.container`
unit per `session` or `resident`, harness images, bind-mounted session dir
and worktree, a Podman network per project. Real namespace isolation between
agents on one VM and reproducible harness versions, at the cost of an image
pipeline, rootless nested-systemd friction, and no Claude Code cross-session
messaging across the container boundary.

**17C. VM per workspace through the pilot control plane; guest-agent exec as
break-glass.** The placement unit is a `dev-small` VM cloned from the
cloud-init template through the existing create, start, stop, idle-sleep,
pin, wake and destroy API; the Runtime inside it is the only long-lived
thing; `wake` is how a sleeping `resident` gets compute again. `qm guest
exec` reaches a VM whose Runtime is down. Cold wake is tens of seconds, so
`task` latency inside a sleeping VM is poor; one 62 GiB node caps concurrent
awake `dev-small` VMs at roughly a dozen. VM-level isolation is the strongest
practical boundary and the machinery already exists.

**17D. Firecracker or Kata microVMs inside workspace VMs.** Best per-task
isolation, the model E2B and AgentCore sell, but nested KVM on a single
Proxmox node costs performance and forbids live migration, and KXM would be
building an E2B (rootfs images per harness, jailer, networking, snapshots).

**17E. Delegate scheduling to Temporal, Kubernetes with KEDA, or Nomad.**
Mature retry, timeout, heartbeat and placement semantics, but each
duplicates the hub's journal, leases and receipts; Temporal's at-least-once
activity retries conflict with "unknown side effects are never replayed";
Kubernetes on one node is a large tax for a handful of agents.

### Comparison

| Criterion | 17A systemd units | 17B Podman quadlets | 17C VM per workspace | 17D Firecracker/Kata | 17E orchestrator |
|---|---|---|---|---|---|
| `task` startup latency | About 100 ms | 0.5 to 2 s | 30 to 90 s if asleep | 0.1 to 1 s (restore) | 1 to 10 s plus orchestrator |
| Isolation boundary | cgroup and process | Namespaces, rootless | VM and VLAN | microVM | Whatever is underneath |
| Cost at idle | Zero | Zero | Near zero (asleep) | Zero | Control-plane overhead |
| Cross-host placement | Needs hub | Needs hub | Native via control plane plus hub | Needs hub | Native |
| Fit for one 62 GiB node | Excellent | Good | Good, 10 to 12 awake VMs | Poor (nested KVM) | Poor to fair |
| Alignment with KXM contracts | High | High | High | Medium | Low (second journal) |
| Declarative spec mapping | Direct (unit properties) | Direct (quadlet keys) | Placement layer only | New tooling | Translation layer |

### Recommendation

**Build 17A inside 17C, keep the hub as the single scheduler and lease
authority, and implement `resident` as hub-side state rather than a process.**

1. **The hub owns identity, inbox, schedule and budget for every class.** A
   `resident` is a journal row: name, spec hash, inbox, cron list, budget
   counters, last-wake receipt, home Runtime. Schedules are evaluated by the
   hub, not by systemd timers, so a sleeping VM never misses a tick; the
   existing `kxm_workflow_wait` and signed-callback path is the resume
   mechanism.
2. **The Runtime executes, systemd contains.** Every attempt is a transient
   unit named `kxm-<attemptId>`; the spec's `lifecycle` block maps one to one
   onto `RuntimeMaxSec`, `MemoryMax`, `CPUQuota`, `TasksMax`,
   `TimeoutStopSec` and `WatchdogSec`. The Runtime advertises capacity and
   capability labels on registration and implements `idleReleaseSec`,
   `startupTimeoutSec` and `maxLifetimeSec` as its own timers, since systemd
   has no idle notion.
3. **Cross-host launch is an admitted command with a spawn lease.** A
   coordinator calls `POST /v1/launches {assignmentId, specHash, placement,
   budget, ttl, wake}`. The hub admits it (policy, budget, trusted spec
   hash), picks a Runtime by labels and free capacity, and places it in that
   Runtime's signed outbox. If no eligible Runtime is awake and `wake` is
   true, the hub asks the control plane to wake or clone a VM and starts an
   expected-spawn lease (10 to 3,600 s, as Anthropic's orchestrator
   enforces); if no Runtime claims the launch before it lapses, the launch is
   re-offered or failed. The Runtime returns signed receipts `claimed`,
   `started(pid, unit)`, `heartbeat`, `finished(exitcode, artifacts)` and
   `lost`. `lost` is distinct from `failed`: an expired heartbeat lease marks
   the attempt `lost`, and because side effects are unknown a new attempt
   needs policy or human admission, never automatic replay.
4. **Launch from a workflow stage** is the same command issued by the stage
   runner with `triggers.workflowStage` matched, carrying the stage's
   `attemptId` as parent so receipts and budget roll up.
5. **Orphans.** On Runtime start: list `kxm-*` units, read PID claim files,
   reconcile with the hub's open attempts; units without an open attempt are
   stopped; attempts without a unit are reported `lost`. On host death the
   hub's lease expiry does the same from the other side.
6. **Spawn-time narrowing.** `capabilities` at spawn are spec intersected
   with spawner; `permissionMode` is explicit; a launch carries the
   coordinator's identity so receipts attribute cost to the right budget.

This extends the existing in-process `agent` and `agent_control` surface
(spawn with `allowed_tools`, `turns`, `background`; `info`, `result`,
`steer`, `stop`) rather than replacing it: in-process subagents remain the
cheapest `task` class for work inside one session, and the spec is what lets
the same request escape the process to a unit, a VM or another host.

**First slice (one sprint):** `kxm.agent-spec/v1` with only `class: task |
session`, `harness: pi`, `capabilities.tools`, `placement.home: sticky` and
the six lifecycle fields `maxWallClockSec`, `idleReleaseSec`, `maxTurns`,
`budget.usd`, `stopGraceSec`, `heartbeatSec`; `kxm agent run --spec <file>
--assignment <id>` on the Runtime rendering the transient unit around the
existing supervisor script, writing the PID claim and emitting `started`,
`heartbeat` and `finished` receipts; hub `POST /v1/launches` single-host with
a lease table that has a `lost` state; `resident` as a journal row whose only
trigger is `inbox.wake: true` materialising a `session` on the home Runtime;
orphan reconciliation at Runtime start. **Defer:** hub cron triggers, VM
wake-on-launch through the control plane (needs capacity accounting), Podman
quadlets (only when two trust domains must share a VM), Firecracker, any
orchestrator, snapshot pause and resume, non-Pi `resident` adapters.

Two checks before committing: the workspace template must enable
`loginctl enable-linger` for the Runtime user or run the Runtime as a system
service; and the wrapper, not Pi, should own the watchdog tick so a long tool
call does not trip `WatchdogSec`, with the hub tolerating one missed
heartbeat before marking `lost`.

### Sources

1. Claude Code subagents, Agent SDK sessions, dynamic workflows, cloud, Remote Control, self-hosted environments reference, routines, cross-session messaging, channels, agent teams, <https://code.claude.com/docs/en/sub-agents> ; <https://code.claude.com/docs/en/agent-sdk/sessions> ; <https://code.claude.com/docs/en/workflows> ; <https://code.claude.com/docs/en/claude-code-on-the-web> ; <https://code.claude.com/docs/en/self-hosted-environments-reference> ; <https://code.claude.com/docs/en/routines> ; <https://code.claude.com/docs/en/cross-session-messaging> ; <https://code.claude.com/docs/en/agent-teams>
2. OpenAI Agents SDK running agents, <https://openai.github.io/openai-agents-python/running_agents/> ; Agents API and hosted sandboxes beta (2026-09-10), <https://community.openai.com/t/introducing-the-agents-api-and-hosted-sandboxes/1396481>
3. E2B persistence, Modal sandboxes, Cloudflare Sandbox lifecycle, Vercel Sandbox 24 h, Daytona sandboxes, <https://docs.e2b.dev/sandbox/persistence> ; <https://modal.com/docs/guide/sandboxes> ; <https://developers.cloudflare.com/sandbox/api/lifecycle> ; <https://vercel.com/changelog/vercel-sandbox-can-now-run-for-up-to-24-hours> ; <https://www.daytona.io/docs/en/sandboxes/>
4. AWS Bedrock AgentCore `LifecycleConfiguration`, <https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_LifecycleConfiguration.html>
5. Microsoft Foundry hosted agents, <https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents> ; Build 2026 update, <https://devblogs.microsoft.com/foundry/hosted-agents-build26/>
6. Cursor self-hosted machines (2026-09-02) and changelog 2026-08-19, <https://cursor.com/blog/self-hosted-machines> ; <https://cursor.com/changelog/08-19-26>
7. Devin sessions API and 2026 release notes, <https://docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session> ; <https://docs.devin.ai/release-notes/2026> ; Jules sessions, <https://developers.google.com/jules/api/reference/rest/v1alpha/sessions>
8. Pi RPC mode, <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md>
9. Letta agents, sleep-time agents, AgentFile, <https://docs.letta.com/agent-sdk/agents> ; <https://docs.letta.com/guides/agents/architectures/sleeptime/>
10. Cloudflare Agents long-running agents and Agent class lifecycle, <https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/> ; <https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/>
11. LangSmith cron jobs, <https://docs.langchain.com/langsmith/cron-jobs> ; Google Agent Engine runtime scaling, <https://cloud.google.com/agent-builder/agent-engine/optimize-runtime>
12. OpenClaw heartbeat and 2026.8.1 automations, <https://docs.openclaw.ai/gateway/heartbeat> ; Paperclip, <https://github.com/paperclipai/paperclip> ; Cotal, <https://github.com/Cotal-AI/Cotal> ; herdr-orchestrator, <https://github.com/sean1588/herdr-orchestrator> ; AgentMail webhooks, <https://www.agentmail.to/blog/building-real-time-ai-agents-agentmail-webhooks>
13. systemd transient settings, systemd-run, `StartTransientUnit`, node-sd-notify, <https://systemd.io/TRANSIENT-SETTINGS/> ; <https://man7.org/linux/man-pages/man1/systemd-run.1.html> ; <https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html> ; <https://github.com/systemd/node-sd-notify>
14. Podman quadlets, <https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html>
15. Proxmox VE 9.2 release, qm(1), guest agent, nested virtualization, <https://proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-2> ; <https://pve.proxmox.com/pve-docs/qm.1.html> ; <https://pve.proxmox.com/wiki/Qemu-guest-agent> ; <https://pve.proxmox.com/wiki/Nested_Virtualization>
16. Firecracker releases (v1.17.0), <https://github.com/firecracker-microvm/firecracker/releases> ; Kata issue #13008, <https://github.com/kata-containers/kata-containers/issues/13008>
17. Kubernetes Jobs, KEDA 2.20, Nomad 2.0.6 and job spec, <https://kubernetes.io/docs/concepts/workloads/controllers/job/> ; <https://keda.sh/docs/2.20/concepts/> ; <https://github.com/hashicorp/nomad/releases> ; <https://developer.hashicorp.com/nomad/docs/job-specification/parameterized>
18. Temporal task routing, worker versioning, detecting activity failures, <https://docs.temporal.io/task-routing> ; <https://docs.temporal.io/worker-versioning> ; <https://docs.temporal.io/encyclopedia/detecting-activity-failures>

## 18. Fit with the kxmd platform and recommended setup

### Will it work on this host?

Yes. The platform already embodies most of the assumptions the fourteen
topics make, and the remaining gaps are configuration rather than
architecture:

- **Workspace VM as the Runtime host.** Each VLAN 50 workspace is exactly the
  "home Runtime" vNext describes: execution, worktrees, harness sessions and
  secret resolution stay on the VM; only allowlisted events leave it.
- **Caddy as the single HTTPS edge** matches the pull-first, outbound-only
  transport: workspaces, workstations and cloud sandboxes all dial
  `hub-<account>.kxmd.dev`; no inbound port is ever opened on a VM.
- **OPNsense egress policy** is the enforcement point the secrets threat
  model needs; per-project egress allowlists are a later OPNsense rule set,
  not a new component.
- **Authentik** already issues 5-minute OIDC tokens for the control plane;
  the same instance issues hub tokens, device-code logins and, later,
  JWT-assertion client credentials for workspaces.
- **CP-10** is the value store the hub's reference-and-grant model expects,
  and its bootstrap token to workspace identity flow is the enrolment path
  for the signed roster.
- **The pilot API's create, start, stop, idle-sleep, pin, wake and destroy**
  are the placement and lifecycle primitives the agent launcher (Topic 17)
  drives for VM-class agents.
- **Single node, no HA** matches KXM's stated production boundaries; a
  per-account hub is not clustered and does not need to be.

Three things must change on the platform side:

1. A `kxm-hubs` VM on VLAN 30 (2 vCPU, 3 GiB) needs a place in the INFRA-04
   capacity ledger; either it comes out of the platform reserve's slack or
   workspace capacity drops by 3 GiB. This is a ledger decision, not a
   technical blocker.
2. One OPNsense rule (VLAN 50 to Caddy VM 230:443) and a split-horizon
   Unbound override for `*.kxmd.dev`.
3. Until VLAN 47 is routed, secrets resolve through a per-workspace Proton
   PAT; the hub schema is the same either way.

### Recommended setup, in order

This ten-step list targets the superseded §16 topology and is retained as dated evidence only; see Status against Tracking.

1. **Hub VM.** Clone `kxm-hubs` on VLAN 30; install Node 24 and
   `@kontextmind/kxm`; `kxm-hub@<account>.service` template with
   `StateDirectory`, `DynamicUser`, `MemoryMax=384M`; Litestream per account
   to VLAN 31; nightly git push of `memory/` and `plans/`.
2. **Edge.** Caddy route `hub-<account>.kxmd.dev` to the account's loopback
   port; Unbound override; OPNsense allow rule; a route generator in the pilot
   API so a new account gets a route on creation.
3. **Identity.** Authentik provider `kxm-hub-<account>` (RS256, 10 to 15 min
   tokens, `offline_access`); device-code flow enabled; groups
   `kxm:<account>:*`; the hub validates tokens and maps groups; interim
   per-workspace service accounts created by the pilot API at clone time.
4. **Workspace image.** Add the Runtime, `kxm-runtime.service`, pass-cli and
   the harness snippets to template 9102 via cloud-init; write the bootstrap
   token and interim credentials to `/run/kxm` (tmpfs); enrol on first boot
   with a generated Ed25519 host key.
5. **Roster and leases.** Signed `roster.json` per account (root key held by
   the account owner, distributed by the hub), presence heartbeats, `run_lease`
   and `attempts` tables with fencing, `kxm.receipt.v1` receipts signed by the
   host key.
6. **Transport.** The signed outbox and inbox with cursors between each
   Runtime and its account hub; the existing tools over Streamable HTTP on the
   same origin for workstations and cloud sandboxes; the stdio plugin
   forwarding when `KXM_HUB_URL` is set; the Pi remote endpoint.
7. **Secrets.** Per-project env schema and grants in the hub; `pass://`
   resolver in the Runtime with redactor registration; gitleaks gate on run
   diffs and memory promotion; revoke PAT, identity and virtual keys on
   destroy; swap to `cp10://` when the broker is routed.
8. **Memory, plans, journal.** Per-account git repo with per-project
   directories, `memoryRev` pinned in runs, FTS5 recall from the hub DB,
   drain-on-destroy, `account:` and `project:` required in frontmatter.
9. **Portal.** Cards for hub health, backup age, roster and pending host
   approvals, environment (names and bindings only), memory and plan counts,
   open runs and gates, export.
10. **Telemetry.** `traceparent` on every record, `TRACEPARENT` set when
    spawning harnesses, a Phoenix container on the platform VLAN as the first
    sink, JSONL exported by cursor.

What this deliberately does not do: put a hub inside each workspace, put
Tailscale on workspaces, store secret values in the hub, adopt Postgres,
NATS, Temporal or A2A, or move the Claude Code channel off local stdio.

## Cross-cutting design rules

These rules fall out of every topic above. They are the contract that makes
the eighteen recommendations compose.

1. **One writer per fact.** The home Runtime is the only writer for a run's
   events, context bundles, memory proposals and spans; the hub is the only
   writer for claims, leases, attempts, receipts, presence and steering state;
   git is the only writer for reviewed behavior (plans, approved memory, wiki
   pages, skills, policy). Everything that crosses a host boundary is a
   redacted, schema-versioned, hash-addressed copy with a cursor.
2. **One identity tuple.** `{project, host, workspace, session, assignmentId,
   attemptId, fence, seq}` appears on claims, gate receipts, plan-bound tasks,
   steering envelopes and sync events. The fencing token is what makes late
   writers, late completes and late steers rejectable instead of silently
   applied.
3. **One evidence primitive.** The in-toto Statement v1 receipt, signed by a
   per-host Ed25519 key registered through the roster, is the gate outcome,
   the claim completion proof, the critic signature on a plan digest, and the
   steering acknowledgement. Build it once.
4. **Three ids on every cross-host record.** `workflowRunId` (also
   `gen_ai.conversation.id`), `fencingToken` when the record is a shared
   action, and `traceparent`.
5. **Four pinned revisions in every run manifest.** `repoRev` (exists),
   `memoryRev` (new), `redactionPolicyVersion` and `priceMapVersion`, so
   audits and cost reports are reproducible.
6. **Two-phase everything.** Record acceptance separately from application
   (Temporal's accepted/completed, A2A's interrupted states, the turn-boundary
   injection every harness converged on), and validate deterministically
   before acceptance.
7. **Attenuation only.** Steering, sub-agent spawning and learned content may
   narrow capability; nothing outside the closed manifest may widen it.
   Messages are data, never consent.
8. **Messages, memory and wiki pages inform; hooks and manifests enforce.**
   Approved memory and wiki pages load only into prompt context, never into
   permission, tool or policy resolution. `written_by: agent:*` implies
   `authority: hypothesis` until a human-merged PR says otherwise.
9. **Pull-first, hint-second.** Every cross-host channel (outbox, inbox,
   steering, presence) works with outbound-only connections and jittered
   polling; SSE, push notifications, channels and email are advisory wake
   hints layered on top.
10. **Park, never auto-retry, the unknown.** Unknown side effects enter
    `blocked_uncertain` with their idempotency key and wait for a human or a
    deterministic probe, copying Restate's pause semantics.

## Where the two research passes disagreed

- **A2A timing.** One pass proposed a signed Agent Card per coordinator in the
  first transport slice; another proposed no A2A surface until an external
  platform needs it. Resolution: document the mapping now, ship nothing until
  a concrete external caller exists. A2A is a projection of the journal, never
  its transport.
- **CRDTs.** Every pass that touched them (context, plans, wiki, Studio)
  deferred them for the same reason: they break single-writer authority and
  defeat the allowlist. They remain the right tool for a later Studio live
  editing layer only.
- **Brokers.** NATS JetStream is the best-proven bus for this shape (Cotal,
  DSX) and the right answer if fan-in latency or volume grows; deferred
  because it is a second durability and identity system.

## Items marked unverified by the research

- Microsoft Agent Framework GA date (2026-04-03) rests on secondary coverage.
- The SEP-2663 text references a "2026-06-30" spec label; the published
  revision is 2026-07-28.
- FIPA Contract Net: fipa.org now serves unrelated content; the flow was
  confirmed through a mirror.
- ChatGPT "Dreaming" memory rewrite (June 2026), Golem Cloud GA timing,
  Codex resume internals, LangMem version, the MinIO archive date, and DBOS
  TypeScript SQLite support (Go only confirmed).
- Codex and Devin plan-artifact specifics; spec-kit v1.0.7 exact release
  date; OpenSpec `validate`; Cedar forbid-overrides-permit; Beads canonical
  org.
- Pi's acquisition by Earendil (April 2026), the Enterprise-Managed
  Authorization stable date (2026-06-18), Obsidian Local REST API plugin
  version, the autoresearch overfit incident.

## Sequencing against Tracking (2026-09-20)

Delivery is S0–S5 in [Tracking](implementation-plan.md#still-open). This
table says where each topic stands. It schedules nothing; a topic moves only
when Tracking records a decision or its named trigger fires.

| Topics | Disposition | Decided where |
|---|---|---|
| 6 (local restart path), 10 (plan authority) | Touched by delivered S1 and S0; nothing further selected | Tracking, Landed in this tree |
| 14 (read-only views) | The MVP read surface is S2 portal reads through the portal backend, not MCP apps | Tracking queue, S2 |
| 18 (edge DNS, TLS, Authentik) | S5 on the tenant's existing proxy; the platform changes in §18 are superseded | Tracking queue, S5 |
| 3 | Post-MVP; trigger: coordinator intake dispatch or rebinding selected | Tracking, Explicitly not MVP |
| 11 | Post-MVP; trigger: polling proved insufficient; design reference in `plan-agent-communication-steering.md` | Tracking, Explicitly not MVP |
| 8, 9 (peer-reply evidence) | Recorded gap; trigger: first workflow that gates acceptance on peer review | Tracking, recorded gap |
| 1, 2, 4, 6 (cross-host leases) | Post-MVP Phase 8 distributed synchronization; not selected | Tracking, hub local is the default |
| 5, 12 | Phase 9 reviewed improvement; not selected | Tracking, Explicitly not MVP |
| 13 | Unselected; the public-npm punt expired and a new decision is required | Tracking, public npm prerequisite |
| 1 and 14 (remote MCP on the hub), 7, 8 (signed receipts), 10 (digest, lint), 15, 17 (taxonomy) | Not selected; no trigger; needs a new written decision | Tracking, Related plans |
| 16, 17 (VM launch substrate), 18 (platform changes) | Superseded by the four per-tenant hosting rulings | Tracking, Decided |

### Rejected proposal (2026-09-17): mapping onto M0–M9

Kept for the record. Tracking did not accept it; M0–M9 numbering is proposed
scope, not delivery order.

| Order | Slice | Topics | Fits |
|---|---|---|---|
| 1 | Hub leases with fencing, `attempts` table, presence heartbeats, `kxm.receipt.v1` | 3, 6, 8, 9 | M0 contract repair, Phase 2 Runtime |
| 2 | Signed roster with pinned keys, per-host Ed25519 keys, signed outbox/inbox with cursors, trace ids on every record | 1, 2, 7 | M2 durable intake, Phase 8 hub sync |
| 3 | Existing tools over Streamable HTTP with bearer project token and RFC 9728 metadata; stdio shim forwarding; Pi remote endpoint | 1, 14 | M1 package and capabilities, Phase 6 remote |
| 4 | `kxm.context-bundle.v1`, `memory/` tree with `memoryRev`, FTS5 recall, Claude `SessionStore` mirror | 4, 5, 6 | M5 memory and context recovery |
| 5 | Steering envelopes with `seq`/`fence`/receipts, `allowed_tools[]` enforcement, JSON permit/forbid evaluator | 11 | M3 exact resume and steering |
| 6 | `revision` digest and `kxm plan lint`, plan-bound tasks with `stale`, `kxm workflow lint` | 8, 10 | M6 workflow governance |
| 7 | `kxm improve` delta candidates, hub dedupe and weekly PR, `kxm kb lint`, `kxm kb index`, `kxm kb compile` | 12, 13 | Phase 9 reviewed improvement (wiki compile stays punted until public npm) |
| 8 | OTLP exporter, Phoenix sink, Claude Code telemetry wiring | 7 | M7/M8 operator surfaces |
| 9 | MCP App read-only views over Studio read models; A2A card only on external demand | 14, 1 | M7 Studio, later |
