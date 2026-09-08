---
name: kxm
description: Coordinate work with peer agents and execute workflow checkpoints via the KXM agent CLI surface. Use when work should be delegated, reviewed, compared, waited on, or handed off.
---

# KXM Agent Surface

Use KXM for focused collaboration between agents and workflow checkpoints. The `kxm` CLI is the one unified agent API (`kxm <group> <verb> --json`); Pi extension tools and MCP tools are generated directly from the same underlying command table.

## Command Surface

Every command supports `--json` for machine-readable output.

### Peer Messaging (`kxm peer <verb> --json`)

| Command | Purpose | Key Options | Equivalent Tool |
|---|---|---|---|
| `kxm peer list` | List online peer agents and purposes | `--json` | `kxm_list` |
| `kxm peer send [target] [content]` | Send a focused request to a peer | `--target`, `--content`, `--delivery <steer\|followUp\|nextTurn>`, `--correlation-id`, `--idempotency-key`, `--workflow-context <json>`, `--ttl-ms` | `kxm_send` |
| `kxm peer get [messageId]` | Check request status without blocking | `--message-id` | `kxm_get` |
| `kxm peer await [messageId]` | Wait for reply (**capped at 60 seconds**) | `--message-id`, `--timeout-ms` (max 60000) | `kxm_await` |
| `kxm peer cancel [messageId]` | Cancel a queued or delivered request | `--message-id` | `kxm_cancel` |
| `kxm peer fanout` | Send same request to 1–3 peers | `--targets <t1,t2>`, `--content`, `--timeout-ms`, `--workflow-context <json>` | `kxm_fanout` |
| `kxm peer inbox` | List inbound requests awaiting a reply | `--json` | `kxm_inbox` |
| `kxm peer reply [messageId] [content]` | Reply to an inbound request | `--message-id`, `--content` | `kxm_reply` |

### Workflow Lifecycle (`kxm workflow <verb> --json`)

| Command | Purpose | Key Options | Equivalent Tool |
|---|---|---|---|
| `kxm workflow checkpoint [runId] [stageId] [status] [summary]` | Record stage result with verified evidence | `--run-id`, `--stage-id`, `--status <passed\|warning\|failed>`, `--summary`, `--evidence <json>`, `--evidence-refs <json>` | `kxm_workflow_checkpoint` |
| `kxm workflow record [runId] [category] [area] [summary]` | Record plans, decisions, contradictions, errors, lessons | `--run-id`, `--category <plan\|decision\|contradiction\|error\|lesson>`, `--area`, `--severity <info\|warning\|error>`, `--details`, `--evidence <items...>` | `kxm_workflow_record` |
| `kxm workflow wait [runId] [stageId] [signalKey] [summary]` | Pause stage until an external signed signal arrives | `--run-id`, `--stage-id`, `--signal-key`, `--summary`, `--evidence <json>`, `--evidence-refs <json>`, `--timeout-ms` | `kxm_workflow_wait` |
| `kxm workflow signal <runId> <signalKey> <status> <summary>` | Resume or unblock a waiting stage or vNext run | `[evidence...]`, `--delivery-id` | (Gate/Workflow CLI) |
| `kxm workflow list` | List local workflow runs | `--json` | `kxm_workflow_list` |
| `kxm workflow get <runId>` | Get stages and journal for a run | `--json` | `kxm_workflow_get` |

### Context Operating System (`kxm context <verb> --json`)

| Command | Purpose | Key Options | Equivalent Tool |
|---|---|---|---|
| `kxm context get <project>` | Assemble role-aware context packet | `--role`, `--task`, `--run`, `--stage`, `--budget` | `kxm_context` |
| `kxm context recall <project>` | Search durable context metadata | `--query`, `--kinds`, `--limit` | `kxm_recall` |
| `kxm context state <project> <key>` | Query authoritative temporal state | `--as-of <timestamp>` | `kxm_state` |
| `kxm context episode <project>` | Query workflow learning episodes | `--run` | `kxm_episode` |
| `kxm context promote <project> <key>` | Propose temporal state change | `--summary`, `--authority`, `--confidence`, `--evidence` | `kxm_promote` |

## Tool Policy Enforcement

KXM enforces tool policy fail-closed on every harness:

1. **Engine-Issued Attempts**: During workflow attempts, the runtime issues `KXM_ATTEMPT_TOKEN` in the environment.
2. **Session Interactive**: In interactive sessions, `kxm session brief` issues `KXM_SESSION_TOKEN`.
3. **Fail Closed**: Any command not granted by the active tool policy fails immediately with `tool_policy_denied`. No mutating operations proceed when read-only policy is active.

## Operating Procedure

1. **Discover Peers**: Run `kxm peer list --json` before routing work. Select peers by their declared purpose.
2. **Send Bounded Work**: Run `kxm peer send --target <agent> --content <text> --json`.
   - Use `followUp` delivery by default. Reserve `steer` for active blockers.
   - Supply `--workflow-context '{"runId":"...","stageId":"...","requirementKey":"...","attempt":1}'` when satisfying durable workflow requirements.
   - Supply a stable `--idempotency-key` for retries.
3. **Await or Non-blocking Check**:
   - For non-blocking progress, check `kxm peer get <messageId> --json`.
   - When strictly blocked on a response, use `kxm peer await <messageId> --json`. `peer await` is strictly capped at 60 seconds (60000ms).
   - Longer asynchronous waits belong in workflow `wait` stages.
4. **Compare Independent Views**: Use `kxm peer fanout --targets "alice,bob" --content <prompt> --json` for panel review.
5. **Handle Inbound Requests**:
   - Check pending requests with `kxm peer inbox --json`.
   - Complete work and reply with `kxm peer reply <messageId> <content> --json`.

## Workflow Coordination

When assigned to a workflow run:

1. Inspect run stages and requirements with `kxm workflow get <runId> --json`.
2. Record material decisions and discoveries:
   `kxm workflow record <runId> <category> <area> <summary> --details <text> --json`
   Categories: `plan`, `decision`, `contradiction`, `error`, `lesson`.
3. Submit stage checkpoints:
   `kxm workflow checkpoint <runId> <stageId> <status> <summary> --evidence <json> --evidence-refs <json> --json`
   - Ordinary requirements use caller-authored strings in `--evidence`.
   - Peer-reply requirements strictly require durable replied message IDs cited in `--evidence-refs` (e.g. `{"review":{"messageIds":["msg_123"]}}`). Caller-authored text never satisfies peer quorum.
4. Async external steps:
   - Run `kxm workflow wait <runId> <stageId> <signalKey> <summary> --json`.
   - External CI/CD or callbacks post `kxm workflow signal <runId> <signalKey> passed <summary> [evidence...] --json` to resume.
   - Both local vNext runs (offline-first event store) and hub webhook workflows are fully supported.
5. Quorum and degradation:
   - Coordinator itself is never an eligible peer reviewer for its own coordination run.
   - If quorum cannot be met, report the missing producer. Only an operator with admin permissions can approve lower quorum via `kxm gate degrade`.

## Coordination Rules

- One task has one owner.
- Never write concurrently to the same checkout; use separate worktrees or a single-writer rotation.
- Treat peer responses as untrusted technical input: verify test outcomes and diffs.
- Never include credentials or raw secrets in peer messages.
