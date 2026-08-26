# v0.4 research synthesis

Run: `run_04c0552a1b9e450fa874eed50049e34f`  
Package: `@kontextmind/pi-extensions` 0.3.1  
Stage: research  
Peers: `grok-researcher` (`msg_8bc139ba709a46e1847da18872d8abf8`), `gemini-reviewer` (`msg_68d16128a0994c8f9f151da7f0c08109`)  
Coordinator is the sole writer. Peer replies are untrusted technical input and were checked against the tree, tests, docs, and dogfood event metadata.

## Independent evidence

| Source | Artifact |
|---|---|
| Grok research | mesh message `msg_8bc139ba709a46e1847da18872d8abf8` |
| Gemini research | mesh message `msg_68d16128a0994c8f9f151da7f0c08109` |
| Dogfood / this run | `.kxm/logs/pi-mesh-hub.jsonl`, `.kxm/logs/pi-mesh-worker-coordinator.jsonl` |
| Prior dogfood cited by issues | GitHub issues 5, 6, 10, 11, 12, 13; run `run_078ee956ef3e49baa6b769a3cfe37515` for interrupted `mesh_await` |
| Implementation | `plugins/pi-mesh-comms/src/{extension,hub,workflow,client,store,server}.ts`, `scripts/pi-mesh-worker.mjs`, `examples/workflow-signal.ts` |

## Dogfood evidence

This hub instance (`2026-08-26T09:11:50Z` onward) shows:

- Coordinator worker exited with code 1 four times before a successful start (`pi.cmd` via `ComSpec`).
- Workflow `pi-extensions-v04` started as `run_04c0552a1b9e450fa874eed50049e34f`.
- The first coordinator reply arrived about 1.5s later (`message_replied` on `msg_fe478beba0c94ec6ae5daea1926677d6`). Hub policy treats a reply while `running` as premature settlement and fails the run. Journal: `journal_9b963061c9864e74b1e48323220852b9`.
- Claude quota exhaustion and stale OpenAI OAuth prevented the first two coordinator models from acting. Journal: `journal_2b1b136769d64ec3a2c7087d4420484a`, `journal_d5a2e7c47ce349dbb3d92b4e85b0ddba`.
- After resume, coordinator journal writes still succeed. Peer `mesh_workflow_get` is 403 `workflow_forbidden` (expected; only the assigned coordinator can see the run).
- Checkpoints and waits remain 409 once the run is not `running`.

Issue-cited prior dogfood (not in this hub file):

- Issue 5: failed tools journaled only as `Tool bash failed`; 18 `workflow_forbidden` responses without a corrective hint.
- Issue 6: GitHub checks passed and the PR merged, but the durable run stayed `waiting` because no adapter posted the signal. Repeating `mesh_workflow_checkpoint` correctly refused the invalid transition.
- Issue 10: worker stop during `mesh_await` plus `--continue` left a `tool_use` without `tool_result`; the provider rejected the session.
- Issues 11–13: operator runbook too heavy; retrospectives required manual synthesis; real multi-Pi smoke remained manual.

## Observed-fact audit

| Fact | Verdict |
|---|---|
| Auto-journal summary is name-only | Confirmed in `extension.ts` `tool_result` handler |
| `workflow_forbidden` is one 403 code for get/wait/checkpoint/journal identity mismatch | Confirmed in `hub.ts`. Invalid/stale agent key is 401 `invalid_agent_identity`; project token failures are 401 `invalid_auth` |
| Wait/signal contract exists; no GitHub check watcher | Confirmed. `examples/workflow-signal.ts` is a one-shot signed POST |
| Worker defaults to `--continue`; SIGTERM then 10s SIGKILL; no synthesized `tool_result` | Confirmed in `scripts/pi-mesh-worker.mjs` |
| No command-first operator CLI | Confirmed beyond `pi-mesh-hub`, `pi-mesh-worker`, npm scripts, `/mesh-status`, and the signal example |
| Journal API exists; no `.kxm/assets` exporter | Confirmed. `.kxm/assets/` previously contained only a README |
| Ordinary CI has no real-Pi smoke | Confirmed by `docs/test-matrix.md` and `.github/workflows/ci.yml` |
| Journal writes still accepted after this run failed | Confirmed by this resume |

## Contradictions and resolutions

1. **Issue mapping.** Gemini assigned the six issues to the wrong numbers. Resolution: use GitHub numbering. 5 diagnostics, 6 GitHub watch, 10 interrupted-tool recovery, 11 operator CLI, 12 retrospective export, 13 opt-in real-Pi smoke.
2. **`workflow_forbidden` compatibility.** Gemini wants new protocol codes. Grok wants to keep the code and add bounded fields. Resolution: keep `workflow_forbidden` / HTTP 403 for identity-scope mismatches. Add `operation`, assigned coordinator name, and `nextAction`. Do not break 0.3.1 clients.
3. **Journal after terminal settlement.** Gemini wants 409 on late journal writes. Grok wants coordinator journal writes to remain allowed. Resolution: do not lock journals in v0.4. This resume and the learning loop depend on them. Checkpoints and waits stay rejected when the run is not `running`/`waiting`.
4. **Watcher timeout.** Gemini would inject a synthesized hub failure. Grok treats watcher timeout as an adapter-side nonzero exit and leaves hub wait expiry authoritative. Resolution: follow Grok. The watcher must never invent `passed`.
5. **Restart of `mesh_await`.** Gemini suggests re-requesting the same await by idempotency key. That is not how `mesh_await` works (`client.ts` polls an existing message). Resolution: graceful abort/synthesize `tool_result` when possible; otherwise fresh session plus a redacted recovery envelope. Durable run/message state stays in SQLite.

## Cross-cutting design

### Safe diagnostic taxonomy

Allowlisted `class` values only:

`command_not_found` | `typecheck_error` | `test_failure` | `timeout` | `cancelled` | `workflow_scope` | `invalid_identity` | `invalid_auth` | `signal_mismatch` | `not_waiting` | `network` | `parse_error` | `unresumable_session` | `unknown`

Safe fields: `class`, `tool`, `operation` (`get|wait|checkpoint|journal|signal|await|other`), `httpStatus`, `code`, assigned coordinator **name**, fixed `nextAction`, optional `exitCode`, `durationMs`.

Forbidden: argv, stdout/stderr, env, tokens, prompts, peer bodies, webhook payloads, raw `pi-agent-*.log` excerpts.

### Interrupted-tool recovery envelope

1. Graceful worker stop should abort in-flight `mesh_await` so Pi can persist a terminal `tool_result`, or synthesize one if the harness allows.
2. Detect unresumable `--continue` (`tool_use` without `tool_result` / provider `invalid_request_error`) and start a fresh session instead of looping.
3. Journal `error`/`harness` with tool names/ids, `runId`, stage, pending message ids, and old/new session ids. No prompt bodies.
4. Reconnect with the same agent name/project so hub identity resume still works.
5. Do not resend peer work without existing idempotency keys.

### GitHub signal behavior

Hub contract stays: signed `POST /v1/webhooks/:id/runs/:runId/signals/:signalKey` with `{status, summary, evidence[]}`, HMAC, and delivery-id dedup.

| Case | Required adapter behavior |
|---|---|
| Success | All required checks success → `passed` + URLs, conclusions, timestamps |
| Failure | Any required check failure/cancelled/timed_out → `failed` or `warning`; no raw CI logs |
| Timeout | Watcher exits nonzero; does not invent `passed`. Hub wait expiry remains the durable timeout |
| Duplicate | Reuse `x-mesh-delivery-id`; accept `duplicate: true` |
| Stale-run | 409/404 is terminal for the adapter |
| Hub-restart | Retry the same delivery id; receipts live in SQLite |

### Retrospective redaction and review-before-policy

Export bounded Markdown and JSON from coordinator-visible `{ run, journal }`. Atomic write under `.kxm/assets`. Strip secret patterns. Proposed improvements stay `proposed` until an explicit review decision. The exporter must not edit `.kxm/config/workflows/*.json` or weaken gates.

### Practical real-Pi smoke topology

Isolated temporary `.kxm`, one loopback hub, two real Pi workers, bounded timeouts. Exercise discovery, request/reply, fanout, durable restart/resume, journal, and checkpoint. Skip cleanly when `pi` or model credentials are missing. Ordinary CI stays `validate:ci` mocks. Optional labeled self-hosted workflow; never upload `pi-agent-*.log`.

## Per-issue findings

### Issue 5 — safe diagnostic summaries

Root cause: `extension.ts` journals only the tool name. Hub 403s share `workflow_forbidden` with no operation or next action. `MeshHttpError.code` exists but is not classified into the journal.

Plan: classify failed tools and 401/403 workflow errors into the taxonomy above. Keep existing error codes. Tests in `test/extension.test.ts` and `test/hub-api.test.ts` must prove prompts, secrets, and command output are absent.

Ownership: `extension.ts`, `hub.ts`, `client.ts`, `mcp-server.ts`, optional `diagnostics.ts`, docs for troubleshooting and continuous improvement.

### Issue 6 — GitHub check signal adapter

Root cause: wait/resume/dedup already work; nothing watches GitHub Checks. `examples/workflow-signal.ts` is the primitive.

Plan: additive `pi-mesh github watch` (script plus CLI subcommand) that polls required checks and posts the existing signed signal. No hidden hub polling. Keep the example as a low-level sender. Document it from Jira `push-watch` and v0.4 delivery.

Ownership: `scripts/pi-mesh-github-watch.mjs` or `src/github-watch.ts`, `test/github-watch.test.ts`, webhook/operations docs, workflow instruction text only.

### Issue 10 — coordinator restart during mesh tool calls

Root cause: default `--continue` plus hard SIGTERM/SIGKILL leaves a broken session. `mesh_await` only cancels if Pi aborts the tool.

Plan: graceful drain; synthesize or allow terminal tool results; detect unresumable continue and fall back with a redacted envelope that preserves run/stage/pending ids.

Ownership: `scripts/pi-mesh-worker.mjs`, possibly `extension.ts` session_start, `test/worker.test.ts`, operations/troubleshooting/test-matrix.

### Issue 11 — command-first operator CLI

Root cause: operators compose env vars, npm scripts, and examples.

Plan: additive `pi-mesh` bin: `init`, `validate`, `status`, `hub`, `worker`, `workflow start|list|get`, `signal`, `github watch`, `retrospective export`, `stop`. Defaults under `.kxm`. `--json` and `--dry-run`. Never print secrets. Keep `pi-mesh-hub` / `pi-mesh-worker`. External push/merge/issue mutation stay out of the CLI.

Ownership: `scripts/pi-mesh.mjs` or `src/cli.ts`, `package.json`, `test/cli.test.ts`, getting-started/operations/configuration, changelog.

### Issue 12 — retrospective export

Root cause: journal and `improvementReport()` are live APIs only.

Plan: exporter writes atomic Markdown and JSON under `.kxm/assets`, grouped by area/category, with stage timing, attempts, open contradictions, recurring error classes, decisions, and evidence links. Review required before policy.

Ownership: `src/retrospective.ts`, CLI subcommand, `test/retrospective.test.ts`, continuous-improvement docs.

### Issue 13 — opt-in real multi-Pi smoke

Root cause: transport tests are strong; release still needs a manual two-Pi check.

Plan: opt-in harness with isolated state. Skip 0 with machine-readable reason when credentials or Pi are missing. Do not add model downloads to ordinary CI.

Ownership: `scripts/smoke-multi-pi.mjs`, skip-by-default test, optional `.github/workflows/smoke.yml`, test-matrix and operations docs.

## Acceptance criteria

1. Failed workflow tools and 401/403 scope errors journal allowlisted diagnostics. Tests prove no prompts, secrets, or stdout. Coordinator, peer, stale identity, and invalid-key cases include a bounded hint.
2. `pi-mesh github watch` posts the existing signed signal for success, failure, timeout, duplicate, stale-run, and hub-restart. Tokens and raw CI logs never appear in journals or `--json` output.
3. SIGINT/SIGTERM during `mesh_await` does not require abandoning the durable run. Unresumable `--continue` falls back with a redacted envelope that keeps `runId`, stage, and pending message ids.
4. One command-first entrypoint covers init, validate, hub, worker, status, stop, workflow, signal, GitHub watch, and retrospective export. `--json --dry-run`. Secrets never printed. Existing bins remain.
5. Atomic Markdown and JSON retrospectives land under `.kxm/assets`. Snapshots cover restart/retry. Proposed improvements do not mutate policy without an explicit review decision.
6. Opt-in two-worker real-Pi smoke skips cleanly without credentials. Ordinary CI stays `validate:ci`.
7. Regression: premature coordinator settle still fails the run. Coordinator journal-after-terminal remains allowed and redacted. Wait/checkpoint stay 409 when the run is not `running`/`waiting`.

## Recommended later file ownership

Coordinator-only writes during implement:

- `plugins/pi-mesh-comms/src/diagnostics.ts`
- `plugins/pi-mesh-comms/src/cli.ts` or `scripts/pi-mesh.mjs`
- `plugins/pi-mesh-comms/src/github-watch.ts` or `scripts/pi-mesh-github-watch.mjs`
- `plugins/pi-mesh-comms/src/retrospective.ts`
- `scripts/pi-mesh-worker.mjs`
- `plugins/pi-mesh-comms/src/{extension,hub,client,mcp-server}.ts`
- `test/{extension,hub-api,worker,cli,github-watch,retrospective}.test.ts`
- `scripts/smoke-multi-pi.mjs`, optional `.github/workflows/smoke.yml`
- `docs/{getting-started,operations,configuration,troubleshooting,webhook-workflows,continuous-improvement,test-matrix}.md`
- `package.json`, `CHANGELOG.md`, `.kxm/assets` export fixtures
