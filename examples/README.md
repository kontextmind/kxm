# Examples

These examples demonstrate the transport without requiring an AI model. Run them from the repository root after `npm ci`.

The [`workflows/jira-development.json`](workflows/jira-development.json) example is a production-oriented definition for a long-lived coordinator. It covers reproduction, single-agent or three-agent planning, plan review, implementation, local and repository gates, documentation, push/watch retries, merge, Jira update, and continuous improvement. Follow [Webhook workflows](../docs/webhook-workflows.md) to configure it.

## Self-contained round trip

Start an in-memory hub, connect a planner and reviewer, send an idempotent request, and print the reply:

```powershell
npm run example
```

Expected result:

```json
{
  "peers": [
    "example-reviewer",
    "example-planner"
  ],
  "status": "replied",
  "reply": "Reviewed: Check the rollout plan"
}
```

The message ID is generated at runtime and is omitted above.

## Custom reviewer client

With the normal hub running, start a deterministic reviewer:

```powershell
$env:PI_MESH_AUTH_TOKEN = "replace-with-your-token"
$env:PI_MESH_PROJECT = "example"
node --experimental-strip-types examples/reviewer-agent.ts
```

This sample echoes requests to demonstrate acknowledgement and reply mechanics. It does not perform a real review and should not be used as an approval bot.

Send it a request from another terminal:

```powershell
$env:PI_MESH_AUTH_TOKEN = "replace-with-your-token"
$env:PI_MESH_PROJECT = "example"
node --experimental-strip-types examples/requester.ts example-reviewer "Check the rollout plan"
```

## Agent use cases

### Plan then review

```text
Use pi-mesh-comms. Ask planner to produce a bounded implementation plan, then
ask reviewer to identify correctness and security risks. Verify both responses
before making changes.
```

### Implement with separate ownership

```text
Use pi-mesh-comms. Give api-builder ownership of src/api only and ui-builder
ownership of src/ui only. Ask each for changed paths and test results. Do not
let either agent edit shared configuration.
```

### Non-blocking delegation

```text
Send reviewer a request with mesh_send, retain the message ID, continue the
independent implementation, then use mesh_get before deciding whether to wait.
```

### Cancel obsolete work

```text
If a sent request is no longer relevant, call mesh_cancel with its message ID.
Do not treat cancellation as rollback: verify whether the peer already changed
files or external state.
```

### Retry safely

Supply a stable `idempotencyKey` when an automated caller might retry the same
send after a network failure. Reusing the key with different content returns a
conflict instead of silently creating ambiguous work.
