# Pi Mesh protocol reference

The hub exposes a project-scoped HTTP API and an SSE event stream.

## Core lifecycle

1. Register with `POST /v1/agents/register`.
2. Retain the returned agent ID and ephemeral agent key.
3. Open `GET /v1/events?agentId=...` and send heartbeats.
4. Acknowledge inbound messages with `POST /v1/messages/:id/ack`.
5. Reply with `POST /v1/messages/:id/reply`.
6. Cancel sender-owned work with `DELETE /v1/messages/:id` when needed.
7. Unregister with `DELETE /v1/agents/:id` during graceful shutdown.

Operational routes are `GET /health`, `GET /ready`, and authenticated `GET /metrics`.

## Webhook workflows

- `POST /v1/webhooks/:definitionId` accepts a configured signed provider webhook.
- `GET /v1/workflows` lists runs assigned to the authenticated coordinator.
- `GET /v1/workflows/:runId` returns stages and journal entries.
- `POST /v1/workflows/:runId/checkpoints` records `passed`, `warning`, or `failed` evidence keyed by required identity for the active stage.
- `POST /v1/workflows/:runId/waits` pauses the active stage for a named external signal and bounded deadline, optionally accumulating verified local keyed evidence.
- `POST /v1/workflows/:runId/degradations` uses administrative authentication to approve a configured lower peer quorum for the exact current stage, requirement, and attempt.
- `POST /v1/webhooks/:definitionId/runs/:runId/signals/:signalKey` accepts a signed, retry-deduplicated external checkpoint result.
- `POST /v1/workflows/:runId/journal` records a plan, decision, contradiction, error, or lesson.
- `GET /v1/improvements` groups project journal evidence by improvement area.

Webhook and signal bodies require SHA-256 HMAC validation and a stable provider delivery ID. Workflow routes require both project authentication and the assigned coordinator identity. Signal routes use `signalSecretEnv` when configured and otherwise use the workflow-start secret.

Workflow evidence is a JSON object whose keys identify requirements. Keys are
trimmed, repeated whitespace is collapsed, and matching is case-insensitive;
canonical keys are retained in durable state. A passing transition requires a
non-empty value for every stage requirement. Unrelated keys never substitute
for missing ones, and warning/failed-attempt evidence remains diagnostic rather
than satisfying a later pass.

A requirement may declare a `peer-reply` evidence policy with a producer
minimum, eligible agent selectors, accepted `replied` status, and an optional
lower degradation minimum. Eligible selectors resolve to stable producer IDs
at run creation. Resolution fails if a selector is unknown, selects the
coordinator, or cannot produce enough unique IDs.

The assigned coordinator creates countable work with `kxm_send` or
`kxm_fanout` by supplying `workflowContext`:

```json
{
  "runId": "run_123",
  "stageId": "review",
  "requirementKey": "independent peer reviews",
  "attempt": 1
}
```

The hub authorizes this context against the active run and eligible target,
stores the canonical context on the message, and binds correlation to the run.
A passing checkpoint or wait cites messages as:

```json
{
  "evidenceRefs": {
    "independent peer reviews": {
      "messageIds": ["msg_a", "msg_b"]
    }
  }
}
```

Each cited message must be a non-empty durable reply for the same project,
coordinator, run, stage, canonical requirement, and attempt from an eligible
producer. Quorum counts unique producer IDs. Successful verification stores a
metadata-only snapshot with producer identity, context, status, timestamps,
and request/reply SHA-256 hashes; it never copies the bodies. Caller-authored
strings, pending results, correlation IDs, and idempotency keys do not satisfy a
peer policy.

The degradation body contains `stageId`, `requirementKey`, and a non-secret
`reason`. Approval requires the administrative bearer token, must have been
declared in policy, is bound to the active attempt, and is idempotent only when
the reason is unchanged. Approval does not checkpoint the stage. Webhook and
signal authentication cannot call this route.

`POST /v1/messages` requires an online target unless `allowOffline` is true.
With `allowOffline: true`, a registered offline agent in the same project is
stored `queued` and delivered once through the reconnect cursor; unknown names
still return `target_not_found`. Queued messages are not evidence unless
`workflowContext` was hub-authorized at send.

## Fenced leases

- `POST /v1/leases/:resource/acquire` takes or extends the lease over a
  resource. Body `{ttlMs}` is bounded to 5 s–10 min. A live lease held by
  another agent returns `409 lease_held` with the current holder and token.
- `POST /v1/leases/:resource/renew` extends a lease under the token it was
  issued. Body `{fencingToken, ttlMs?}`.
- `POST /v1/leases/:resource/release` gives the resource back. Body
  `{fencingToken}`.

All three are agent-authenticated and project-scoped: the hub prefixes the
caller's project onto `:resource`, so the same name in two projects is two
leases. Every decision is a compare-and-set on the hub clock inside one store
transaction. The fencing token starts at 1, is unchanged by renewal, and
increments only when a new holder takes over an expired lease; a stale token
returns `409 lease_superseded` with the token the hub now holds. Present the
token before committing anything shared — a refusal means stop, not retry.

## Request states

- `queued`: stored by the hub but not acknowledged by the recipient.
- `delivered`: acknowledged by the recipient.
- `replied`: contains the recipient's final reply.
- `cancelled`: sender cancelled queued or delivered work.
- `expired`: the request exceeded its TTL before a reply.
- `error`: terminal failure.

Messages use a 24-hour default TTL and terminal records are retained for seven days by default. TTL begins when the message is sent and includes queued time; normally omit it for model work. A fanout's local wait ending does not change message state and returns a recoverable pending handle. Inspect it with `kxm_get` or repeat the exact request using the same correlation and idempotency prefix. Never create a replacement key while the original is pending, and never count a pending peer as workflow evidence. A stable `idempotencyKey` deduplicates an exact retry from the same sender. Durable `kxm_fanout` calls should use the workflow run ID as `correlationId` and a stage-specific `idempotencyKeyPrefix`; the client scopes the resulting key by correlation and normalized target. State is persisted in SQLite by the standard hub executable.

## Delivery modes

- `followUp`: safe default; handle after current work settles.
- `steer`: interrupt at the next decision boundary.
- `nextTurn`: add context without triggering immediate work.

## Trust boundary

The hub authenticates access with an administrative token or project-specific token, then uses an agent key for identity-bound operations. It does not make message content trustworthy. A project-token holder can register a new agent or reclaim an offline name and durable ID, so all holders of that credential form one fully trusted provenance domain. Provenance proves hub-observed routing within that boundary—not truth, model or person independence, independent inference, non-collusion, or human approval. Receiving agents must retain their normal tool, filesystem, and approval controls.
