# Troubleshoot KXM

This page is a reference of symptoms, causes and fixes, grouped by area. Start with the quick check, then go to the area that matches: install, hub and authentication, Claude Code, peer messaging, Pi workers, workflows, Runtime runs, context and memory, or operations.

## Start with a quick check

Work from the smallest boundary outward:

1. Run `kxm hub view`. Both `health` and `ready` must be `true`.
2. Compare the hub URL, project and project token on every agent involved (`KXM_SERVER_URL`, `KXM_PROJECT`, and the token or plugin `auth_token`).
3. Confirm every agent has a unique name within its project.
4. List peers: `/kxm hub` in Pi, `kxm_list` in Claude Code, or `kxm peer list`.
5. Read the hub log for `agent_registered`, `agent_stale` and `request_error` events; see [Monitor KXM](monitoring.md#read-the-logs).
6. For a workflow, call `kxm_workflow_get` and work only on its `currentStage`, attempt and required evidence.
7. For Runtime runs, run `kxm runtime status`.

## Install

| Symptom | Cause | Fix |
|---|---|---|
| `kxm: command not found` | Only the Pi package or the Claude Code plugin was installed; neither installs the CLI | `npm install --global --omit=peer @kontextmind/kxm`; see [Install KXM](../start/install.md) |
| `kxm` works in one shell but not in another | npm's global bin directory is not on that shell's `PATH` | Run `kxm completion install` (bash and zsh also get a `PATH` entry), then open a new shell |
| Tab completion does nothing | Completion is not installed for this shell | `kxm completion install --shell bash`, `zsh` or `fish`; it is idempotent, and `--dry-run` previews it |
| Plugin tools fail on start | Node.js is older than 22.19 on the 22.x line, or older than 24 | Install a supported Node.js on the `PATH` the harness uses |

Install the CLI from the npm registry as shown above; [Install KXM](../start/install.md) covers every supported path. Set `KXM_SKIP_COMPLETION_PROMPT=1` to skip the completion offer after `kxm init`.

### `pi update` fails with `couldn't find remote ref refs/heads/master`

The KXM default branch is `main`, and an older Pi checkout still tracks `master`. Remove the package and install it again with an explicit branch:

```bash
pi remove git:github.com/kontextmind/kxm
pi install git:github.com/kontextmind/kxm@main
```

### `kxm harness list` says Claude Code is `not_detected` on Windows

npm installs Claude Code as `claude.cmd` and an extensionless shim, not `claude.exe` on `PATH`. `kxm harness list` retries `claude.exe`, then the package's inner `claude.exe`, then `claude.cmd`, and reports `issues: ["windows_shim"]` when only the shim answered.

If it still reports `not_detected`, confirm that `%AppData%\Roaming\npm` is on the `PATH` of the process that runs `kxm`, then check `claude --version` and `claude auth status`. Assignment dispatch (`just assign`) runs the inner `claude.exe`, and Pi's `node.exe` with `cli.js`, without a shell; it refuses unverified `.cmd` launchers. The same shim miss can affect `pi`.

## Hub and authentication

### The hub refuses to start

| Message | Fix |
|---|---|
| `KXM_PORT must be an integer between 0 and 65535` | Set a valid port, or unset `KXM_PORT` to use `7331` |
| `KXM_AUTH_TOKEN is required when binding beyond localhost` | Set `KXM_HOST=127.0.0.1`, or provide the admin token; see [Deploy KXM](deploy.md#choose-loopback-or-a-network-bind) |
| `KXM hub env file is malformed at <file>` or `does not use schema kxm.hub-env.v1` | Fix the JSON. Removing the file drops every saved token, so start with the full `KXM_PROJECT_TOKENS` map and update all clients |
| `KXM hub is already managed by PID <pid>` | A hub already owns this state directory; run `kxm hub stop` first |
| `EADDRINUSE` (address already in use) | Stop the other process, or choose another `KXM_PORT` and update every client's hub URL |
| `local_state_root_not_absolute` | Make `KXM_STATE_HOME` an absolute path |
| `runtime_schema_newer` | The database came from a newer release; do not delete it; upgrade KXM |
| `runtime_schema_outdated` | The database predates this release; see [Upgrade KXM](upgrade.md#understand-schema-changes) |

### Agents fail with `invalid_auth` after a hub restart

`KXM_PROJECT_TOKENS` replaces the hub's saved project map, and the hub saves the replacement. A start with a one-project value removes every other project, so their agents are refused. Restart the hub with the full map; the merge command in [Start the hub](../start/quickstart-claude-code.md#3-start-the-hub) builds it from the saved file.

### A hub PID claim is stale

KXM refuses to replace a live hub or worker claim, and `kxm hub stop` ignores a claim that is invalid, not running, or owned by someone else rather than guessing. A claim whose wrapper died is reclaimed on the next `kxm hub start`, which first stops an orphaned server child; `kxm hub stop` can stop such an orphan directly.

If a malformed claim remains, read the exact `.pid` JSON in the state directory and confirm its PID is not running and, for a hub, that nothing listens on the port. Then remove only that `.pid` file and its recorded `.stop` control file, and start once. Worker claim names include an identity digest, so do not substitute a similar file name. Never delete the state directory or the database to clear a claim.

### Pi shows `hub:off`

- Confirm the hub is reachable from the Pi terminal (`kxm hub view`).
- Check the project name, and give the agent its project token rather than the admin token.
- Check whether a live agent already uses the same name in the project.
- Restart Pi after you change environment variables.
- For long-lived workers, check `KXM_WORKER_EXTENSION_PATHS` and `KXM_WORKER_SKILL_PATHS`; invalid paths fail before supervision starts. See [Run supervised Pi workers](../guides/pi-workers.md).

### Admin routes return 401 or 503

`/metrics`, `/v1/ops/*`, state promotion and quorum degradation need the admin token. A project token never substitutes for it, even when you hold every project's token.

- **401 `invalid_auth`:** the request carried a project token or a wrong admin token. Once the hub has an admin token, this applies on loopback too.
- **503 `admin_auth_not_configured`:** the hub was started without an admin token, which `kxm hub start` never does. Stop the hub, set `KXM_AUTH_TOKEN`, keep the full `KXM_PROJECT_TOKENS` map, and restart against the same database. Give the admin token only to the operator terminal.

### `kxm hub bind` refuses the URL

| Error | Fix |
|---|---|
| `hub_url_invalid` | Use an `http` or `https` URL without user info, query or fragment |
| `hub_bind_unauthenticated` | The URL is remote and this machine has no token for the project; export it and bind again |
| `hub_credential_unreadable` | Repair or remove `hub-env.json` under the user state root |

## Claude Code plugin and MCP

The [plugin troubleshooting guide](../../plugins/kxm/README.md#troubleshooting) has the full list. Run fixes in your own terminal, and never paste a token into Claude.

| Symptom | Fix |
|---|---|
| `kxm_*` tools do not appear | Check `/mcp` for the `kxm` server, check `node --version`, run `/reload-plugins`, and confirm `claude plugin list` shows `kxm@kxm` enabled |
| `KXM hub unreachable at <url>` | Start the hub, or correct `server_url` with `/plugin configure kxm@kxm` |
| `no project token for project <p>` | Enter the project token at `/plugin configure kxm@kxm`, or add `<p>` to the hub's full `KXM_PROJECT_TOKENS` map and restart the hub |
| `KXM hub rejected the project token for project <p>` | Enter the token the hub holds for `<p>` |
| `tool_policy_denied: Session token on disk is malformed or expired` | Run `kxm session token --clear` |
| Pushed requests never arrive | Start Claude Code with `claude --dangerously-load-development-channels plugin:kxm@kxm` and accept the trust prompt, or use `kxm_inbox` and `kxm_reply` |
| `kxm is already at the latest version` but the plugin is old | The release job sets the version only inside its build and never commits it, so updates never refresh the plugin. [Reinstall it](../start/quickstart-claude-code.md#update-the-plugin) |
| No KXM brief at session start | Start Claude Code from the directory that contains `.kxm/` |

## Peer messaging

| Symptom | Cause | Fix |
|---|---|---|
| An expected peer is missing | Different `KXM_PROJECT` values, or the peer stopped sending heartbeats | Compare settings and look for `agent_stale`; names display case-sensitively but live-name uniqueness ignores case |
| Registration returns HTTP 409 `duplicate_agent_name` | A live agent already uses the name in this project | Stop the old session, or choose another name |
| A request stays `queued` | The recipient has no active event stream | Confirm its process is connected; proxies must not buffer `/v1/events` |
| A request stays `delivered` | The recipient acknowledged it and is still working, waiting for approval, or blocked | Check the recipient directly; do not resend. `kxm_cancel` changes hub state only; it cannot undo work already done |
| A message disappears after completion | Terminal messages are purged after 7 days | Raise `KXM_MESSAGE_RETENTION_MS`, and keep durable results in Git |

### `kxm_await` times out

`kxm_await` waits at most 60 seconds, which is both its default and its cap. A timeout does not end the request. Check it with `kxm_get`, and use `kxm_workflow_wait` for long external work. `cancelled`, `expired` and `error` are terminal. Resend only work that is safe to repeat, with an idempotency key after an uncertain network result.

### Fanout returns pending before a model replies

`kxm_fanout.timeoutMs` is a local wait, not the message lifetime. A pending result includes the durable `messageId`, its status and expiry, and whether the wait timed out or was aborted. Inspect it with `kxm_get`, or repeat the exact fanout with the same correlation ID, idempotency prefix, targets and content. Do not send a replacement with a new prefix. Usually omit `ttlMs` for model work, and never count a pending peer toward a checkpoint. See [Message peer agents](../guides/peer-messaging.md).

## Pi workers

| Symptom | Cause | Fix |
|---|---|---|
| A continued Pi session rejects every turn | The worker stopped during a tool call, leaving a `tool_use` without its `tool_result` | Nothing: the worker retries once without `--continue` and writes a recovery envelope; keep the same project and agent name |
| The agent settles on a quota or provider error | Pi's own retries are exhausted | Set `--fallback-models` (or `KXM_WORKER_FALLBACK_MODELS`) to rotate at once; otherwise the worker retries after `KXM_WORKER_PROVIDER_RETRY_MS` |
| The heartbeat is healthy but one tool never finishes | A tool exceeded `KXM_WORKER_TOOL_TIMEOUT_MS` (31 minutes by default, above the 30-minute fanout wait) | The worker logs `worker_tool_timeout` and restarts the child; raise the limit only above the longest legitimate call |
| A long-lived worker keeps restarting | Pi is missing from the service `PATH`, the working directory is gone, or model credentials are missing | Read `worker_process_error` and `worker_exited`; set `KXM_PI_COMMAND` to an explicit path |
| A read-only reviewer edits files | Prompt wording does not remove tools | Set `KXM_WORKER_TOOLS=read,grep,find,ls` |
| The worker exits at once with `pi_native_impersonation_blocked` | `--model` or a `--fallback-models` entry is a model whose vendor has its own harness, such as `xai/…`, `openai-codex/…` or `openrouter/x-ai/…` | Run that model in its native harness, or pick an admitted Pi route such as `openrouter/qwen/qwen3-coder-plus`; see [Harness routing](../reference/harness-routing.md#what-the-brake-refuses) |

Use `--fresh-start`, not `--no-continue`, when only the first launch must avoid old session state.

### A workflow message stays queued while the worker restarts once

With `--session-isolation workflow`, a message for a different run is deliberately left queued in the current Pi context. Look for `worker_session_routed`: the old child closes, one child starts with the run's `--session-dir`, and the same message ID replays and becomes `delivered`.

If it repeats, read `worker_session_request_rejected` and check that the worker was started with `kxm agent worker`, that `KXM_WORKER_SESSION_SCOPE` was not set by hand, that only the service account can write the state directory, that the hub and worker run the same release, and that the message has a hub-owned `workflowRunId`. Never acknowledge the message by hand, edit the route request, copy a run history into `default`, or start a second worker with the same identity.

### Session events

| Event | Meaning | Action |
|---|---|---|
| `worker_session_routed` | Expected swap to another run's session | None unless it repeats for one message |
| `worker_session_evicted` | An inactive run history was removed at the retention bound | Keep workflow facts in the journal, assets or Git |
| `worker_session_state_recovered` | A malformed binding manifest was quarantined as `.corrupt-<timestamp>` and routing restarted at `default` | Read `kxm_workflow_get`, re-drive unfinished work from durable message IDs, keep the quarantined file, and check disk and permissions |
| `worker_continue_fallback` | Pi history could not continue, so the same binding started fresh | Read the recovery envelope and the durable message state |

If a workflow seems to remember another run, confirm the worker log says `"sessionIsolation":"workflow"`. Isolation is off by default; restart with `--session-isolation workflow`. The first isolated start uses fresh storage, and history from a formerly shared session cannot be separated afterward. See [Run supervised Pi workers](../guides/pi-workers.md).

## Workflows and gates

### A workflow tool returns `workflow_forbidden`

Read `operation`, `assignedCoordinatorName` and `nextAction` in the error. Only the assigned coordinator can read, wait on, checkpoint or journal a run; do not retry as a peer.

### A workflow cannot advance

A passing checkpoint needs a keyed, non-empty value for every declared `requiredEvidence` key; extra keys do not count. Warnings and failures stay active until corrected. When attempts run out, or the coordinator settles early, the run fails and its journal records why. Decide whether repeating external effects is safe before you start a new delivery.

For a `peer-reply` requirement, read `resolvedEvidencePolicies`, `verifiedEvidence` and the current attempt. An evidence string cannot satisfy it; the checkpoint must cite replied message IDs in `evidenceRefs` before those messages are purged, and every eligible agent must have registered before the run started.

| Code | Meaning |
|---|---|
| `workflow_context_forbidden` | The sender is not the run's assigned coordinator |
| `workflow_context_inactive` | The run or stage is not running |
| `workflow_context_attempt_mismatch` | Use `stage.attempts + 1`, and send fresh work after a retry |
| `workflow_evidence_producer_forbidden` | The target is not in the run's eligible producer set |
| `workflow_evidence_policy_missing`, `workflow_evidence_policy_unresolved` | The requirement has no usable peer policy |
| `workflow_provenance_invalid` | A cited message is missing, pending, ineligible, or bound to another project, run, stage, requirement or attempt |
| `workflow_evidence_incomplete` | Fewer unique verified producers than the minimum; several replies from one peer count once |

If the policy declares a lower `degradation.minProducers`, an operator with the admin token can approve it for the current stage and attempt. Preview with `kxm gate degrade <run-id> <stage-id> --requirement <key> --reason <text> --dry-run --json`, then run it without `--dry-run`. Approval does not advance the run; the coordinator still checkpoints. See [Peer provenance and quorum gates](../guides/provenance-gates.md).

### GitHub checks passed but the run is still waiting

The hub does not poll GitHub. Run `kxm gate github watch` with the run's `--run-id`, `--stage-id` and `--signal-key`. On timeout it posts the signed `failed` signal and exits `4`; it never invents `passed`.

### A webhook or callback is rejected

| Response | Meaning |
|---|---|
| 401 | The signature is missing, does not match, or is older than 300 seconds (`webhook_timestamp_expired`: check the sender's clock). Signals and `generic` starts need the [KXM sender contract](../guides/webhook-workflows.md#kxm-sender-contract); a callback must use `signalSecretEnv` when the definition sets it |
| 400 | The delivery ID or JSON body is missing; `workflow_evidence_incomplete` names `missingRequirements`; `invalid_workflow_evidence` means non-string or duplicate keys |
| 404 | The definition or run ID does not match this hub |
| 409 `workflow_target_unavailable` | The configured coordinator has never registered; start it once with the matching project and name |
| 409 `workflow_not_waiting` | No wait is active: `kxm_workflow_wait` was not called, the deadline failed the run, or a prior signal advanced it |
| 409 `workflow_signal_mismatch`, `workflow_signal_context_mismatch` | Use the run's exact `waiting.signalKey`; fix or omit `workflow.run`, `workflow.stage` and `workflow.signal` evidence |
| 204 | The event or filter did not match, so no run was intended |
| 409 `webhook_delivery_conflict`, `webhook_payload_replayed` | The delivery ID was reused with a different body, or a Jira or GitHub body already started a run under another delivery ID |
| 200 with `duplicate: true` | A retry of the same delivery ID and body was deduplicated |

A failed or timed-out callback consumes that wait. Re-enter the wait and start a new `github watch` or `kxm gate signal`; keep an explicit `--delivery-id` only for retries of one unchanged body. See [Run webhook workflows](../guides/webhook-workflows.md).

### A workflow file fails to load with `gate_outcome_impossible`

A gate step declares an outcome its `expect` value never produces. The message names the outcomes to declare instead.

## Runtime runs

| Symptom | Cause | Fix |
|---|---|---|
| `runtime supervisor is not running` or `runtime_not_running` | The supervisor stopped | `kxm runtime start`; commands such as `kxm run` also start it on demand |
| `runtime_supervisor_unreachable` | A live supervisor process does not answer its token probe | Check the PID from `kxm runtime status`, stop a hung process with your OS tools, then `kxm runtime start` |
| `project_required` | The command ran outside a KXM project | Run it from the checkout, or run `kxm init` |
| `producer_route_not_admitted` | A live drive uses a model route that is not admitted | `kxm routes admit --model <provider/model>`, or drive with `--simulated` |
| `pi_not_authenticated: pi harness not detected (pi_native_impersonation_blocked)` | A Pi agent's model belongs to a vendor with its own harness | Set the agent's native `harness:`, or choose an admitted Pi route whose vendor has none |
| `run_busy` (HTTP 409) | The run is already admitted or queued for a drive | Wait, and check `kxm runs status <run-id>` |
| A run store is refused with `runtime_schema_outdated` | The store predates this release | See [Upgrade KXM](upgrade.md#understand-schema-changes) |
| Runs do not reach the hub | Sync is `no_hub`, `blocked` or `refusing` | See [Operate Runtime sync and leases](runtime-sync.md#check-sync-status) |

## Context and memory

| Symptom | Cause | Fix |
|---|---|---|
| 403 `context_isolation_violation` | An agent asked for another project's context | Use the agent's own project; cross-project reads need the admin token |
| State promotion returns 401 or 503 | Promotion needs the configured admin token; agents can only propose | Promote with `kxm context promote <project> <proposal-id>` from the operator terminal |
| `kxm context recall` returns nothing | No live record matches; superseded and rejected records are excluded | Broaden the query, or check `unresolvedGaps` |
| A new memory fact does not appear in `kxm memory brief` | `kxm memory note` records a candidate, which becomes active only when promoted through a pull request | Review and merge the candidate, then run `kxm memory sync` |
| `memory sync failed: none of AGENTS.md, CLAUDE.md, GEMINI.md exists` | Sync updates only the instruction files a project already has | Create the file your harness reads, then sync again |
| `memory sync failed: <file> has …; wrote no file` | An orphan memory marker, an end marker before its start, or a second block | Keep exactly one `kxm:memory` marker pair in the file, or delete both, then sync again |

See [Context and memory](../guides/context-and-memory.md).

## Operations

| Failure | Behavior | Recovery |
|---|---|---|
| An agent exits | It is marked offline after the stale window | Restart it with the same name to resume its ID |
| The event stream drops | The client reconnects while heartbeats continue | If it repeats, check the network and proxy buffering |
| The hub or a worker exits | SQLite keeps agents and messages, and binding manifests keep the Pi scope | Restart. Queued messages are pushed again, by the same ID, until acknowledged; delivered messages are not replayed |
| The disk fails or fills | Readiness or writes fail | Restore storage, then check database integrity and `/ready` |
| An external callback is lost | The run stays `waiting` until its deadline, then fails and notifies the coordinator | Retry with the same delivery ID, or review side effects before a new delivery |
| Requests return 429 `rate_limited` | The per-agent or per-address window is full | Honor `Retry-After`; raise `KXM_RATE_LIMIT_MAX` if the load is expected |
| `kxm restore` refuses with `runtime_schema_mismatch` | A backup file's schema version differs from the one its manifest records | Use another backup set; never mix files between sets |

For backup and restore errors such as `backup_no_stores`, see [Back up and restore KXM](backup-and-restore.md#troubleshooting). The dashboard's action keys do not act on runs; see [Monitor KXM](monitoring.md#keys).

## Collect a useful bug report

Include:

- the operating system and Node.js version;
- the Pi or Claude Code version, and the KXM version (`kxm --version`) or Git commit;
- whether the hub is local or behind a proxy;
- redacted environment values, never tokens;
- the relevant structured hub events;
- exact reproduction steps and the expected behavior.

Never attach tokens, private prompts, credentials, raw `pi-agent-*.log` files, or unrelated repository content.

## For maintainers

- **`kxm --help` prints an old flat command list.** The committed `plugins/kxm/dist/cli.js` is stale. Run `npm run build` and commit the generated `dist`.
- **Every CI job stays queued while a runner is online.** See [CI and release](../contributing/ci-and-release.md#ci-jobs-stay-queued-while-a-runner-is-online).
- **Loading an exact extension in Pi during development.** Use `pi --no-extensions -e ./plugins/kxm/src/extension.ts`, adding every required provider extension with another `-e`; see [Develop KXM](../contributing/development.md).

## Related

- [Monitor KXM](monitoring.md)
- [Deploy KXM](deploy.md)
- [CLI reference](../reference/cli-reference.md)
- [Claude Code plugin](../../plugins/kxm/README.md)
