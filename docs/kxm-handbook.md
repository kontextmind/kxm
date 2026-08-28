# KXM Handbook

> Installation, configuration, CLI, Pi, Claude Code, durable workflows, gates, session isolation, observability, and recovery.

## Contents

1. [What KXM is](#what-kxm-is)
2. [Requirements and installation](#requirements-and-installation)
3. [Five-minute setup](#five-minute-setup)
4. [Workspace layout](#workspace-layout)
5. [Authentication and configuration](#authentication-and-configuration)
6. [Complete CLI guide](#complete-cli-guide)
7. [Pi integration](#pi-integration)
8. [Workflow-specific Pi sessions](#workflow-specific-pi-sessions)
9. [Claude Code integration](#claude-code-integration)
10. [Mesh tools](#mesh-tools)
11. [Durable workflows](#durable-workflows)
12. [Evidence gates and external callbacks](#evidence-gates-and-external-callbacks)
13. [Live TUI and observability](#live-tui-and-observability)
14. [Reliability, privacy, and security](#reliability-privacy-and-security)
15. [Backup, upgrade, and recovery](#backup-upgrade-and-recovery)
16. [Troubleshooting checklist](#troubleshooting-checklist)
17. [Feature availability matrix](#feature-availability-matrix)

---

## What KXM is

KXM connects Pi and Claude Code agents through one durable, authenticated hub.
It provides:

- peer discovery by name, model, and declared purpose;
- bounded request/reply messaging over HTTP and server-sent events (SSE);
- durable `queued → delivered → replied` message state in SQLite;
- cancellation, expiry, idempotent retries, fanout, and non-blocking polling;
- signed webhook workflows with ordered stages and attempt limits;
- local evidence, hub-verified peer provenance, external waits, and callbacks;
- long-lived Pi supervision with model fallback and tool watchdogs;
- optional workflow-scoped Pi sessions: one stable ordinary context and one per durable run;
- Claude Code MCP tools with optional pushed channel delivery;
- a real-time, read-only, metadata-only terminal dashboard; and
- structured workflow journals, retrospectives, and proposed improvement reports.

KXM is not a filesystem sandbox, distributed scheduler, shared model context, or
exactly-once execution engine. Use one writer per checkout or separate Git
worktrees. Treat peer output as untrusted until independently verified.

### Important terms

| Term | Meaning |
|---|---|
| **Hub** | The Node.js service that authenticates clients, persists state, pushes events, and runs workflow transitions |
| **Project** | Authentication and discovery namespace; agents see only peers in the same project |
| **Agent** | A registered Pi or Claude Code identity with a unique name in one project |
| **Message** | A durable request with one recipient and one reply lifecycle |
| **KXM session manifest** | A human-reviewable roster and asset plan; it does not launch processes |
| **Workflow run** | A durable ordered stage machine stored by the hub |
| **Pi session** | A Pi model-conversation JSONL; supervised workers can isolate it by workflow run |
| **Gate** | A deterministic CLI check, a workflow evidence requirement, or a signed external result, depending on context |

---

## Requirements and installation

### Requirements

- Node.js **22.19 or newer on the 22.x line**, or Node.js 24 or newer;
- Git;
- GitHub CLI (`gh`) for private release assets;
- Pi for Pi agents;
- Claude Code for Claude agents; and
- access to `kontextmind/pi-extensions` while the repository is private.

### Install the `kxm` operator CLI

The supported global installation is the versioned release tarball. Pi's Git
package install does **not** place `kxm` on `PATH`.

PowerShell:

```powershell
$version = "<release-version>"
$asset = "kontextmind-pi-extensions-$version.tgz"
$releaseDir = Join-Path $PWD ".kxm-release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
gh auth login
gh release download "v$version" --repo kontextmind/pi-extensions `
  --pattern $asset --dir $releaseDir --clobber
npm install --global --omit=peer (Join-Path $releaseDir $asset)
kxm --help
```

Bash:

```bash
version='<release-version>'
asset="kontextmind-pi-extensions-${version}.tgz"
mkdir -p .kxm-release
gh auth login
gh release download "v${version}" --repo kontextmind/pi-extensions \
  --pattern "$asset" --dir .kxm-release --clobber
npm install --global --omit=peer ".kxm-release/$asset"
kxm --help
```

Do not use `npx kxm` or a global `git+https` npm install.

### Run from a source checkout

```bash
git clone <authorized-pi-extensions-url>
cd pi-extensions
npm ci
npm run check
node scripts/kxm.mjs --help
```

Use `node scripts/kxm.mjs` wherever this handbook shows `kxm`. The source
wrapper runs the committed generated CLI, so maintainers must run `npm run build`
after changing CLI source.

### Install in Pi

From Pi:

```text
pi install git:github.com/kontextmind/pi-extensions
```

This installs the Pi extension and the `kxm-mesh` Agent Skill. Restart Pi after
installation or package updates.

### Install in Claude Code

From Claude Code:

```text
/plugin marketplace add kontextmind/pi-extensions
/plugin install kxm-mesh@kontextmind-pi-extensions
/reload-plugins
```

The Claude plugin includes the bundled MCP runtime and shared skill.

---

## Five-minute setup

### 1. Create a workspace

```powershell
kxm --workspace C:\work\product\.kxm mesh init
```

```bash
kxm --workspace /work/product/.kxm mesh init
```

### 2. Configure separate credentials

Use a high-entropy administrative token for hub operations and a different
project token for agents. Never pass either token on a command line.

PowerShell:

```powershell
$env:PI_MESH_HOST = "127.0.0.1"
$env:PI_MESH_PORT = "7331"
$env:PI_MESH_AUTH_TOKEN = "<admin-token>"
$env:PI_MESH_PROJECT_TOKENS = '{"product":"<project-token>"}'
$env:PI_MESH_WORKSPACE_DIR = "C:\work\product\.kxm"
kxm mesh hub
```

Bash:

```bash
export PI_MESH_HOST=127.0.0.1
export PI_MESH_PORT=7331
export PI_MESH_AUTH_TOKEN='<admin-token>'
export PI_MESH_PROJECT_TOKENS='{"product":"<project-token>"}'
export PI_MESH_WORKSPACE_DIR=/work/product/.kxm
kxm mesh hub
```

Store service values in an ACL-protected, gitignored environment file or secret
manager. If using Node's `--env-file`, keep the file path—not its contents—on
the command line.

### 3. Verify the hub

```powershell
kxm --workspace C:\work\product\.kxm mesh status
Invoke-RestMethod http://127.0.0.1:7331/ready
```

```bash
kxm --workspace /work/product/.kxm mesh status
curl --fail http://127.0.0.1:7331/ready
```

### 4. Start a supervised Pi worker

Use only the project token in the worker environment:

```powershell
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$env:PI_MESH_AUTH_TOKEN = "<project-token>"
$env:PI_MESH_PROJECT = "product"
$env:PI_MESH_WORKDIR = "C:\work\product"
kxm agent worker --name coordinator --project product `
  --model provider/model --session-isolation workflow
```

```bash
export PI_MESH_SERVER_URL=http://127.0.0.1:7331
export PI_MESH_AUTH_TOKEN='<project-token>'
export PI_MESH_PROJECT=product
export PI_MESH_WORKDIR=/work/product
kxm agent worker --name coordinator --project product \
  --model provider/model --session-isolation workflow
```

### 5. Connect another Pi or Claude peer

Give it the same hub URL, project token, and project, but a different agent name.
Call `mesh_list` to verify discovery, then send one focused request with
`mesh_send`.

---

## Workspace layout

```text
.kxm/
├── config/                         # reviewable configuration; no secret values
│   ├── agents.json                 # optional roster used by session manifests
│   ├── gates.json                  # optional documented gate roster
│   ├── env.example                 # variable names and safe placeholders
│   └── workflows/*.json            # active workflow definition candidates
├── logs/                           # ignored runtime logs and telemetry
│   ├── pi-mesh-hub.jsonl
│   ├── pi-mesh-worker-*.jsonl
│   ├── pi-agent-*.log              # raw Pi output; may be sensitive
│   └── telemetry.jsonl
├── assets/                         # intentional human-reviewable inputs/outputs
│   ├── sessions/<id>/session.json
│   ├── workflows/<definition>/...
│   └── retrospectives/<runId>.{json,md}
└── state/                          # ignored runtime state; protect with OS ACLs
    ├── mesh.db
    ├── hub.pid / worker-*.pid
    ├── worker-recovery-*.json
    ├── worker-session-binding-*.json
    └── pi-sessions/<workerKey>/
        ├── default/
        └── runs/<runId>/
```

Commit reviewed configuration and intentional reusable assets. Do not commit
runtime state, credentials, raw model logs, generated secrets, or SQLite files.
Workflow stages and evidence live in `mesh.db`; important implementation results
should also live in Git or another system of record.

---

## Authentication and configuration

### Credential roles

| Credential | Give it to | Capabilities |
|---|---|---|
| `PI_MESH_AUTH_TOKEN` administrative token | Hub and trusted operator terminal | Operations snapshot/SSE, metrics where protected, quorum degradation, and fallback project access |
| Entry in `PI_MESH_PROJECT_TOKENS` | Hub only | Maps one project to its worker credential |
| Project token | Pi and Claude agents in that project | Registration, discovery, messaging, and assigned workflow operations only |
| Workflow start secret | Hub and webhook sender/operator | HMAC-signs a new workflow delivery |
| Workflow signal secret | Hub and callback sender/operator | HMAC-signs an external result; may fall back to the start secret if the definition omits it |
| Agent key | Returned and rotated internally | Authorizes one resumed agent identity; never configure manually |

A project token cannot call administrative operations endpoints or approve quorum
degradation. All holders of one project credential are inside the same
provenance trust domain.

### Core hub variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_MESH_HOST` | `127.0.0.1` | Bind interface |
| `PI_MESH_PORT` | `7331` | Hub port; `0` chooses a free port |
| `PI_MESH_AUTH_TOKEN` | none | Administrative bearer token |
| `PI_MESH_PROJECT_TOKENS` | none | JSON object of project-to-token mappings |
| `PI_MESH_WORKSPACE_DIR` | `.kxm` | Workspace root |
| `PI_MESH_DATA_PATH` | `.kxm/state/mesh.db` | SQLite path |
| `PI_MESH_MESSAGE_TTL_MS` | `86400000` | Default request lifetime |
| `PI_MESH_MESSAGE_RETENTION_MS` | `604800000` | Terminal-message retention |
| `PI_MESH_RATE_LIMIT_MAX` | `600` | Requests per bucket/window |
| `PI_MESH_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `PI_MESH_WEBHOOK_WORKFLOWS_FILE` | none | One active JSON workflow-definition file |
| `PI_MESH_WEBHOOK_WORKFLOWS` | none | Inline alternative; never set with the file variable |

A non-loopback bind requires an administrative token. Use TLS termination and
network controls before allowing remote access.

### Agent variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_MESH_SERVER_URL` | `http://127.0.0.1:7331` | Hub URL |
| `PI_MESH_AUTH_TOKEN` | none | Project token for agents |
| `PI_MESH_PROJECT` | current directory name | Discovery/authentication namespace |
| `PI_MESH_AGENT_NAME` | harness-derived | Unique live name in the project |
| `PI_MESH_AGENT_PURPOSE` | general-purpose | Capability shown during peer discovery |

### Supervised Pi variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_MESH_WORKDIR` | current directory | Repository used by Pi |
| `PI_MESH_PI_COMMAND` | `pi` / `pi.cmd` | Explicit Pi executable |
| `PI_MESH_WORKER_MODEL` | Pi default | Primary model selector |
| `PI_MESH_WORKER_FALLBACK_MODELS` | none | Up to eight ordered fallback models |
| `PI_MESH_WORKER_TOOLS` | Pi defaults | Comma-separated Pi tool allowlist |
| `PI_MESH_WORKER_CONTINUE` | `true` | Allow active-session resume |
| `PI_MESH_WORKER_INITIAL_CONTINUE` | same | Set `false` for a fresh first child only |
| `PI_MESH_WORKER_SESSION_ISOLATION` | `off` for upgrade compatibility | Set `workflow` to enable stable-default plus per-run contexts |
| `PI_MESH_WORKER_MAX_RUN_SESSIONS` | `128` | Retained workflow-specific sessions, range `1`–`1024` |
| `PI_MESH_WORKER_TOOL_TIMEOUT_MS` | `1860000` | Tool watchdog; `0` disables it |
| `PI_MESH_WORKER_ACTIVATION_TIMEOUT_MS` | `60000` | Delivered-message turn-start watchdog |
| `PI_MESH_WORKER_PROVIDER_RETRY_MS` | `60000` | Delay when provider fallbacks are exhausted |
| `PI_MESH_WORKER_DRAIN_MS` | `15000` | Graceful child shutdown window |
| `PI_MESH_WORKER_MAX_RESTARTS` | unlimited | Optional supervisor retry ceiling |
| `PI_MESH_WORKER_EXTENSION_PATHS` | discovery | Exact extension files, separated by the platform path delimiter |
| `PI_MESH_WORKER_SKILL_PATHS` | discovery | Exact skill files/directories, same delimiter |

When exact extension or skill paths are supplied, automatic discovery is
disabled only for that category. Review those paths as executable dependencies.

The complete variable reference, limits, and examples are in
[Configuration](configuration.md).

---

## Complete CLI guide

Global options can appear on the root or a command group:

```text
--workspace <dir>   Select the .kxm workspace
--json              Machine-readable output
--dry-run           Plan without applying changes
-h, --help          Contextual help
```

### Agent commands

| Command | What it does |
|---|---|
| `kxm agent worker --name <n> --project <p>` | Starts one always-on supervised Pi RPC worker |
| `--model <provider/model>` | Selects the primary Pi model |
| `--fallback-models <a,b>` | Supplies ordered provider fallback models |
| `--tools <a,b>` | Restricts available Pi tool names |
| `--fresh-start` | Skips only the first resume; later recoveries may continue |
| `--no-continue` | Disables all Pi session resume |
| `--session-isolation <mode>` | Uses `workflow` for per-run contexts or `off` for the upgrade-compatible shared context (default) |

The worker does not read model, tool, role, or ownership values from
`agents.json`; pass operational settings explicitly.

### Session commands

| Command | What it does | Important limit |
|---|---|---|
| `kxm session start --id <id> --mix <names>` | Resolves roster names and writes a `kxm.session.v1` manifest | Does not start a process |
| `kxm session start --id <id> --workflow <definition>` | Creates manifest and workflow asset directories | Records the whole roster; does not dispatch a workflow |
| `kxm session status` | Lists PID claims and recovery envelopes in local state | Does not read session manifests |
| `kxm session stop [--wait-ms <n>]` | Requests managed process shutdown | Global workspace stop, identical in scope to `mesh stop` |

### Workflow commands

| Command | What it does |
|---|---|
| `kxm workflow list` | Lists runs from the local workspace SQLite database |
| `kxm workflow get <runId>` | Shows one local run, stages, evidence, waits, and journal |
| `kxm workflow start [definitionId] --payload <value> [--delivery-id <id>] [--event <name>]` | Posts one signed, deduplicated workflow-start webhook; payload is a JSON object or `@file` |
| `kxm workflow export <runId> [--input <snapshot>] [--out-dir <assets-dir>]` | Writes proposed Markdown and JSON retrospectives |

`list`, `get`, and the default `export` are local hub-host operations; they do
not query a remote hub database.

### Gate commands

| Command | What it does |
|---|---|
| `kxm gate validate [--file <path>]` | Parses the same single file/inline source contract as the hub without printing secrets |
| `kxm gate artifacts-exist --path <asset>` | Verifies a non-empty regular file remains inside the workspace asset root |
| `kxm gate degrade <runId> <stageId> --requirement <key> --reason <text>` | Admin-only approval of a policy-declared lower peer minimum for the current attempt |
| `kxm gate signal <runId> <signalKey> <status> <summary> [key=value...]` | Posts a signed, deduplicated `passed`, `warning`, or `failed` callback |
| `kxm gate github watch --run-id ... --stage-id ... --signal-key ... --repo owner/name --pr n --required a,b` | Polls required GitHub checks and posts the signed result |

`gate signal --delivery-id <id>` makes retries of one unchanged callback explicit. `gate github watch` also accepts `--timeout-ms`, `--interval-ms`, and `--delivery-id` in addition to its run, stage, signal, repository, pull request, and required-check options.

There is no generic `kxm gate run <name>`. Names in `gates.json` are descriptive
unless one of the implemented commands above executes them. `github watch`
posts an exact failed signal and exits `4` on timeout.

### Mesh commands

| Command | What it does |
|---|---|
| `kxm mesh init` | Creates empty standard workspace directories; never copies package dogfood configuration |
| `kxm mesh status` | Checks `/health` and `/ready` |
| `kxm mesh tui` | Opens the real-time read-only metadata dashboard; prints one plain snapshot without a TTY |
| `kxm mesh hub` | Starts the hub and local SQLite store |
| `kxm mesh stop [--wait-ms <n>]` | Requests generation-matched hub and worker shutdown |
| `kxm mesh smoke [--real-pi]` | Runs the opt-in two-worker real-Pi release harness |

### Improvement command

```text
kxm improve [--target cli|project]
```

This groups redacted `.kxm/logs/telemetry.jsonl` records into a proposed-only
report. Named project/workflow activity is classified as `project`; unscoped
operator activity is `cli`. `KXM_IMPROVE_TARGET=cli|project` explicitly
overrides that classification. The command does not automatically modify code,
configuration, gates, or the workflow journal.

---

## Pi integration

### Interactive Pi

Set the agent variables before starting Pi:

```powershell
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$env:PI_MESH_AUTH_TOKEN = "<project-token>"
$env:PI_MESH_PROJECT = "product"
$env:PI_MESH_AGENT_NAME = "reviewer"
$env:PI_MESH_AGENT_PURPOSE = "Independent correctness reviewer"
pi
```

Use `/mesh-status` to display the current identity and connection. Ask Pi to use
the `kxm-mesh` skill before delegating complex work.

### Always-on Pi workers

`kxm agent worker` launches `pi --mode rpc`, captures its output, supervises
restarts, and stays online after every individual inference. The hub is the only
durable queue. The extension activates one message at a time and immediately
selects the next item after settlement.

Delivery priority is:

1. `steer` at the next safe turn boundary;
2. `followUp` for ordinary work; and
3. `nextTurn`, normalized to a triggered follow-up for autonomous workers.

A steer changes course; it does not abort an in-flight atomic write. Waiting
work remains `queued`. Only work entering a model turn becomes `delivered`.

### Tool and write boundaries

`--tools` restricts tool names, not filesystem paths. A review-only worker can
use:

```text
--tools read,grep,find,ls,mesh_list,mesh_send,mesh_get,mesh_await
```

A writer needs only the mutation and shell tools required by its assignment.
Roster `roles` and `ownership` fields are documentation, not runtime policy.
Use separate OS users, read-only worktrees, or containers for stronger
boundaries.

### Provider and tool recovery

- Pi's own transient retries finish first.
- A final quota/provider failure leaves the hub message recoverable, records
  bounded metadata, closes Pi cleanly, and selects the next unused fallback.
- A long-running tool beyond the watchdog follows the same recovery path without
  rotating models.
- An invalid `--continue` history retries fresh in the same binding and records a
  recovery envelope.
- Raw provider/model output remains in the protected `pi-agent-*.log`; structured
  lifecycle logs contain only bounded metadata.

---

## Workflow-specific Pi sessions

This feature prevents one long-lived Pi worker from mixing unrelated workflow
histories.

### Routing model

| Message kind | Pi session binding |
|---|---|
| Ordinary peer/operator work | Stable `{agent, default}` session |
| Root workflow prompt | `{agent, workflowRunId}` |
| Signed callback resume or timeout notification | Same workflow binding |
| Peer request with authorized `workflowContext` | Same workflow binding |
| Message with only `correlationId: run_*` | No workflow affinity; correlation is not authorization |

The hub adds a canonical, hub-owned `workflowRunId` to every workflow-origin
message. Run IDs must match `run_` plus 32 lowercase hexadecimal characters.

### Safe switch lifecycle

1. The extension examines the next queued message before acknowledgement.
2. If its binding matches, the extension acknowledges it and starts one turn.
3. If it differs, the message remains queued.
4. The extension atomically writes a metadata-only, generation-bound route
   request and asks the current Pi child to shut down.
5. The supervisor waits for the child's `close` event, updates the binding
   manifest, and starts exactly one replacement with the target `--session-dir`.
6. The destination extension reconnects and receives the same queued message ID.

No request/reply body is written to a routing file. A route request includes only
identity, supervisor generation, child incarnation, source and destination
bindings, Pi session ID, message ID, and timestamp. The supervisor also rejects symbolic-link/junction aliases
for its scoped session roots and verifies canonical containment. A malformed, stale, wrong-owner, or wrong-source request is
rejected without changing scope.

### Durability and retention

Bindings live in `.kxm/state/worker-session-binding-<workerKey>.json`. Restarting
the supervisor reloads the active binding and continues only when that session
directory has Pi JSONL history. Inactive workflow sessions are retained up to
`PI_MESH_WORKER_MAX_RUN_SESSIONS`; least-recently-used inactive entries and
directories are deleted when the bound is reached.

A corrupt binding manifest is quarantined with a `.corrupt-<timestamp>` suffix.
The supervisor does not guess a run; it creates a safe default binding. The hub
workflow run, journal, messages, assets, and Git remain the recovery authority.

### Enablement and compatibility

The upgrade-compatible default is one shared Pi history:

```text
kxm agent worker ... --session-isolation off
```

Enable scoped histories explicitly:

```text
kxm agent worker ... --session-isolation workflow
```

The first isolated start uses fresh scoped storage. KXM does not copy the old
shared `--continue` history because one shared directory may contain sessions
from several workers and cannot be attributed safely. Both the CLI and low-level
supervisor default to `off` during this compatibility release.

---

## Claude Code integration

### Configure the plugin

Provide these plugin settings:

| Setting | Example |
|---|---|
| Mesh server URL | `http://127.0.0.1:7331` |
| Authentication token | Project token, never the admin token |
| Agent name | `claude-reviewer` or `fable` |
| Agent purpose | `Independent review and UI/UX criticism` |
| Project | `product` |

Restart Claude Code after changing settings. Use `/mcp` to confirm the bundled
`pi-mesh` MCP server connected, then call `mesh_list`.

KXM does not choose the Claude model. Select the required Claude CLI/model
profile separately; the mesh identity and model session remain different
concepts.

### Pushed channel mode

During the Claude channel research preview, explicitly trust the community
channel:

```text
claude --dangerously-load-development-channels plugin:kxm-mesh@kontextmind-pi-extensions
```

If the organization has approved it through `allowedChannelPlugins`:

```text
claude --channels plugin:kxm-mesh@kontextmind-pi-extensions
```

Inbound work arrives as `<channel source="kxm-mesh" ...>` events. Process one
request, call `mesh_reply`, and keep the Claude session open for the next event.

### MCP pull mode

Without channels, Claude retains full outbound and workflow capability. For
inbound work:

1. call `mesh_inbox`;
2. process one durable request;
3. call `mesh_reply` with its message ID; and
4. repeat with bounded backoff while the inbox is empty.

Do not describe pull mode as push-driven liveness.

### Claude and Pi context differences

Per-workflow automatic Pi session routing applies to the supervised Pi worker,
not to Claude Code. A Claude operator who needs strict run isolation should use
a separate Claude session/agent identity per run or an external Claude
supervisor. Workflow authority still comes from `mesh_workflow_get`, the hub
journal, evidence, and assets—not from either harness's context window.

---

## Mesh tools

### Shared outbound and workflow tools

These tools are available in Pi and Claude MCP:

| Tool | Purpose |
|---|---|
| `mesh_list` | List online peers, purposes, and models |
| `mesh_send` | Send one focused request; returns a durable message ID |
| `mesh_fanout` | Send the same independent request to one through three peers |
| `mesh_get` | Inspect a request without blocking |
| `mesh_await` | Wait only when the response blocks progress |
| `mesh_cancel` | Cancel queued/delivered work owned by the sender |
| `mesh_workflow_list` | List durable workflow runs assigned to this coordinator |
| `mesh_workflow_get` | Read stages, evidence policies, waits, and journal |
| `mesh_workflow_checkpoint` | Submit a stage result with keyed evidence and verified message references |
| `mesh_workflow_wait` | Save evidence and pause until an authenticated callback |
| `mesh_workflow_record` | Record a plan, decision, contradiction, error, or lesson |
| `mesh_improvement_report` | Summarize learning by improvement area |

Claude MCP also exposes:

| Tool | Purpose |
|---|---|
| `mesh_inbox` | Reconcile and list durable inbound work in pull mode |
| `mesh_reply` | Reply to one inbound request |

### Messaging rules

- Use `followUp` by default; reserve `steer` for an active blocker.
- Supply an idempotency key when a send may be retried.
- A local `mesh_await` or fanout timeout does not cancel the durable message.
- Use `mesh_get` or repeat the exact idempotent operation; do not invent a new
  request while the first remains pending.
- Cancellation cannot undo filesystem or external side effects.
- Never put credentials or unnecessary private data in a mesh message.
- Keep one task and one owner per request.

---

## Durable workflows

### Configure the active definition source

Set exactly one of:

```text
PI_MESH_WEBHOOK_WORKFLOWS_FILE=.kxm/config/workflows/product.json
```

or:

```text
PI_MESH_WEBHOOK_WORKFLOWS=[...inline JSON...]
```

The hub loads only that source for its current boot. A workflow definition
contains an ID, source/provider, project, target coordinator, secret environment
variable names, filters, delivery mode, prompt template, ordered stages,
required evidence, attempt limits, and optional peer policies.

Validate before restart:

```powershell
kxm gate validate --file .kxm/config/workflows/product.json
```

Secrets belong in environment variables named by `secretEnv` and
`signalSecretEnv`, never in definition JSON.

### Start and inspect

```powershell
kxm workflow start product-workflow `
  --payload '@.kxm/assets/workflows/product/inputs/request.json' `
  --delivery-id 'ticket-123-attempt-1'
kxm workflow list
kxm workflow get run_<32-hex-characters>
```

The stable delivery ID deduplicates identical provider retries. Reusing it with
a conflicting body fails.

### Coordinator procedure

For every active stage:

1. call `mesh_workflow_get`;
2. follow only `currentStage`;
3. record material plans, decisions, contradictions, errors, and lessons;
4. gather exact required evidence;
5. send peer-policy work with exact `workflowContext` when required;
6. checkpoint or enter an external wait; and
7. correct warnings/failures until passed or attempts are exhausted.

Settling while a run is still `running` without a valid checkpoint fails the
run. Settling after a successful `mesh_workflow_wait` is expected and releases
compute until the callback creates a fresh message.

### Workflow journal categories

| Category | Use |
|---|---|
| `plan` | Intended execution and ownership |
| `decision` | Selected option and rationale |
| `contradiction` | Incompatible evidence, claims, requirements, or tests |
| `error` | Failed tools, assumptions, integrations, or gates |
| `lesson` | Evidence-supported reusable improvement |

Areas are `harness`, `gates`, `implementation`, `workflow`, `documentation`,
`security`, or `other`.

---

## Evidence gates and external callbacks

### Ordinary evidence

Every `requiredEvidence` key needs a non-empty string under the exact normalized
key. Extra evidence cannot substitute for a missing requirement.

### Peer-reply evidence

A `peer-reply` policy requires durable replies from eligible stable agent IDs.
The coordinator must send or fan out with:

```json
{
  "workflowContext": {
    "runId": "run_<32-hex>",
    "stageId": "review",
    "requirementKey": "independent review",
    "attempt": 1
  }
}
```

Then cite the replied message IDs under the exact requirement in
`evidenceRefs`. The hub verifies sender, recipient, project, run, stage,
requirement, attempt, lifecycle, and eligible producer. Quorum counts unique
producers. Caller-authored text, correlation IDs, idempotency keys, and copied
result envelopes never satisfy peer provenance.

The coordinator is never an eligible producer for its own run. Peer provenance
proves durable routing inside the shared project-token trust boundary—not truth,
model identity, non-collusion, independence, or human approval.

### Explicit degradation

Only a human/operator with the administrative token can approve a lower minimum,
and only when the policy declared one:

```powershell
kxm gate --dry-run --json degrade <runId> <stageId> `
  --requirement "independent review" --reason "documented incident"
kxm gate --json degrade <runId> <stageId> `
  --requirement "independent review" --reason "documented incident"
```

Approval is journaled and bound to the current attempt. It does not pass the
stage; the coordinator must still provide the approved minimum references.

### External waits and signals

The coordinator calls `mesh_workflow_wait` with a stable signal key, expected
result, timeout, and any already verified evidence. A separate operator or
integration posts:

```powershell
kxm gate signal <runId> github-pr-42-checks passed "CI passed" `
  "github.check:ci=https://ci.example/pr/42"
```

Callbacks are HMAC-signed, context-checked, deduplicated, and accumulated with
saved evidence. A failed callback consumes the attempt; re-enter the wait before
sending a new result.

---

## Live TUI and observability

Start the dashboard with the administrative credential:

```powershell
kxm --workspace C:\work\product\.kxm mesh tui
```

The TUI uses `@earendil-works/pi-tui`. It subscribes to authenticated
metadata-only `/v1/ops/events` and refreshes `/v1/ops/snapshot`. It never loads
or renders request/reply bodies. If admin operations access is unavailable, it
honestly labels and uses a hub-enforced presence-only SSE stream plus local
metadata. It refuses an older/unmarked stream that cannot guarantee this mode. Synthetic TUI observers
are excluded from the dashboard's own agent table and displayed counts, while
remaining ordinary authenticated hub identities during fallback.

| Key | Action |
|---|---|
| `Up` / `Down` | Select a panel; scroll on narrow terminals |
| `Enter` / `Space` | Toggle selected panel |
| `1`–`4` | Reveal Agents, Messages, Runs, or PIDs |
| `PgUp` / `PgDn`, `Ctrl+U` / `Ctrl+D` | Scroll content |
| `h` / `?` | Toggle help |
| `Esc` | Close help, then quit |
| `q` / `Ctrl+C` | Quit |

Without a TTY, the command prints one ANSI-free snapshot. Use
`kxm mesh status --json` for a health result intended for automation.

### Health and operations endpoints

| Endpoint | Authentication | Content |
|---|---|---|
| `GET /health` | none | Liveness and online-agent count |
| `GET /ready` | none | Storage readiness |
| `GET /metrics` | admin outside loopback | Prometheus metrics |
| `GET /v1/ops/snapshot?project=<p>` | admin | Project-scoped metadata, no bodies |
| `GET /v1/ops/events?project=<p>` | admin | Metadata-only SSE wakeups |

Structured hub and worker logs omit message bodies. Raw `pi-agent-*.log` files
may contain model output and must be protected accordingly.

---

## Reliability, privacy, and security

### Delivery guarantees

- SQLite is the durable source for agents, messages, runs, and journals.
- Queued and delivered messages replay after hub or agent restart.
- Delivery is at-least-once, not exactly-once.
- Make external side effects idempotent and use stable delivery/message keys.
- Terminal messages expire after the configured retention window.

### Privacy contract

- The TUI and operations SSE are metadata-only.
- Structured logs include actors, project, delivery, status, model, and state,
  but not prompt/reply bodies.
- SQLite stores message bodies as sent and is not application-encrypted.
- Raw Pi logs may contain model/tool output.
- Routing manifests and requests contain no message or reply bodies.

Protect `.kxm/state` and `.kxm/logs` with OS permissions and encrypted storage
where required.

### Security boundaries

- Bind to loopback by default.
- Use distinct high-entropy admin and project credentials.
- Give workers only project tokens.
- Terminate TLS at a trusted proxy for remote access and disable SSE buffering.
- Protect workflow HMAC secrets separately from mesh tokens.
- Treat plugin extension paths and skills as executable privileged inputs.
- Do not rely on prompts, roster roles, or ownership fields as a sandbox.
- Do not expose the hub directly to the public internet.

Session isolation prevents accidental model-context mixing; it is not a sandbox
against a hostile process running under the same OS account. A shell-capable
agent can reach files and routing environment values available to that account.
Use separate accounts, containers, read-only worktrees, or stricter tool sets
when the agent itself is outside the trust boundary.

---

## Backup, upgrade, and recovery

### Backup

SQLite uses WAL mode. The simplest safe backup is:

1. stop the hub gracefully;
2. copy `.kxm/state/mesh.db` to protected storage;
3. record the package version and reviewed configuration; and
4. restart and verify `/ready`.

For online backup, use a SQLite-aware backup tool or capture the database,
`-wal`, and `-shm` consistently.

Pi session directories are supplementary model history, not authoritative
workflow state. Include them only if your recovery policy needs local model
context.

### Upgrade

1. back up SQLite;
2. install the target release;
3. stop the old hub and workers cleanly;
4. start the new hub against the same database;
5. verify health, readiness, operations SSE, and one request/reply; and
6. restart workers so they use the matching extension and supervisor release.

### Session-state recovery

| Event | Meaning | Action |
|---|---|---|
| `worker_session_routed` | Expected clean child swap to another binding | No action unless repeated for one message |
| `worker_session_evicted` | Inactive LRU run history removed at the configured bound | Preserve workflow facts in journal/assets/Git |
| `worker_session_state_recovered` | Invalid manifest quarantined; safe default created | Inspect `.corrupt-*`, hub run state, and disk/concurrency health |
| `worker_session_request_rejected` | Route request failed identity/schema/source checks | Check release match, generation, permissions, and duplicate supervisors |
| `worker_continue_fallback` | Pi history could not continue; same binding starts fresh | Read recovery journal and durable message state |

Never repair a live route by editing state files. Stop the exact worker first,
preserve evidence, and recover from hub-owned workflow state.

---

## Troubleshooting checklist

1. Confirm `kxm mesh hub` is running.
2. Check `/health`, then `/ready`.
3. Compare URL, project, and project token on both agents.
4. Confirm unique live names.
5. Run `/mesh-status` in Pi or `mesh_list` in Pi/Claude.
6. Inspect structured logs without copying secrets or raw model content.
7. For queued workflow work, look for the one expected session route swap.
8. For a delivered message, inspect the recipient and activation/tool watchdogs;
   do not send duplicates.
9. For a workflow, call `mesh_workflow_get` and use the exact active stage,
   requirement keys, attempt, wait key, and coordinator.
10. For Claude, inspect `/mcp`; if channel push is unavailable, use
    `mesh_inbox`/`mesh_reply`.

Common causes:

| Symptom | Likely cause |
|---|---|
| `kxm` not found | Only the Pi package was installed; install the release CLI or use the source wrapper |
| Pi shows `mesh:offline` | URL/token/project mismatch, duplicate live name, missing extension, or unreachable hub |
| Claude tools missing | Plugin not reloaded, MCP bundle unavailable, or unsupported Node version |
| Request stays queued | Recipient offline/SSE unavailable, or one safe Pi session swap is in progress |
| Request stays delivered | Agent turn, approval, tool, provider, or settlement is still active |
| Fanout returns pending | Local wait expired; use returned message IDs, not replacement sends |
| Workflow cannot advance | Missing exact evidence, wrong attempt/context, insufficient verified producers, or exhausted attempts |
| Admin route returns 401/403 | Project token used where the distinct admin token is required |
| Degradation returns 503 | Hub has no configured administrative credential |
| Shared workflow memory appears | Worker is using the upgrade-compatible isolation `off` default; restart explicitly with `--session-isolation workflow` |

See [Troubleshooting](troubleshooting.md) for error-specific recovery.

---

## Feature availability matrix

| Feature | Operator CLI | Pi | Claude Code |
|---|---:|---:|---:|
| Start/stop hub and workers | Yes | No | No |
| Initialize workspace | Yes | No | No |
| Peer discovery | Status/TUI only | `mesh_list` | `mesh_list` |
| Send, poll, wait, cancel | No | Yes | Yes |
| Fanout to 1–3 peers | No | Yes | Yes |
| Pushed inbound turns | N/A | Native extension | Optional channel |
| Pull inbox and explicit reply | N/A | Extension owns queue | `mesh_inbox`, `mesh_reply` |
| Always-on worker supervision | Starts Pi worker | Yes | External Claude supervision required |
| Workflow-specific model sessions | Configures mode | Automatic for supervised Pi | Use separate Claude sessions externally |
| Workflow list/get | Local SQLite CLI | Mesh tools | Mesh tools |
| Start signed workflow | Yes | No | No |
| Checkpoint/wait/journal | No | Yes | Yes |
| Peer provenance context/references | No | Yes | Yes |
| Admin quorum degradation | Yes | Forbidden | Forbidden |
| Signed external signal | Yes | No | No |
| GitHub check watcher | Yes | No | No |
| Artifact existence gate | Yes | Can invoke CLI if shell is allowed | Can invoke CLI if shell is allowed |
| Retrospective export | Yes | Can record source evidence | Can record source evidence |
| Proposed telemetry improvement report | Yes | `mesh_improvement_report` covers workflow journal separately | Same |
| Live metadata-only TUI | Yes | No | No |

---

## Related pages

- [Getting started](getting-started.md)
- [Configuration reference](configuration.md)
- [Architecture](architecture.md)
- [Operations guide](operations.md)
- [Webhook workflows](webhook-workflows.md)
- [Peer provenance and quorum gates](provenance-gates.md)
- [Troubleshooting](troubleshooting.md)
- [Test matrix](test-matrix.md)
- [Changelog](../CHANGELOG.md)
