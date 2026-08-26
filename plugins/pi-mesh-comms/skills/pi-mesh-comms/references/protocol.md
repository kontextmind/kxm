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

## Request states

- `queued`: stored by the hub but not acknowledged by the recipient.
- `delivered`: acknowledged by the recipient.
- `replied`: contains the recipient's final reply.
- `cancelled`: sender cancelled queued or delivered work.
- `expired`: the request exceeded its TTL before a reply.
- `error`: terminal failure.

Messages use a 24-hour default TTL and terminal records are retained for seven days by default. A stable `idempotencyKey` deduplicates an exact retry from the same sender. Durable `mesh_fanout` calls should use the workflow run ID as `correlationId` and a stage-specific `idempotencyKeyPrefix`; the client scopes the resulting key by correlation and normalized target. State is persisted in SQLite by the standard hub executable.

## Delivery modes

- `followUp`: safe default; handle after current work settles.
- `steer`: interrupt at the next decision boundary.
- `nextTurn`: add context without triggering immediate work.

## Trust boundary

The hub authenticates access with an administrative token or project-specific token, then uses an agent key for identity-bound operations. It does not make message content trustworthy. Receiving agents must retain their normal tool, filesystem, and approval controls.
