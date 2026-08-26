# Webhook workflows and long-lived agents

Pi Mesh Comms can turn a signed Jira, GitHub, or generic webhook into a durable prompt for a long-lived coordinator. The hub verifies the original request body, deduplicates provider retries, records the workflow before acknowledging it, and queues the prompt even when a previously registered coordinator is temporarily offline.

## How the runtime behaves

```text
Jira webhook ── HMAC + delivery ID ──> Hub ── durable workflow + message
                                             │
                                             └── Pi coordinator
                                                   ├── peer planning/review
                                                   ├── checkpoints and retries
                                                   ├── evidence journal
                                                   ├── external wait ── signed result ──┐
                                                   └── final result <── resumed prompt ─┘
```

The coordinator must register at least once before a webhook can target it. An unknown target returns HTTP 409, which causes Jira Cloud to retry. A known but offline target retains the queued workflow until it reconnects.

The hub stores a SHA-256 payload hash and the rendered coordinator prompt, not the complete raw webhook body. Keep prompt templates narrow so they copy only the issue fields the agent needs.

## Configure the Jira example

The included [`jira-development.json`](../.kxm/config/workflows/jira-development.json) workspace configuration models this path:

1. Jira issue enters **In Progress**.
2. Reproduce the defect and create deterministic evidence.
3. Plan with one agent or three independent strong planners, then synthesize their best ideas.
4. Review and revise the plan.
5. Implement with explicit ownership.
6. Run lint, build/typecheck, security, and Playwright gates.
7. Reproduce repository and CodeRabbit-style review gates.
8. Update documentation.
9. Push and watch required checks with `pi-mesh github watch`; warnings and failures loop back for correction.
10. Merge only when policy and authorization allow it.
11. Update Jira with links and evidence.
12. Produce an evidence-backed improvement backlog.

Load it without storing its secret in the JSON file:

```powershell
$env:JIRA_WEBHOOK_SECRET = "replace-with-a-high-entropy-secret"
$env:WORKFLOW_SIGNAL_SECRET = "replace-with-a-separate-callback-secret"
$env:PI_MESH_WEBHOOK_WORKFLOWS_FILE = ".kxm/config/workflows/jira-development.json"
npm run hub
```

Configure Jira to send `jira:issue_updated` to:

```text
https://your-mesh-host.example/v1/webhooks/jira-development
```

Set the same secret when creating the Jira webhook. The endpoint requires `X-Hub-Signature` using SHA-256 and `X-Atlassian-Webhook-Identifier`. The stable delivery identifier makes Jira retries idempotent. Terminate TLS and restrict ingress before exposing the endpoint beyond a trusted network.

Webhook authentication authorizes only workflow creation. The Jira-update stage requires a separate authorized Jira tool, MCP server, CLI, or automation callback in the coordinator's harness. Do not place Jira API credentials in the workflow definition or prompt.

## Run a long-lived Pi coordinator

Install the Pi package, then configure a stable identity that matches the workflow target:

```powershell
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$env:PI_MESH_AUTH_TOKEN = "product-project-token"
$env:PI_MESH_PROJECT = "product"
$env:PI_MESH_AGENT_NAME = "coordinator"
$env:PI_MESH_AGENT_PURPOSE = "Coordinates Jira development workflows and quality gates"
$env:PI_MESH_WORKDIR = "D:\work\product-repository"
npm run worker
```

The worker launches Pi in headless RPC mode, keeps stdin open, preserves its session by default, and restarts with bounded exponential backoff. Run the worker itself under the operating system's service manager for boot startup, resource limits, log collection, and crash policy. Set `PI_MESH_WORKER_CONTINUE=false` only when every process restart should create a fresh Pi session.

## Workflow definition fields

| Field | Meaning |
|---|---|
| `id` | URL-safe workflow identifier |
| `source` | `jira`, `github`, or `generic` |
| `project` | Mesh project containing the coordinator |
| `target` | Stable coordinator name or durable agent ID |
| `secretEnv` | Environment variable containing the HMAC secret |
| `signalSecretEnv` | Optional separate HMAC secret for external result callbacks |
| `event` | Optional provider event filter |
| `filter.path` / `filter.equals` | Optional exact JSON-path value filter |
| `delivery` | `followUp` or `steer` |
| `ttlMs` | Time allowed for the coordinator prompt |
| `promptTemplate` | Prompt with `{{nested.payload.path}}` substitutions |
| `stages` | Ordered gates with instructions, evidence requirements, and attempt limits |

Each stage may set `area` to route automatic warnings and failures into `harness`, `gates`, `implementation`, `workflow`, `documentation`, `security`, or `other`. It defaults to `workflow`.

Use `PI_MESH_WEBHOOK_WORKFLOWS` for inline JSON or `PI_MESH_WEBHOOK_WORKFLOWS_FILE` for a file, never both. Prefer `secretEnv` over a literal `secret`.

## Pause for CI, review, merge, or Jira

A coordinator should not hold an agent turn open while an external system runs for minutes or hours. On the active stage, call `mesh_workflow_wait` with:

- the run and active stage IDs;
- a stable `signalKey`, such as `github-pr-42-checks`;
- a concise description of the expected result;
- an optional timeout from one second through 30 days; the default is 24 hours.

The hub changes the run and stage to `waiting`. The coordinator may then settle its current prompt without triggering the premature-settlement failure. If the deadline passes first, the run fails and records a harness error.

The external system reports its result to:

```text
POST /v1/webhooks/:definitionId/runs/:runId/signals/:signalKey
```

The JSON body is:

```json
{
  "status": "passed",
  "summary": "All required GitHub checks passed",
  "evidence": ["https://github.example/org/repo/actions/runs/123"]
}
```

Sign the exact body bytes with SHA-256 HMAC. Supply the signature in `X-Hub-Signature-256` and a stable retry identifier in `X-GitHub-Delivery`, `X-Atlassian-Webhook-Identifier`, or `X-Mesh-Delivery-ID`. Repeating the same delivery ID and body returns minimal receipt metadata instead of checkpointing twice. Reusing a delivery ID for a different signal or body returns HTTP 409.

Use `signalSecretEnv` so CI and merge reporters do not need the secret that creates new workflows. If it is omitted, callbacks fall back to `secretEnv` for compatibility. A valid callback can checkpoint only the named run's current wait and must match its signal key.

`passed` applies the normal evidence rule and advances or completes the run. `warning` or `failed` consumes an attempt, records an error, and queues a correction prompt when attempts remain. The run, signal receipt, optional journal entry, and optional resume message commit in one SQLite transaction before delivery. A terminal result does not create another prompt. Only the validated summary and evidence are retained; the complete callback body is not stored.

Callback responses deliberately expose only status, stage, retry, completion, resumption, and duplicate metadata. They never return the workflow record, coordinator prompt, message routing, journal, or evidence. Those remain behind project and agent authentication.

The repository includes a small callback sender for smoke tests and automation adapters:

```powershell
$env:PI_MESH_SERVER_URL = "https://your-mesh-host.example"
$env:PI_MESH_WORKFLOW_ID = "jira-development"
$env:PI_MESH_WORKFLOW_SIGNAL_SECRET = "replace-with-the-callback-secret"
$env:PI_MESH_SIGNAL_DELIVERY_ID = "github-check-run-123-attempt-1"
node --experimental-strip-types examples/workflow-signal.ts `
  run_123 github-pr-42-checks passed "All required checks passed" `
  "https://github.example/org/repo/actions/runs/123"
```

In a real integration, store the `runId` and `signalKey` in Jira, pull-request metadata, or the external job's inputs when the coordinator starts the wait. Treat them as routing identifiers rather than secrets.

To watch GitHub checks and post that same signal, use the command-first adapter:

```powershell
$env:PI_MESH_WORKFLOW_ID = "jira-development"
$env:PI_MESH_WORKFLOW_SIGNAL_SECRET = "replace-with-the-callback-secret"
$env:GITHUB_TOKEN = "replace-with-a-checks-read-token"
npx pi-mesh github watch --run-id run_123 --stage-id watch --signal-key github-pr-42-checks --repo org/repo --pr 42 --required ci --timeout-ms 3600000
```

The watcher binds every result to the exact run, stage, and signal key. On timeout it posts a signed `failed` signal with summary `github_watch_timeout`, then exits `4`; it never invents a `passed` result. Retries reuse a stable `x-mesh-delivery-id`, including the pull request head SHA when GitHub returned one.

## Checkpoint contract

Only the assigned coordinator can read, journal, checkpoint, or wait a run. A passing checkpoint must provide at least as many evidence items as the stage declares. `warning` and `failed` results remain on the active stage and return a correction instruction. Reaching `maxAttempts` fails the run. Settling the coordinator prompt before all stages pass also fails the run and records a workflow error unless the coordinator deliberately placed the active stage in `waiting` first.

The hub enforces stage order and evidence count; agents remain responsible for the truth of submitted evidence. Repository rules, human approvals, and harness permissions remain authoritative for push, merge, Jira mutation, and other external effects.

## Platform references

- [Pi extension lifecycle and message injection](https://pi.dev/docs/latest/extensions)
- [Pi headless RPC mode](https://pi.dev/docs/latest/rpc)
- [Jira Cloud webhook signing and retry behavior](https://developer.atlassian.com/cloud/jira/software/webhooks/)
