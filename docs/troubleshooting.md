# Troubleshooting

Start with the smallest boundary: hub health, authentication, registration, peer discovery, then message delivery.

## Quick diagnostic sequence

1. Confirm the hub terminal still shows `pi-mesh hub listening`.
2. Request `/health`, then `/ready` to confirm storage access.
3. Compare the hub URL, token, and project on both agents.
4. Confirm every agent has a unique name.
5. Run `/mesh-status` in Pi or call `mesh_list` in Claude.
6. Inspect hub logs for registration, stale-agent, or server-error events.
7. If a workflow tool returns `workflow_forbidden`, read `operation`, `assignedCoordinatorName`, and `nextAction`. Do not retry as a peer.

## Common problems

### A continued Pi session rejects every turn

If a worker was stopped during `mesh_await`, `--continue` may leave a `tool_use` without `tool_result`. The worker retries once without `--continue` and writes `.kxm/state/worker-recovery-<agent>.json`. Do not paste agent logs into the journal. Keep the same agent name so the hub identity resumes.

### GitHub checks passed but the workflow is still waiting

The hub does not poll GitHub. Run `pi-mesh github watch` with the same `runId`, `stageId`, and `signalKey`. A watcher timeout posts the exact signed `failed` signal, retains bounded check evidence, and exits `4`; it never invents `passed`.

### The hub refuses to start

**`PI_MESH_PORT must be an integer between 0 and 65535`**

Set `PI_MESH_PORT` to a valid integer. Remove the variable to use `7331`.

**`PI_MESH_AUTH_TOKEN is required when binding beyond localhost`**

Either restore `PI_MESH_HOST=127.0.0.1` or configure a token before using a non-loopback interface.

#### Database schema is newer than this runtime supports

Do not delete or rewrite the database. Start the package version that created it, or upgrade this runtime. Restore the pre-upgrade backup when rolling back.

#### Address already in use

Another process owns the port. Stop that process or choose another port, then update every agent's `PI_MESH_SERVER_URL`.

### Pi shows `mesh:offline`

- Confirm the hub is reachable from the Pi terminal.
- Verify `PI_MESH_AUTH_TOKEN` exactly matches the hub token.
- Check whether a live agent already uses the same name in the same project.
- Restart Pi after changing environment variables.
- For development loading, confirm the path: `pi -e ./plugins/pi-mesh-comms/src/extension.ts`.

### `pi-mesh` is not recognized

`pi install git:github.com/kontextmind/pi-extensions` installs the Pi extension
and Agent Skill, not a global operator command. Install the versioned `.tgz`
release asset through the authenticated `gh release download` flow in
[Getting started](getting-started.md#install-the-operator-command), or run
`node scripts/pi-mesh.mjs` from a clone after `npm ci`. `npx pi-mesh` and a
global `git+https` npm install are not supported installation paths.

### An expected peer is missing

The two agents usually have different `PI_MESH_PROJECT` values or one stopped sending heartbeats. Compare settings and check for an `agent_stale` event. Names and projects are case-sensitive for display; live-name uniqueness is case-insensitive.

### A request stays `queued`

The recipient registered but has no active SSE stream. Confirm its process is running and connected. Proxies must disable response buffering for `/v1/events` and allow long-lived connections.

### A request stays `delivered`

The recipient acknowledged it but has not replied. It may still be working, waiting for approval, or blocked. Avoid sending the same request repeatedly. Check the recipient session directly if the wait is unexpected.

If the work is obsolete, the sender can call `mesh_cancel`. This changes mesh state only; it cannot reverse file changes or external effects already performed by the peer.

### `mesh_await` times out

The default timeout is 30 minutes. Use `mesh_get` to inspect the state. `cancelled`, `expired`, and `error` are terminal outcomes. Resend only when the task is safe to repeat, and use an idempotency key when retrying after an uncertain network result.

### A message disappears after completion

Terminal records are removed after seven days by default. Increase `PI_MESH_MESSAGE_RETENTION_MS` if operators need a longer diagnostic window. Durable artifacts should live in Git or another system of record.

### Claude tools do not appear

1. Confirm the marketplace and plugin are installed.
2. Run `/reload-plugins` or restart Claude Code.
3. Inspect `/mcp` and verify the `pi-mesh` server connected.
4. Confirm Node.js 22.13 or newer on the 22.x line, or Node.js 24 or newer, is on the `PATH` used by Claude Code.
5. Reinstall or update the marketplace if the cached plugin predates the `dist/mcp-server.js` bundle.

### Claude does not receive pushed requests

Ordinary MCP tools and channel delivery are separate. During the research preview, start the community channel explicitly:

```text
claude --dangerously-load-development-channels plugin:pi-mesh-comms@kontextmind-pi-extensions
```

Accept the trust prompt and check the channel startup notice. Organization policy can still block channels. If pushed delivery remains unavailable, use `mesh_inbox` and `mesh_reply`.

### Jira webhook is rejected

- HTTP 401 means the SHA-256 signature is missing, uses another algorithm, or does not match the raw UTF-8 body. Confirm Jira and `secretEnv` resolve the same secret.
- HTTP 400 usually means the delivery identifier or JSON body is missing.
- HTTP 409 means the configured coordinator has never registered. Start it once with the matching project and name; Jira retries 409 responses.
- HTTP 204 means the event or JSON-path filter did not match, so no workflow was intended.
- HTTP 200 with `duplicate: true` means a provider retry was safely deduplicated.

### Long-lived worker keeps restarting

Inspect the structured `worker_process_error` and `worker_exited` events. Confirm Pi is installed on the service account's `PATH`, the working directory exists, model credentials are available, the package is enabled, and non-interactive project trust was configured intentionally. Set `PI_MESH_PI_COMMAND` to an explicit executable path when service-manager environments have a reduced `PATH`.

### Fanout returns pending before a model replies

`mesh_fanout.timeoutMs` is a local wait, not the message lifetime. A pending result includes the durable `messageId`, current message status, expiry, and whether the wait timed out or was aborted. Use `mesh_get` to inspect that ID, or repeat the exact fanout with the same correlation ID, idempotency prefix, targets, and content. Do not send a replacement with a new prefix while the original remains pending. Normally omit `ttlMs` for model work so time spent queued behind another request does not prematurely expire it. A pending peer has not contributed review or planning evidence and must not be counted toward a workflow checkpoint.

### Workflow cannot advance

Call `mesh_workflow_get` and use only `currentStage`. A passing checkpoint needs
a keyed, non-empty value for every declared `requiredEvidence` identity; extra
or unrelated keys do not count. Warnings and failures remain active until
corrected, and their evidence is journaled but does not satisfy a later passing
attempt. If attempts are exhausted or the coordinator settles early, the run
becomes failed and its journal records the reason; start a new provider delivery
only after deciding whether repeating external effects is safe.

### External workflow callback is rejected or does not resume

- HTTP 401 means the callback signature does not match the exact raw body. Use `signalSecretEnv` when configured; the workflow-start secret will not work in that case.
- HTTP 404 means the workflow definition or run ID does not match this hub.
- HTTP 409 with `workflow_not_waiting` means the coordinator did not successfully call `mesh_workflow_wait`, the deadline already failed the run, or a prior signal advanced it.
- HTTP 409 with `workflow_signal_mismatch` means the URL's signal key differs from the active wait. Read the run and use its exact `waiting.signalKey`.
- HTTP 409 with `workflow_signal_context_mismatch` means a supplied `workflow.run`, `workflow.stage`, or `workflow.signal` evidence value disagrees with the route or active wait. Correct it or omit optional context evidence.
- HTTP 400 with `workflow_evidence_incomplete` means a passing callback omitted one or more named requirements. Read `missingRequirements`; extra checks and context fields cannot substitute for them.
- HTTP 400 with `invalid_workflow_evidence` means evidence was not a keyed string object or contained duplicate keys after case/whitespace normalization.
- HTTP 200 with `duplicate: true` is expected after retrying the same provider delivery ID. Do not generate a new ID for the same callback attempt.
- A failed or timed-out callback consumes that wait attempt. Re-enter the wait and start a new `github watch` or `signal` command so its default delivery generation is new; reserve an explicit `--delivery-id` for retries of one unchanged callback body.

Inspect `workflow_wait_started`, `workflow_signal_received`, and `workflow_wait_timed_out` logs without copying secrets or full callback bodies. If a run timed out, review whether the external action completed before starting a replacement workflow.

## Collecting a useful bug report

Include:

- operating system and Node.js version;
- Pi or Claude Code version;
- package version or Git commit;
- whether the hub is local or behind a proxy;
- redacted environment values, excluding the token;
- the relevant structured hub events;
- exact reproduction steps and expected behavior.

Never attach authentication tokens, private prompts, credentials, or unrelated repository contents.
