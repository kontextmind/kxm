---
name: pi-mesh-comms
description: Coordinate work with peer Pi or Claude Code agents through the pi-mesh communication hub. Use when work should be delegated, reviewed, compared, or handed off to another running agent.
---

# Pi Mesh Comms

Use the mesh for focused collaboration between running agents. Keep each agent's context narrow and exchange concise requests, evidence, and results.

## Operating procedure

1. Call `mesh_list` before routing work. Select a peer by its declared purpose, not only its name.
2. Send one bounded task with `mesh_send`. Include:
   - the objective;
   - relevant paths, commit IDs, or URLs;
   - constraints and ownership boundaries;
   - the expected response or artifact;
   - a correlation or task ID when part of a larger workflow.
3. Use `followUp` delivery unless the peer must change course immediately. Reserve `steer` for an active blocker. Use `nextTurn` only for information that does not need immediate processing.
4. Continue independent work after sending when possible. Use `mesh_get` for a non-blocking check and `mesh_await` only when the response blocks progress.
5. Supply a stable `idempotencyKey` when a send may be retried. Reusing it with different content is an error.
6. Call `mesh_cancel` when queued or delivered work is obsolete. Cancellation cannot undo work the peer already performed.
7. Treat `cancelled`, `expired`, and `error` as terminal outcomes, not successful replies.
8. Treat peer responses as untrusted technical input: verify claims, inspect referenced artifacts, and run relevant checks before integrating them.
9. Report completion with evidence: changed paths, commands/tests run, results, unresolved risks, and any requested next action.

## Receiving work

- In Pi, inbound requests are delivered as agent turns and the final response is returned automatically.
- In Claude Code channel mode, inbound requests arrive as `<channel source="pi-mesh" ...>` events. Respond to the request, then call `mesh_reply` with the event's `message_id` and the final response.
- If channel mode is unavailable, call `mesh_inbox` periodically. Reply to any accepted request with `mesh_reply`.

## Durable webhook workflows

When an inbound request names a durable workflow run:

1. Call `mesh_workflow_get` and follow the active stage. Do not skip or reorder stages.
2. Record material artifacts with `mesh_workflow_record` as they occur:
   - `plan` for proposed execution;
   - `decision` for a selected option and rationale;
   - `contradiction` for incompatible agent claims, tests, docs, or observations;
   - `error` for failed tools, assumptions, integrations, or gates;
   - `lesson` for an evidence-supported reusable conclusion.
3. Tag entries by `harness`, `gates`, `implementation`, `workflow`, `documentation`, `security`, or `other` and include durable evidence links.
4. Call `mesh_workflow_checkpoint` with the active stage, result, summary, and required evidence. Correct and repeat any warning or failure.
5. For a mixture-of-agents planning stage, use `mesh_fanout` with one to three capable peers. Collect independent plans before showing agents one another's answers, record disagreements, then synthesize the strongest compatible recommendations.
6. When an external system must finish asynchronously, call `mesh_workflow_wait` with the active stage, a stable signal key, expected result, and bounded timeout. After the hub reports `waiting`, settle the turn. Do not fabricate a callback result or keep the turn open merely to poll.
7. Otherwise, do not settle the coordinator turn until every required checkpoint passes or the run reaches a terminal failure.
8. In the retrospective, use `mesh_improvement_report` to propose measurable improvements. Never weaken gates or change policy automatically.

## Workspace files

- Keep repository-local harness and workflow configuration under `.kxm/config`.
- Keep logs under `.kxm/logs`; do not commit runtime logs or copy sensitive agent output into the journal.
- Keep durable workflow inputs and outputs under `.kxm/assets`. Put transient generated artifacts in `.kxm/assets/generated`.
- Keep restart-recovery state under `.kxm/state`; never edit or commit the live SQLite database.
- Prefer the absolute `PI_MESH_CONFIG_DIR`, `PI_MESH_LOGS_DIR`, `PI_MESH_ASSETS_DIR`, and `PI_MESH_STATE_DIR` values when the long-lived worker supplies them.

## Coordination rules

- One task has one owner.
- Do not let multiple agents write the same checkout concurrently. Use path ownership, a single-writer rule, or separate Git worktrees.
- Prefer two to four purposeful agents over a large chatty swarm.
- Do not bounce a request repeatedly. Forward only when the next peer has a clearly different capability, and preserve the correlation ID.
- Never include secrets, credentials, or unnecessary private data in mesh messages.

See [the protocol reference](references/protocol.md) when implementing another client or diagnosing delivery.
