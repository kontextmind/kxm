# Troubleshooting

Start with the smallest boundary: hub health, authentication, registration, peer discovery, then message delivery.

## Quick diagnostic sequence

1. Confirm the hub terminal still shows `kxm hub listening`.
2. Request `/health`, then `/ready` to confirm storage access.
3. Compare the hub URL, token, and project on both agents.
4. Confirm every agent has a unique name.
5. Run `/kxm hub` in Pi or call `kxm_list` in Claude.
6. Inspect hub logs for registration, stale-agent, or server-error events.
7. If a workflow tool returns `workflow_forbidden`, read `operation`, `assignedCoordinatorName`, and `nextAction`. Do not retry as a peer.

## Common problems

### A continued Pi session rejects every turn

If a worker was stopped during `kxm_await`, `--continue` may leave a `tool_use` without `tool_result`. The worker retries once without `--continue` and writes a project-and-agent identity-keyed recovery envelope under `.kxm/state`. Do not paste agent logs into the journal. Keep the same project and agent name so the hub identity and recovery key resume.

### A model quota or provider error settles the agent

KXM waits until Pi has exhausted its own automatic retries. It then keeps the inbound message in `delivered` state, records an allowlisted `quota` or `provider_error` diagnostic without the provider body, and restarts the RPC child. Configure `KXM_WORKER_FALLBACK_MODELS` (or `--fallback-models`) to rotate immediately; otherwise the worker retries after `KXM_WORKER_PROVIDER_RETRY_MS`. Keep continuation enabled so finished peer calls and tool results survive the model switch. Use `--fresh-start`, not `--no-continue`, when only the first launch must avoid old session state.

### A worker heartbeat is healthy but one tool never finishes

Set `KXM_WORKER_TOOL_TIMEOUT_MS` above the longest legitimate tool call. Its 31-minute default intentionally gives a 30-minute `kxm_await` or `kxm_fanout` time to return durable pending handles before supervision intervenes. When that bound is exceeded, the structured worker log records `worker_tool_timeout` with only the allowlisted tool name and diagnostic class, the delivered hub request stays recoverable, and the RPC process is restarted. If the stuck worker was supposed to be read-only, also set `KXM_WORKER_TOOLS=read,grep,find,ls`; prompt wording alone does not remove shell or write capabilities.

### A hub or worker PID claim is stale

Version 0.4.3 prevents a second wrapper from replacing a live hub or worker claim. `kxm hub stop` ignores an invalid, non-running, or ownership-mismatched record rather than guessing. If a crash or pre-0.4.3 process left one behind, inspect the exact `.pid` JSON and verify that its recorded PID is no longer running; for a hub, also verify the configured port has no listener. Then remove only that exact `.pid` and its recorded `.stop` control file before relaunching once. Worker filenames include a project/agent identity digest and their records include the exact names and generation, so do not substitute a similarly sanitized filename. Never delete the `.kxm/state` directory or SQLite database to clear a claim.

### GitHub checks passed but the workflow is still waiting

The hub does not poll GitHub. Run `kxm gate github watch` with the same `runId`, `stageId`, and `signalKey`. A watcher timeout posts the exact signed `failed` signal, retains bounded check evidence, and exits `4`; it never invents `passed`.

### The hub refuses to start

**`KXM_PORT must be an integer between 0 and 65535`**

Set `KXM_PORT` to a valid integer. Remove the variable to use `7331`.

**`KXM_AUTH_TOKEN is required when binding beyond localhost`**

Either restore `KXM_HOST=127.0.0.1` or configure a token before using a non-loopback interface.

#### Database schema is newer than this runtime supports

Do not delete or rewrite the database. Start the package version that created it, or upgrade this runtime. Restore the pre-upgrade backup when rolling back.

#### Address already in use

Another process owns the port. Stop that process or choose another port, then update every agent's `KXM_SERVER_URL`.

### Pi shows `hub:off`

- Confirm the hub is reachable from the Pi terminal.
- Verify `KXM_AUTH_TOKEN` exactly matches the hub token.
- Check whether a live agent already uses the same name in the same project.
- Restart Pi after changing environment variables.
- For an exact development load, use `pi --no-extensions -e ./plugins/kxm/src/extension.ts`. Add every required provider extension with another `-e`; otherwise Pi discovery is intentionally disabled.
- For long-lived workers, set the reviewed `KXM_WORKER_EXTENSION_PATHS` and `KXM_WORKER_SKILL_PATHS` described in [Configuration](configuration.md#long-lived-worker-settings). Invalid paths fail before supervision instead of entering a restart loop.

### Pi update fails looking for `refs/heads/master`

The KXM default branch is `main`. An older Pi git checkout still tracking
`master` fails with `couldn't find remote ref refs/heads/master`. Remove the
package and reinstall with an explicit ref:

```text
pi remove git:github.com/kontextmind/kxm
pi install git:github.com/kontextmind/kxm@main
```

### `kxm --help` prints a former flat command list

If the installed `kxm --help` prints `validate | status | hub | worker | stop | …`
instead of the current Commander groups, the committed `plugins/kxm/dist/cli.js`
is stale. Run `npm run build` and commit the generated `dist` so the operator
CLI matches source.

### `kxm` is not recognized

`pi install git:github.com/kontextmind/kxm@main` installs the Pi extension
and Agent Skill, not a global operator command. Install the versioned `.tgz`
release asset through the authenticated `gh release download` flow in
[Getting started](getting-started.md#install-the-operator-command), or run
`node scripts/kxm.mjs` from a clone after `npm ci`. `npx kxm` and a
global `git+https` npm install are not supported installation paths.

### An expected peer is missing

The two agents usually have different `KXM_PROJECT` values or one stopped sending heartbeats. Compare settings and check for an `agent_stale` event. Names and projects are case-sensitive for display; live-name uniqueness is case-insensitive.

### A request stays `queued`

The recipient registered but has no active SSE stream. Confirm its process is running and connected. Proxies must disable response buffering for `/v1/events` and allow long-lived connections.

### A request stays `delivered`

The recipient acknowledged it but has not replied. It may still be working, waiting for approval, or blocked. Avoid sending the same request repeatedly. Check the recipient session directly if the wait is unexpected.

If the work is obsolete, the sender can call `kxm_cancel`. This changes hub state only; it cannot reverse file changes or external effects already performed by the peer.

### `kxm_await` times out

The default timeout is 30 minutes. Use `kxm_get` to inspect the state. `cancelled`, `expired`, and `error` are terminal outcomes. Resend only when the task is safe to repeat, and use an idempotency key when retrying after an uncertain network result.

### A message disappears after completion

Terminal records are removed after seven days by default. Increase `KXM_MESSAGE_RETENTION_MS` if operators need a longer diagnostic window. Durable artifacts should live in Git or another system of record.

### Claude tools do not appear

1. Confirm the marketplace and plugin are installed.
2. Run `/reload-plugins` or restart Claude Code.
3. Inspect `/mcp` and verify the `kxm` server connected.
4. Confirm Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer, is on the `PATH` used by Claude Code.
5. Reinstall or update the marketplace if the cached plugin predates the `dist/mcp-server.js` bundle.

### Claude does not receive pushed requests

Ordinary MCP tools and channel delivery are separate. During the research preview, start the community channel explicitly:

```text
claude --dangerously-load-development-channels plugin:kxm@kxm
```

Accept the trust prompt and check the channel startup notice. Organization policy can still block channels. If pushed delivery remains unavailable, use `kxm_inbox` and `kxm_reply`.

### Jira webhook is rejected

- HTTP 401 means the SHA-256 signature is missing, uses another algorithm, or does not match the raw UTF-8 body. Confirm Jira and `secretEnv` resolve the same secret.
- HTTP 400 usually means the delivery identifier or JSON body is missing.
- HTTP 409 means the configured coordinator has never registered. Start it once with the matching project and name; Jira retries 409 responses.
- HTTP 204 means the event or JSON-path filter did not match, so no workflow was intended.
- HTTP 200 with `duplicate: true` means a provider retry was safely deduplicated.

### Long-lived worker keeps restarting

Inspect the structured `worker_process_error` and `worker_exited` events. Confirm Pi is installed on the service account's `PATH`, the working directory exists, model credentials are available, the package is enabled, and non-interactive project trust was configured intentionally. Set `KXM_PI_COMMAND` to an explicit executable path when service-manager environments have a reduced `PATH`.

### A workflow message stays queued while the worker restarts once

This is normally the safe session-routing handshake. With `--session-isolation workflow`, a message for a different run is deliberately not acknowledged in the current Pi context. Look for `worker_session_routed`; the old child must close before one replacement starts with the run-specific `--session-dir`, after which the same message ID replays and advances to `delivered`.

If it repeats, inspect `worker_session_request_rejected` and verify:

- the worker was started through `kxm agent worker` with a valid state directory;
- `KXM_WORKER_SESSION_SCOPE` was not manually set (the supervisor owns it);
- the state directory is writable by only the service account;
- the hub and worker are from the same release; and
- the message has a canonical hub-owned `workflowRunId`, not only a correlation ID.

Do not manually acknowledge the message, edit the route request, copy a run JSONL into `default`, or launch a second worker with the same identity. Those actions defeat context isolation.

### `worker_session_state_recovered` appears

The binding manifest did not match its bounded schema or exact worker owner. The supervisor renamed it to `worker-session-binding-<workerKey>.json.corrupt-<timestamp>` and started the stable default binding rather than guessing a workflow. Read `kxm_workflow_get` for unfinished stages and inspect queued/delivered message IDs. Preserve the quarantined manifest for diagnosis, then re-drive unfinished work from the hub. Repeated corruption suggests disk, antivirus, concurrent-service, or permission problems; confirm only one supervisor owns the exact project/agent PID claim.

### A workflow seems to remember another run

Confirm the worker log says `"sessionIsolation":"workflow"` and the Pi child has a `runs/<exact-runId>` session directory. Isolation is opt-in for upgrade compatibility, and both the CLI and raw supervisor default to `off`. Restart cleanly with `kxm agent worker ... --session-isolation workflow`. The first isolated start intentionally uses fresh scoped storage because KXM cannot safely infer which session in the former shared Pi directory belonged to this worker. Existing content created in a formerly shared Pi session cannot be automatically separated retroactively; treat authoritative workflow journal/assets as the recovery source and start a fresh run-specific history.

### Fanout returns pending before a model replies

`kxm_fanout.timeoutMs` is a local wait, not the message lifetime. A pending result includes the durable `messageId`, current message status, expiry, and whether the wait timed out or was aborted. Use `kxm_get` to inspect that ID, or repeat the exact fanout with the same correlation ID, idempotency prefix, targets, and content. Do not send a replacement with a new prefix while the original remains pending. Normally omit `ttlMs` for model work so time spent queued behind another request does not prematurely expire it. A pending peer has not contributed review or planning evidence and must not be counted toward a workflow checkpoint.

### Workflow cannot advance

Call `kxm_workflow_get` and use only `currentStage`. A passing checkpoint needs
a keyed, non-empty value for every declared `requiredEvidence` identity; extra
or unrelated keys do not count. Warnings and failures remain active until
corrected, and their evidence is journaled but does not satisfy a later passing
attempt. If attempts are exhausted or the coordinator settles early, the run
becomes failed and its journal records the reason; start a new provider delivery
only after deciding whether repeating external effects is safe.

For a requirement with `kind: peer-reply`, inspect
`resolvedEvidencePolicies`, `verifiedEvidence`, and the current attempt. An
ordinary evidence string cannot satisfy it. Every eligible agent must have
registered in the workflow project before the run starts, and a passing
checkpoint must cite durable replied message IDs in `evidenceRefs` before those
source messages reach terminal retention.

Common provenance failures are:

- `workflow_context_forbidden`: the sender is not the run's assigned coordinator;
- `workflow_context_inactive`: the run or stage is not currently running;
- `workflow_context_attempt_mismatch`: use `stage.attempts + 1` and send fresh work after a retry;
- `workflow_evidence_producer_forbidden`: the target is not in the run's snapshotted eligible set;
- `workflow_evidence_policy_missing` or `workflow_evidence_policy_unresolved`: the requirement has no usable resolved peer policy;
- `workflow_provenance_invalid`: a cited message is missing, pending, ineligible, wrong-direction, or bound to another project, run, stage, requirement, or attempt;
- `workflow_evidence_incomplete`: there are fewer unique verified producers than the effective minimum.

Multiple replied messages from one peer count once. Correlation IDs and
idempotency prefixes are retry controls, not provenance. Do not replace a
rejected reference with an unscoped send.

If policy declares a lower `degradation.minProducers`, an operator can inspect
and approve it with `kxm gate --dry-run --json degrade ...` followed by
the same command without `--dry-run`, using the administrative token. Approval
must target the current stage and attempt and does not advance the workflow;
the coordinator must still checkpoint with enough verified references. A
callback, project token, or peer cannot approve degradation.

### `kxm gate degrade` returns HTTP 503 `admin_auth_not_configured`

The hub started without a non-empty `KXM_AUTH_TOKEN`, so no administrative
credential exists for the degradation route. Project tokens deliberately cannot
substitute for it, even when the operator holds every project credential. The
route fails closed and does not create an approval.

Stop the hub gracefully, set a new high-entropy `KXM_AUTH_TOKEN` in the hub
service, retain the explicit `KXM_PROJECT_TOKENS` mapping for workers, and
restart against the same `.kxm/state/kxm.db`. Give the administrative token
only to the operator terminal, never to agents or callbacks. Read the run again
because the current attempt may have changed, run the exact degradation command
with `--dry-run --json`, and then approve the current stage, requirement, and
attempt without `--dry-run`. A restart does not make an earlier-attempt approval
valid for the new attempt.

### External workflow callback is rejected or does not resume

- HTTP 401 means the callback signature does not match the exact raw body. Use `signalSecretEnv` when configured; the workflow-start secret will not work in that case.
- HTTP 404 means the workflow definition or run ID does not match this hub.
- HTTP 409 with `workflow_not_waiting` means the coordinator did not successfully call `kxm_workflow_wait`, the deadline already failed the run, or a prior signal advanced it.
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
