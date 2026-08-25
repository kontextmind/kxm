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
                                                   └── final result
```

The coordinator must register at least once before a webhook can target it. An unknown target returns HTTP 409, which causes Jira Cloud to retry. A known but offline target retains the queued workflow until it reconnects.

The hub stores a SHA-256 payload hash and the rendered coordinator prompt, not the complete raw webhook body. Keep prompt templates narrow so they copy only the issue fields the agent needs.

## Configure the Jira example

The included [`jira-development.json`](../examples/workflows/jira-development.json) models this path:

1. Jira issue enters **In Progress**.
2. Reproduce the defect and create deterministic evidence.
3. Plan with one agent or three independent strong planners, then synthesize their best ideas.
4. Review and revise the plan.
5. Implement with explicit ownership.
6. Run lint, build/typecheck, security, and Playwright gates.
7. Reproduce repository and CodeRabbit-style review gates.
8. Update documentation.
9. Push and watch required checks; warnings and failures loop back for correction.
10. Merge only when policy and authorization allow it.
11. Update Jira with links and evidence.
12. Produce an evidence-backed improvement backlog.

Load it without storing its secret in the JSON file:

```powershell
$env:JIRA_WEBHOOK_SECRET = "replace-with-a-high-entropy-secret"
$env:PI_MESH_WEBHOOK_WORKFLOWS_FILE = "examples/workflows/jira-development.json"
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
| `event` | Optional provider event filter |
| `filter.path` / `filter.equals` | Optional exact JSON-path value filter |
| `delivery` | `followUp` or `steer` |
| `ttlMs` | Time allowed for the coordinator prompt |
| `promptTemplate` | Prompt with `{{nested.payload.path}}` substitutions |
| `stages` | Ordered gates with instructions, evidence requirements, and attempt limits |

Each stage may set `area` to route automatic warnings and failures into `harness`, `gates`, `implementation`, `workflow`, `documentation`, `security`, or `other`. It defaults to `workflow`.

Use `PI_MESH_WEBHOOK_WORKFLOWS` for inline JSON or `PI_MESH_WEBHOOK_WORKFLOWS_FILE` for a file, never both. Prefer `secretEnv` over a literal `secret`.

## Checkpoint contract

Only the assigned coordinator can read, journal, or checkpoint a run. A passing checkpoint must provide at least as many evidence items as the stage declares. `warning` and `failed` results remain on the active stage and return a correction instruction. Reaching `maxAttempts` fails the run. Settling the coordinator prompt before all stages pass also fails the run and records a workflow error.

The hub enforces stage order and evidence count; agents remain responsible for the truth of submitted evidence. Repository rules, human approvals, and harness permissions remain authoritative for push, merge, Jira mutation, and other external effects.

## Platform references

- [Pi extension lifecycle and message injection](https://pi.dev/docs/latest/extensions)
- [Pi headless RPC mode](https://pi.dev/docs/latest/rpc)
- [Jira Cloud webhook signing and retry behavior](https://developer.atlassian.com/cloud/jira/software/webhooks/)
