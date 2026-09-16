---
schema: "kxm.doc.v1"
id: "RESEARCH-HARNESS-STREAMING"
type: "architecture"
title: "Native harness streaming, working directories, sessions and channels"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-14"
updated: "2026-09-16"
authority: "hypothesis"
confidence: "uncertain"
summary: "Versioned installed-CLI observations and experiments for streamed handoff and live control, without claiming adapter admission."
tags: ["harnesses", "streaming", "research"]
related:
  - implementation-plan.md
  - plan-unified-kxm-milestones.md
  - plan-agent-communication-steering.md
  - plan-ssh-remote-execution.md
  - research-additional-forks.md
  - research-kxm-harness-strategy.md
  - research-runtime-language-choices.md
depends_on: []
blocked_by: []
details:
  baseline_commit: "5ff9f642e82d7a1e52aeab9245282d89560bb535"
  delivery_status: "investigation"
---

# Harness handoffs: what to use and what to prove

## Recommendation

Use each native CLI's structured output for live progress; admit live steering
and exact-session recovery only through verified bidirectional protocols. Treat
inbound Claude channels as a separate optional integration. A shared KXM task
API should hide transport differences while reporting unsupported operations
explicitly. The first product slice and subsequent native-adapter sequence live
only in the [unified plan](plan-unified-kxm-milestones.md); this packet specifies
transport contracts and experiments, not a competing delivery order.

This is the technical evidence packet for M2/M3 in the
[unified milestone plan](plan-unified-kxm-milestones.md). The
[implementation plan](implementation-plan.md) alone records decisions, execution
status, accountable owners and phase-gate acceptance.

## Evidence and limits

The source inspection and CLI observations retain their historical `5ff9f642`
baseline. Current KXM is `02aaed31`; its accepted A1 delta includes bounded async
product probes, termination escalation after child close, conservative descendant
settlement, redacted v2 process evidence and supervisor rejection handling.
These are preserved repairs, not new M0 work. Live permission and broader HTTP
lifetime witnesses remain subject to [Tracking](implementation-plan.md); neither
that delta nor the observations below establish Phase 11 admission.

Observed on `kxm-dev` at `2026-09-15T00:41:42Z`: executable resolution, versions,
root help and selected Codex subcommand help. The installed Codex app-server
schema was generated without experimental fields. These operations did not run
model tasks or install/update CLIs. One separate native Fable planning call ran
with no tools; it was a planning proposal, not a streaming or permission witness.

- [Installed help observations](evidence/harness-cli-observations.json): captured
  stdout/stderr, versions and binary paths; no credentials or account identifiers.
- [Codex schema observations](evidence/codex-control-schema.json): generated
  file hashes, required fields and present methods.
- [Planning provenance](evidence/unified-kxm-planning.json): proposal identity,
  scope, corrections and accounting interpretation.

The environment is Linux. Windows behavior has not been witnessed in this
investigation. Kimi and DeepSeek were not found on the probed PATH; that does
not prove absence everywhere. The executable named `agent` reports the Grok
version here; do not infer Cursor identity from that filename. Hermes is an
additional candidate, not a currently admitted KXM worker. Help/schema presence
proves an advertised interface, not correct runtime behavior or authorization.

## Three independent capability axes

| Axis | Question KXM must answer | Example |
|---|---|---|
| Observe | Can useful progress arrive before completion? At what granularity? | Whole tool/message event versus partial text delta |
| Control | Can we cancel, queue a follow-up or steer the active turn? | Writing another JSON line may only queue a new turn |
| Recover | Can we reconnect or resume the exact session after failure? | A session ID alone does not establish workspace or task ownership |

Keep transport, message type, visibility and delivery status separate. In
particular, “channels” can mean OS stdout/stderr, event categories, model message
metadata, or Claude's inbound MCP channel feature. A single generic `channel`
flag would conceal materially different capabilities.

## Installed capability matrix

All rows below are **help observed**, not product admission. Schema-export
evidence is identified separately. Model authentication and eligibility must be
checked at dispatch; this investigation did not validate every account.

| Harness/version | Output route | Input/control candidate | Workspace mapping | Session mapping |
|---|---|---|---|---|
| Pi 0.85.1 | `--mode json`; existing KXM `--mode rpc` | RPC protocol; verify steer/follow-up/abort semantics | Child process cwd; no root cwd flag observed | `--session`, `--session-id`, `--resume`, `--fork`, `--session-dir` |
| Claude 2.1.271 | `--print --output-format stream-json`; `--include-partial-messages` | `--input-format stream-json`; input acknowledgments via `--replay-user-messages`; control semantics need witness | Child process cwd; `--add-dir` extends access; `--worktree` allocates a worktree | Exact `--resume`; `--fork-session`; explicit `--session-id` for new session |
| Codex 0.153.4 | `exec --json` JSONL events | App-server stdio JSON-RPC; steer/interrupt/resume in generated schema | `exec -C/--cd`; `--add-dir` adds writable roots; app-server cwd field | Exact `exec resume`; app-server thread identity; ephemeral mode prevents persisted recovery |
| Grok 1.0.30 | `streaming-json` native ACP updates or `streaming-messages-json` Messages-shaped events | Root `--single` is one-shot; no root streaming-input flag observed | `--cwd`; optional `--worktree` and `--worktree-ref` | `--resume`, `--fork-session`; `--session-id` creates a new conversation |
| AGY 1.2.2 | `--print --output-format stream-json` | `--input-format stream-json`: one turn per input line, not proof of live steering | Child cwd candidate plus verified `--project`; `--add-dir` is additional workspace access | `--conversation` by ID; `--continue` is ambiguous for automation |
| Hermes 0.21.0 | Root one-shot advertises final output; ACP subcommand candidate | ACP requires separate protocol/version probe | `--in`; inspect restore-cwd behavior | Root resume/continue advertised; not a KXM admission |
| Kimi unavailable on PATH | Print JSONL documented externally | Wire JSON-RPC documented externally | Documented working-directory options need installed verification | Do not assume Kimi CLI variants share flags/protocol |
| DeepSeek unavailable on PATH | No installed evidence | No installed evidence | Unverified | Unverified |

### Pi

Keep the existing RPC worker and scope its tools explicitly. Useful controls
include `--tools`, `--exclude-tools`, explicit extension/skill selection and
thinking level. `--no-session` conflicts with durable resume. The help distinction
between disabling built-in tools and disabling all tools matters when KXM tools
are extensions. Use actual host activation tests to prove the effective surface.

Inspect the installed RPC contract before implementing steering; existing KXM
session code and the drafted supervisory API are not by themselves proof that
every control is wired durably. Provider selection stays consistent with the
native-auth preference in the canonical tracker.

### Claude

The observed help supports streaming input/output, partial messages, replayed
input acknowledgment, final JSON Schema, explicit resume/fork, tool restrictions,
settings sources and strict MCP configuration. Determine whether `--verbose` is
required by the selected print-stream route in the actual version witness.
Record permission denials as events; `--permission-prompts none` denies requests
that would prompt and does not grant new authority.

Important setup distinction: observed `--bare` skips OAuth/keychain auth and uses
API-key/helper routes. It is unsuitable as KXM's default way to isolate a native
subscription session. `--safe-mode` retains native authentication but disables
customizations, including the KXM plugin, so it is useful for isolated probes,
not the normal integrated feature route. A normal adapter needs reviewed settings,
MCP and tool scope without bypassing managed policy or losing KXM resources.

`--bg` and its management commands are worth evaluating later for native session
attachment, but wrapping them would transfer process ownership to another
supervisor. First prove how KXM reconciles that ownership. Do not add it merely
because it returns quickly. Forwarded subagent text can include thinking;
do not broadcast it into shared progress by default.

### Codex

The installed `exec` help advertises JSONL, explicit working root, final artifact
output and final response schema. Official guidance describes lifecycle/item
events for non-interactive clients. This makes it a useful new streaming adapter;
text granularity must still be measured.
[Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Installed schema generation found `turn/start`, `turn/steer`, `turn/interrupt`
and `thread/resume`, plus agent-message deltas and turn-completed notifications.
The generated steer request requires `threadId`, `input` and `expectedTurnId`.
That gives KXM a concrete stale-turn check instead of guessing which turn is
active. Schema presence is not a handshake or model execution witness.

Official app-server documentation describes streaming notifications and active
turn control. Steering adds input to the current turn; it does not change the
turn's cwd, model or permission policy. Use a new appropriately scoped turn for
such changes. Start with stdio, which the installed help supports, and defer
network listeners until authentication and lifecycle ownership are designed.
[Official app-server documentation](https://learn.chatgpt.com/docs/app-server).

Preserve current KXM read-only/never-approve policy where applicable; never-approve
does not itself provide a sandbox. `--ignore-user-config` keeps native auth in
the observed help, but does not by itself prove isolation from all customizations.
Retain exec-policy rules. `exec resume --help` does not advertise the fresh-exec
`-C` flag: construct resume argv separately, use explicit spawn cwd and prove
stored-session workspace binding. Do not use `--last` for task dispatch.

### Grok

Use distinct decoders for its two advertised streams. `streaming-json` is native
ACP session updates; `streaming-messages-json` is Messages-shaped. The observed
partial-message flag applies only to the latter. Reusing the current Claude
final-usage parser for every Grok stream is not sufficient.

The observed `--json-schema` implies JSON output. Treat simultaneous streaming
and schema enforcement as unverified until an explicit test resolves precedence.
KXM must validate the final itself regardless. Useful controls include cwd,
explicit session/fork, max turns, reasoning effort, tool allow/deny and sandbox
profile. Never translate a shared permission profile into `--always-approve`.
`--restore-code` changes repository state; it is not an ordinary resume default.
Session UUID creation and resume are separate operations in this version.

### AGY

Help is emitted on stderr, so discovery must inspect both streams. AGY advertises
stream-json input as sequential turns and supports a final-result schema in that
mode. Use its print timeout in addition to KXM's independent wall/drain bounds.
Process cwd is a legitimate mapping to test, even without a native cwd flag;
the unresolved question is which project/workspace the native engine actually
uses. Verify selected project plus child cwd with a read-only sentinel witness.
Never confuse `--add-dir` with selecting the primary repository.

### Candidate protocols

Kimi's print documentation describes structured input/output for automation;
Wire documentation exposes a bidirectional JSON-RPC protocol with cancellation
and interaction requests. These are candidates for M3, conditional on the exact
installed distribution and protocol negotiation. This investigation did not
install Kimi or demonstrate Wire behavior.
[Kimi print mode](https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html),
[Kimi Wire mode](https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html).

Hermes ACP and Grok's headless agent subcommand deserve later help/schema probes;
neither a subcommand name nor an ACP-shaped output stream proves that KXM can
host an interactive ACP session. Preserve unsupported capability states until
the exact request/response protocol is witnessed.

## Additional native candidate: DSH

The [deepseek-harness source review](reviews/fork-additions/deepseek-harness.md)
identifies package `@deepseek-ai/dsh` and executable `dsh`, distinct from KXM's
unverified `deepseek --json` entry. Neither executable resolved in the follow-up
PATH discovery. The inspected ACP bridge supports committed updates, exact
workspace-checked resume and cancellation, but not demonstrated token streaming,
replay or live steering. Its headless output has different semantics. Add an
M1 identity check and an M2/M3 ACP experiment; do not infer authentication from
ACP's no-op auth method or admit it as a worker from source alone. See
[discovery evidence](evidence/additional-fork-discovery.json).

## Claude channels: a bounded research track

Claude channels are MCP servers that inject external events into a running
session. The documented preview requires explicit enablement and may require
organization policy and an approved channel; custom development channels have
a separate testing path. Installed ordinary help did not list `--channels`, so
current eligibility and activation remain unverified. Optional permission relay
is distinct from ordinary event input and does not replace project trust or MCP
consent. [Official channels reference](https://code.claude.com/docs/en/channels-reference).

Proposed KXM use: notify the assigned session that a child completed, a check
failed, or the operator supplied an answer. KXM remains the authoritative task
and permission owner. The bridge carries task-bound data with source identity,
expiry and deduplication; it does not treat arbitrary inbound text as a command
to execute or as user approval. Default to a one-way event bridge. Add responses
and permission relay only as separately admitted capabilities.

If channels cannot be admitted, use KXM's ordinary durable message queue and
the harness's verified next-turn input route. Mark it queued. Never present it
as active-turn steering. Channel availability must not block M2 streaming.

## Handoff design

### Resolve workspace and native identity before launch

Resolve the project, host, repository root, worktree, task/attempt and allowed
effects together. Require an absolute existing cwd on the execution host; paths
from a local machine are not automatically valid over SSH. Bind native session
IDs to this resolved workspace and verify on resume. Any directory expansion is
an explicit additional grant. Prefer KXM's existing isolated worktree allocation
when ownership is needed; do not allocate a second native worktree implicitly.

Build argument arrays without shell interpolation. Native CLI flags are mapped
per command/version, not concatenated from user text. Preserve authenticated
native identity and environment scope. Re-probe capabilities when executable or
version changes, and reject a mismatched binary even if the filename is familiar.

### Decode and persist useful events

Incrementally decode UTF-8 and framed JSON with size, depth and time bounds. Keep
stderr diagnostic, never parse it as a successful final by accident. Each adapter
normalizes a small set of observations: started, activity/text, tool progress,
permission requested/denied, usage update, artifact available and terminal result.
These are semantic categories, not a proposal to bypass existing schema review.

Use existing Runtime event IDs and consumer cursors wherever possible. Add native
session/turn and source-event correlation only where the current contracts lack
it. Deliver at least once with idempotent projection; do not claim exactly-once
network delivery. Slow viewers may receive coalesced partial text or a snapshot,
but terminal/control/approval events must not be silently dropped. Expose any
retention gap and a recoverable artifact reference.

Redact before durability or display. Account for secrets split across chunks
using bounded buffering or structured whole-field handling; a naive per-chunk
regex leaks fragments. Shared progress excludes hidden reasoning and credentials.
Full permitted result artifacts have hashes, access scope and retention policy;
raw diagnostics are private, bounded and sanitized.

### Control, settle and recover

Input accepted by KXM, bytes written, native acknowledgment, active delivery and
completed work are different states. Use explicit command IDs and expected
turn identity for control. Enforce ordering and expiry. Do not expand permissions
through a steer. Queued follow-up stays queued until the native route receives it.

A terminal result requires valid structured outcome plus transport/process and
effect reconciliation. Partial success wording cannot settle a task. Preserve
usage emitted before cancellation, use final cumulative counters without double
counting and keep missing cost unknown. A direct child exit does not prove all
descendants or external effects stopped.

Decouple task lifetime from a viewer or HTTP request. On supervisor/SSH loss,
recover the native session and event cursor, fence duplicate controllers and
reconcile ambiguous effects before retry. Native resume support is not proof
that reconnecting can safely repeat the last tool action.

## Useful parameter policy

| Parameter family | Benefit | KXM treatment |
|---|---|---|
| Structured/partial output | Visible progress, tool activity and earlier diagnosis | Prefer verified per-version format; bounded parser and redaction |
| cwd/project/worktree | Correct repo and isolation ownership | Resolve once; prove remote mapping; additional roots are explicit grants |
| Exact session/resume/fork | Continuity and recoverability | Store IDs; verify ownership; no implicit latest session |
| Tools/permissions/sandbox | Match role effects | Intersect with KXM policy; witness native enforcement |
| Output schema/final artifact | Reliable completion and full result retrieval | Validate final independently; handle stream/schema conflicts |
| Model/effort/max turns/budget | Bound task effort | Provider-specific mapping; unknown costs explicit; no silent model fallback |
| MCP/plugins/settings | Load KXM resources consistently | Scoped generated registration, versioned manifests, policy retained |
| Streaming input/steer | Corrections without restarting | Distinguish queued turn from active steer; acknowledge delivery |
| Background/daemon | Potential reattachment | Defer until supervisor ownership and recovery are proven |
| Debug/forwarded subagent content | Private diagnosis | Opt-in sanitized artifacts; not default shared stream |

Do not use bypass flags, model/provider substitution, `--restore-code`, automatic
extra directories, discarded policy rules or API-key-only isolation modes merely
to make a headless invocation run unattended. Unsupported controls return a
specific reason and the next supported workflow.

## Experiment and acceptance matrix

Experiments are ordered from no-model inspection to bounded live witnesses.
Only discovery/schema checks and the separate planning call are complete in this
packet. All task/stream/control cases below remain proposed.

| ID | Experiment | Evidence/decision required | Packet |
|---|---|---|---|
| E0 | Binary identity, version, help; protocol schema when available | Recorded installed surface; reject stale/mismatched commands | M1/M2; inspection complete for matrix rows as qualified |
| E1 | Deterministic transcript replay, every chunk boundary | Same final and usage as buffered parse; no split-token leak | M0/M2 |
| E2 | Read-only repository sentinel in two workspaces | Correct cwd/project and denied extra root; fresh and resume routes | M1/M2/M3 |
| E3 | One bounded native task per target harness | First useful event before final; final validity and usage provenance | M2 |
| E4 | Stream format plus structured final | Resolve Grok flag conflict; malformed/missing final fails | M2 |
| E5 | Slow viewer, disconnect, reconnect and retention gap | Cursor replay and dedup; bounded memory; task survives viewer loss | M2 |
| E6 | Cancel during generation/tool, timeout, abrupt process loss | Bounded cleanup; truthful uncertain effects; one terminal settlement | M0/M2 |
| E7 | Exact session resume/fork after supervisor restart | No cross-task/project attachment; fencing and artifact continuity | M3 |
| E8 | Steer during tool activity, stale turn, duplicate control | Native delivery evidence; reject stale/unauthorized input | M3 |
| E9 | AGY/Claude second input before first turn completes | Determine queue versus steer; do not infer semantics from JSONL | M3 |
| E10 | Isolated Claude channel eligibility and ingress | Explicit supported activation, source binding, dedup, denial behavior | M3 research |
| E11 | Windows/Linux and SSH path/process cases | Spaces/Unicode, remote roots, broken pipes, termination and recovery | M2/M3/M9 |
| E12 | Actual installed KXM package across host surfaces | Same command contracts and no separate Pi extension requirement | M9 |

Record exact CLI/model version, resolved workspace, environment/auth route
(without secrets), input/output artifact hashes, event timings, denial/exit
details, usage and cost basis for every live attempt. Keep failures and retries.
No pass may be inferred from a zero exit code or an assistant's completion prose.

## Historical KXM inspection and remaining transport work

The [runtime language investigation](research-runtime-language-choices.md) adds
a bounded async Node baseline and a separate OS supervision experiment. Streaming
does not require Rust or Python. A native helper must demonstrate a measured
bottleneck or lifecycle capability gap and retain this packet's common contracts.

Code references below describe this plan's fixed historical baseline. Apply the
current A1 delta above and the unified plan's scope before selecting work:

- [`vnext-oneshot-process.ts`](../plugins/kxm/src/vnext-oneshot-process.ts)
  currently returns collected stdout/stderr at settlement, with an 8 MiB combined
  limit, and ends stdin after the initial input. Extend its bounded lifecycle
  for incremental observation; duplex input needs an explicit separate contract.
- [`vnext-oneshot-producer.ts`](../plugins/kxm/src/vnext-oneshot-producer.ts)
  currently parses the collected output and already rejects prose outcomes.
  Keep strict final validation while emitting intermediate observations.
- [`vnext-harness.ts`](../plugins/kxm/src/vnext-harness.ts) has catalog, auth and
  final usage parsing. Extend the existing owner with versioned capabilities and
  separate stream codecs; do not create a conflicting inventory.
- [`vnext-pi-producer.ts`](../plugins/kxm/src/vnext-pi-producer.ts) has a live RPC
  session but permissive outcome inference. Bring its final-result handling into
  agreement with the one-shot contract before comparing adapters.
- [`subagent-control.ts`](../plugins/kxm/src/subagent-control.ts) and the
  [steering plan](plan-agent-communication-steering.md) are starting seams;
  persistence, native delivery and recovery still need end-to-end evidence.
- [`scripts/harness-run.mjs`](../scripts/harness-run.mjs) remains a development
  helper. Its successful invocations cannot stand in for Phase 11 product-adapter
  admission or hub peer evidence.

Conclusion: structured streaming is a well-supported near-term investment.
Exact working-directory/session control is equally important for correctness.
Codex app-server is the strongest locally schema-verified new live-control
candidate; Claude channels, Kimi Wire and Hermes ACP remain gated investigations.
