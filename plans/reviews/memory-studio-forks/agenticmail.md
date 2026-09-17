# AgenticMail: persistent coordinator inboxes and communication adapters

## Recommendation

**High relevance for M3/M5/M7/M8. Adapt its stable agent inbox, selective wake,
thread context, provider adapter and delivery-status patterns. Keep KXM's Runtime
as the execution owner.** This is the closest match in this batch to giving a
primary or coordinator agent a persistent email/SMS presence across harnesses.
It is also a useful example of how much complexity follows once messages can
wake agents, resume sessions and trigger external actions.

Source baseline: `kontextmind/agenticmail` at
`a3e1cf0d09291ebfc22695ebe73affd9bf6e1871`, compared with KXM
`02aaed31fd6160a78378c677ab27d4119f039621`. Selected source inspection only;
no packages installed, third-party tests run, accounts provisioned or messages
sent. Repository claims of performance or live delivery were not independently
benchmarked.

## Architecture and actual behavior

### 1. Persistent identity and replaceable execution

An account has an ID, email, role and API identity. A `bridge` role represents a
host integration; `stopped` gates ordinary worker wakes while preserving incoming mail.
That separation is directly useful: an inbox belongs to an agent identity, while
the process doing its next turn can change. KXM should attach a coordinator
identity to project permissions and delegation policy, with email aliases and
optional phone routes as bindings. Model name, native session ID and machine
path belong to an execution assignment, not the address book.
[Account contract](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/accounts/types.ts#L1-L54).

The bridge-resume path is an exception: own bridge mail is routed before the
ordinary stopped check, and the inspected bridge handler can resume a session
without that check. KXM's pause contract must cover both fresh worker starts and
existing-session resume.
[Bridge route](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/claudecode/src/dispatcher.ts#L1184-L1198),
[Bridge resume](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/claudecode/src/dispatcher.ts#L2056-L2108).

The inspected bridge persistence keeps the most recent session per harness and
uses a 24-hour age threshold. Saving uses temporary-file replacement but is a
read-modify-write operation without a demonstrated cross-process compare-and-set.
This is unsuitable as KXM's authoritative routing key. Two projects using the
same harness must not compete for a single last-active slot; timestamp freshness
does not prove native session availability or exclusive ownership.
[Session storage](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/host-sessions.ts#L125-L197).

### 2. Inbox arrival, wake and task completion are different events

Its SSE server streams IMAP events and targeted task notifications. Connections
are capped per agent, but live events use an in-memory watcher map and contain
no replay cursor in the inspected framing. A fallback can broadcast events to
all active watchers. KXM should preserve recipient authorization at each fanout,
use durable intake as truth, and make SSE an observation channel.
[Event server](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/api/src/routes/events.ts#L19-L103).

The Claude dispatcher explicitly scans a pending backlog on its first successful
connection after startup. That scan is not run on every subsequent reconnection
in the inspected path. It also appends incoming bytes to an unbounded string
until a frame delimiter arrives. KXM needs bounded framing and gap recovery on
every disconnect, with snapshot/cursor continuity. A live connection is not
evidence that all earlier messages were processed.
[Reconnect path](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/claudecode/src/dispatcher.ts#L1768-L1820).

The wake coalescer sends the first message immediately and groups later messages
in a burst. This is a good interaction pattern for a coordinator: avoid a new
paid turn for every CC or status update. Implement it as durable Runtime work
with an explicit deadline, budget and recorded included-message IDs; in-memory
timers alone cannot preserve a pending batch across restart.
[Coalescing](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/claudecode/src/dispatcher.ts#L1823-L1870).

Typed task results and conditional `pending → claimed → completed` updates are
worth adapting as API ergonomics. However, a corrupt stored schema is skipped
in the result route. KXM must reject an invalid contract and keep model output
separate from verified workflow acceptance. Reading an email, acknowledging
delivery, producing a result and completing its assigned task are distinct.
[Task claim and result](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/api/src/routes/tasks.ts#L147-L205).

### 3. Email and SMS require explicit effect reconciliation

The SMTP sender retries certain connection failures, including timeouts and
resets. The inspected function has no durable outbox key; a lost response after
acceptance can therefore be ambiguous. KXM should persist an outbound intent
and content/recipient hash before sending, save provider receipts, and stop
automatic retry when delivery cannot be reconciled. A stable email Message-ID
helps correlation but does not establish exactly-once delivery.
[SMTP sender](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/mail/sender.ts#L74-L125).

The SMS implementation is narrower than the overall phone feature list suggests.
At this commit, the SMS provider registry contains **Google Voice and 46elks**.
Google Voice returns a pending record with manual web instructions; 46elks makes
a direct API call. Twilio appears in the phone implementation, which is not proof
that this SMS registry supports it. Capability discovery must report the exact
operation and transport.
[SMS providers](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/sms/manager.ts#L120-L234),
[Twilio phone implementation](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/phone/twilio.ts#L1-L70).

The direct SMS route records `pending` before sending, then marks every thrown
error `failed`; the Google Voice branch returns `success: true` with browser
instructions. For KXM, show **prepared**, **provider accepted**, **delivered**,
**failed**, or **unknown** only when supported by evidence. API success must not
turn a draft or uncertain network outcome into a delivered message.
[SMS route](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/api/src/routes/sms.ts#L309-L395).

Inbound email routing authenticates a relay, identifies the recipient by local
part, and optionally deduplicates the original Message-ID. Its operator-answer
hook precedes that deduplication and checks the parsed sender address. Adapt
durable ingress keyed by provider/account/event, exact address binding, and a
transactional duplicate check before any derived action. Relay authentication
and a matching From header are not by themselves an authenticated approval.
[Inbound route](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/api/src/routes/inbound.ts#L41-L129).

### 4. Memory should preserve sources and distinguish commitments

The project separates a shared thread cache from an agent's private thread
summary, commitments, open questions and last processed UID. KXM can use the
same distinction for concise wake context, while treating generated commitments
as candidate knowledge and pointing back to durable messages and task receipts.
A summary saying an action happened does not establish that it did.
[Thread memory](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/threading/agent-memory.ts#L1-L67).

The general memory manager maintains in-memory entries and a BM25F index loaded
from SQLite. Writes log and swallow database errors, while create updates the
cache before persistence. KXM must acknowledge memory changes only after durable
commit and rebuild derived indexes from authoritative records; otherwise a
successful-looking note can disappear on restart.
[Storage behavior](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/memory/manager.ts#L158-L227),
[Create order](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/memory/manager.ts#L288-L318).

Query relevance, importance, recency and access frequency influence generated
context. Confidence also decays when memories are not accessed. Borrow the
observable ranking controls, but keep confidence in a fact separate from its
retrieval popularity or freshness. Use controlled retrieval evaluations before
choosing BM25F, SQLite FTS or a native search helper.
[Context and decay](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/memory/manager.ts#L453-L548).

### 5. Execution and trust boundaries

The Claude dispatcher supplies broad native tools and `bypassPermissions`.
Its scratch working directory prevents some accidental collisions, but does not
demonstrate confinement. KXM should reuse its admitted producer interfaces and
native authentication, with the selected permission profile enforced before
waking a worker. Do not install a competing dispatcher beside the Runtime.
[Worker options](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/claudecode/src/dispatcher.ts#L607-L640).

Outbound content scanning and inbound attachment advisories are useful review
aids. They cannot replace authorization for the recipient, purpose, attachments
and exact message. A coordinator may autonomously send within an explicit
standing policy; otherwise Studio should present a concrete draft for approval.
External messages must never grant themselves tools or change that policy.
[Outbound scan](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/packages/core/src/mail/outbound-guard.ts#L540-L594).

## Current KXM comparison and landing points

| Area | Existing KXM anchor | Proposed change |
|---|---|---|
| Durable commands | `runtime-service.ts` | Reuse strict command identity and transaction boundaries for message-derived task intake. |
| Effect settlement | `engine-evidence.ts` | Learn from gate evidence validation; add a reviewed communication outbox/receipt contract, preserving uncertainty. |
| Memory | `memory.ts`, `arbiter.ts` | Shared thread evidence plus scoped coordinator notes and bounded recall; generated facts stay candidates. |
| Studio | `studio-layout.ts`, `cli/tasks.ts` | Inbox/read model, exact target details, drafts and delivery receipts over shared commands. |
| Native sessions | `pi-producer.ts`, `oneshot-producer.ts` | Durable route binding by coordinator/project/host/session/attempt; never last-active global selection. |

KXM already has transactional run acceptance with prompt/workflow conflict
checks and evidence validation for uncertain gate effects. The latter is a
gate-specific verifier, not a generic mail sender: do not append mail observations
to its existing gate event namespace. Add communication receipts under a reviewed
schema while keeping one Runtime owner; the fork's task database must not become
another workflow authority.
[KXM acceptance](https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/runtime-service.ts#L354-L440),
[KXM evidence](https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/engine-evidence.ts#L35-L84).

Memory body redaction and Studio's missing-handler success remain open in this
baseline. Resolve those before importing message bodies or enabling send buttons.
The CLI Studio server currently supplies a plan provider without a state or
mutation provider, so the management UI needs real Runtime wiring.
[KXM memory](https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/memory.ts#L239-L280),
[KXM Studio](https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/studio-layout.ts#L410-L430),
[KXM Studio launch](https://github.com/kontextmind/kxm/blob/02aaed31fd6160a78378c677ab27d4119f039621/plugins/kxm/src/cli/tasks.ts#L281-L327).

## Delivery packets and acceptance

- **M1/M8:** optional KXM-managed communication adapters; per-operation readiness,
  account binding and masked setup. One KXM install must work with communications
  disabled. Defer mail-server deployment, voice and automatic number provisioning.
- **M3/M6:** durable coordinator identity, pause/wake policy and grouped intake.
  Prove two workspaces cannot receive each other's messages; restart during a
  pending wake neither loses work nor duplicates an admitted task.
- **M5:** source-linked thread digest and reviewed coordinator memory. Inject a
  database failure; no success receipt or surviving cache-only fact is allowed.
- **M7:** inbox → thread → linked task → draft → delivery receipt. Refreshing or
  reconnecting must preserve pending approvals and show uncertain sends honestly.
- **M8/M9:** test duplicate webhooks, stale approvals, reordered delivery callbacks,
  timeout after provider acceptance, disabled coordinator and native-session
  mismatch, including stopped-coordinator bridge resume. Start with internal inbox
  and approved email, then SMS notifications
  and narrowly scoped authenticated replies. No broad autonomous communication
  policy is implied by owning an address.

## Runtime, setup and reuse

The root declares MIT and Node >=20, with separate core/API/MCP/host packages.
Inspect notices and dependency licenses before extraction. This architecture
does not require a Python or Rust rewrite: TypeScript fits message routing,
UI, provider APIs and current KXM contracts. Heavy optional tools can remain
separate managed components. The root manifest and README carry different
version contexts, so pin individual published artifacts before package trials.
[Manifest](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/package.json#L1-L57),
[License](https://github.com/kontextmind/agenticmail/blob/a3e1cf0d09291ebfc22695ebe73affd9bf6e1871/LICENSE#L1-L21).
