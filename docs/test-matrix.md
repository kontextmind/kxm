# Test matrix

The release gate executes every test, measures the core source directly, type-checks strict TypeScript, lints documentation, verifies package versions, validates Claude manifests, rebuilds the MCP bundle, and inspects the npm package.

Run the automated gate with:

```powershell
npm run validate
```

## Product features

| Feature | Automated evidence |
|---|---|
| Health, readiness, metrics, request IDs, security headers | `test/hub-api.test.ts` |
| Shared and per-project authentication, project isolation | `test/hub-api.test.ts` |
| Registration, discovery, presence, stale detection, identity resumption | `test/hub-api.test.ts`, `test/hub.test.ts` |
| SQLite persistence, restart recovery, schema compatibility | `test/hub-api.test.ts`, `test/store.test.ts` |
| All delivery modes, message fields, hop limits, and validation | `test/hub-api.test.ts`, `test/protocol.test.ts` |
| Queue, acknowledgement, visibility, reply, and authorization | `test/hub-api.test.ts`, `test/hub.test.ts` |
| One-to-three-peer planning fanout and partial-error collection | `test/hub-api.test.ts`, `test/extension.test.ts`, `test/mcp.test.ts` |
| TTL expiry, sender cancellation, and terminal retention | `test/hub-api.test.ts` |
| Exact-retry idempotency and conflicting-key rejection | `test/hub-api.test.ts` |
| Rate limiting and retry guidance | `test/hub-api.test.ts` |
| Redacted structured logs | `test/hub-api.test.ts` |
| Client lifecycle, aborts, timeouts, invalid responses, reconnection | `test/client.test.ts` |
| Pi tools, inbound turns, automatic replies, status command | `test/extension.test.ts` |
| Claude MCP catalog, outbound and inbound tools, channel delivery | `test/mcp.test.ts` |
| Signed Jira webhook verification, filtering, dispatch, and retry deduplication | `test/hub-api.test.ts` |
| Ordered workflow checkpoints, evidence gates, warning/failure retry | `test/hub-api.test.ts`, `test/workflow.test.ts` |
| Durable external waits, safe settlement, minimal signed responses, retry/conflict deduplication, separate secrets, and timeout notification | `test/hub-api.test.ts`, `test/workflow.test.ts` |
| Plans, decisions, contradictions, errors, lessons, and improvement reports | `test/hub-api.test.ts`, `test/workflow.test.ts` |
| Safe diagnostic classification and redaction | `test/diagnostics.test.ts`, `test/extension.test.ts`, `test/hub-api.test.ts` |
| Operator CLI init/validate/export/watch | `test/cli.test.ts`, `test/github-watch.test.ts` |
| Retrospective export snapshots | `test/retrospective.test.ts` |
| Interrupted-worker continue fallback | `test/worker.test.ts`, `test/recovery.test.ts` |
| Opt-in real-Pi smoke contract and safe skip paths | `test/smoke-real-pi.test.ts`, `test/smoke.test.ts` |
| Durable workflow and journal recovery | `test/store.test.ts` |
| Atomic workflow transition commit and rollback | `test/store.test.ts` |
| Pi and Claude workflow/journal tools | `test/extension.test.ts`, `test/mcp.test.ts` |
| Package and marketplace version consistency | `scripts/check-versions.mjs` |

The CI minimums are 95% lines, 80% branches, and 90% functions across `client.ts`, `extension.ts`, `hub.ts`, `protocol.ts`, `store.ts`, and `workflow.ts`. The MCP runtime is exercised as its built child process because that is the artifact Claude users run.

## Executable examples and use cases

| Scenario | Location | Verification |
|---|---|---|
| Self-contained planner/reviewer round trip | `examples/roundtrip.ts` | Executed by `test/examples.test.ts` |
| Long-running deterministic reviewer | `examples/reviewer-agent.ts` | Type-checked and documented |
| Command-line requester | `examples/requester.ts` | Type-checked and documented |
| Plan then review | `examples/README.md` | Uses discovery, send, and wait |
| Separate file ownership | `examples/README.md` | Documents non-overlapping writers |
| Non-blocking delegation | `examples/README.md` | Uses send, independent work, and get |
| Obsolete-work cancellation | `examples/README.md` | Uses cancel and states rollback boundary |
| Safe network retry | `examples/README.md` | Uses stable idempotency keys |
| Jira issue-to-merge workflow | `.kxm/config/workflows/jira-development.json` | Parsed, type-checked through workflow tests, and exercised end to end with representative configuration |
| `.kxm` workspace defaults and persisted hub/worker logs | `.kxm/`, `test/server.test.ts`, `test/worker.test.ts` | Executed with isolated temporary workspaces |
| Signed external result callback | `examples/workflow-signal.ts` | Type-checked; equivalent signed callback path is exercised end to end in `test/hub-api.test.ts` |
| Long-lived headless coordinator | `scripts/pi-mesh-worker.mjs` | Restart limits, spawn failure, split-stream recovery, bounded drain, and `--continue` fallback are automated; the opt-in real-Pi gate verifies two workers, discovery, request/reply, fanout, durable restart/resume, journal, and checkpoint |
| GitHub check signal adapter | `plugins/pi-mesh-comms/src/github-watch.ts` | Deterministic mocked states in `test/github-watch.test.ts` |
| Operator CLI | `scripts/pi-mesh.mjs` | Isolated workspace commands in `test/cli.test.ts` |
| Native-free package install and Windows `pi.cmd` worker launch | `package.json`, `test/store.test.ts`, `test/worker.test.ts` | CI runs on Ubuntu and Windows at Node 22.13 and Node 24; the Windows test executes a command-script fixture through `ComSpec` |

## Manual release checks

Automation cannot prove that a third-party harness UI renders perfectly. Before a release, connect two current Pi sessions, run `/mesh-status`, complete one inbound round trip, install the marketplace plugin in a clean Claude Code profile, and verify `mesh_list`. Exercise preview channel delivery only when the target Claude Code version supports community channels.

When adding a feature, add executable coverage and update this matrix in the same change. If a behavior can only be verified manually, state why and add it to the release checklist instead of implying automated coverage.
