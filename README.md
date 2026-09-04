# KontextMind Pi Extensions

[![CI](https://github.com/kontextmind/kxm/actions/workflows/ci.yml/badge.svg)](https://github.com/kontextmind/kxm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22.19+ or 24+](https://img.shields.io/badge/node-22.19%2B%20%7C%2024%2B-339933.svg)](https://nodejs.org/)

Give running coding agents a small, dependable communication plane.

**Pi Mesh Comms** lets Pi and Claude Code agents discover one another, send focused requests, continue working independently, and collect replies without sharing an oversized conversation. It provides communication primitives—not an autonomous swarm manager—so each agent keeps its own context and safety controls.

> **Project status:** Production candidate (`0.4.x`) for a single hub serving local or trusted-team agents. Durable delivery, signed webhook workflows, operator CLI, security controls, observability, and recovery are tested. It is not a horizontally scaled or multi-tenant orchestration service. See [Production boundaries](#production-boundaries).

## Why use it?

- **Delegate deliberately.** Route a bounded task to a peer selected by name and purpose.
- **Stay productive.** Poll for a result or wait only when the reply blocks progress.
- **Mix harnesses.** Connect native Pi sessions and Claude Code through the same hub.
- **Keep control.** Authentication, project isolation, message limits, and normal agent approval rules remain in place.
- **Install using native formats.** One repository packages a Pi extension, an Agent Skill, and a Claude Code marketplace plugin.
- **Start from real events.** Signed Jira, GitHub, or generic webhooks can prompt durable, long-lived coordinators.
- **Release idle turns.** Coordinators can wait durably for signed CI, review, merge, or Jira callbacks and resume only when work remains.
- **Verify peer provenance.** Per-requirement quorum gates count unique eligible producers from immutable, attempt-bound replied messages rather than coordinator-authored claims.
- **Learn from every run.** Capture plans, decisions, contradictions, errors, and lessons without turning unreviewed opinions into policy.

## Quick start: two Pi agents

You need Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer, plus Pi, Git, and two terminal windows.

### 1. Start the hub

```powershell
git clone https://github.com/kontextmind/kxm.git
cd kxm
npm ci
$env:KXM_AUTH_TOKEN = "replace-with-an-admin-token"
$env:KXM_PROJECT_TOKENS = '{"demo":"replace-with-a-demo-project-token"}'
npm run hub
```

The hub listens on `http://127.0.0.1:7331`. Keep this terminal running.

### 2. Install the Pi package

Run once:

```text
pi install git:github.com/kontextmind/kxm
```

If the repository is private, Git must already be authenticated for an account that has access.
This Pi package install supplies the extension and Agent Skill to Pi; it does
not place the `kxm` operator command on `PATH`.

### 3. Start each agent

Set the same server, `demo` project token, and project in both agent terminals; do not give agents the administrative token. Give each agent a unique name and a useful purpose.

```powershell
$env:KXM_SERVER_URL = "http://127.0.0.1:7331"
$env:KXM_AUTH_TOKEN = "replace-with-a-demo-project-token"
$env:KXM_PROJECT = "demo"
$env:KXM_AGENT_NAME = "planner"
$env:KXM_AGENT_PURPOSE = "Plans work and coordinates handoffs"
pi
```

Start the second terminal as `reviewer`, `builder`, or another role. In Pi, run `/mesh-status` to confirm the connection.

### 4. Delegate a task

```text
Use the kxm skill. List the available peers, ask the reviewer to
inspect this plan for correctness risks, continue any independent work, and
collect the review before finalizing.
```

For a Pi-to-Claude setup, follow [Getting started](docs/getting-started.md#connect-claude-code).

## Command-first operation

The `kxm` entry point manages one workspace consistently. Tools are `agent`, `session`, `workflow`, `gate`, and `mesh`. Runtime configuration, logs, durable state, and generated retrospectives stay under `.kxm` unless `--workspace` selects another root.

Install the packed release asset before using the command. GitHub CLI keeps
this flow compatible with private repositories; run `gh auth login` first when
the current account is not authenticated.

```powershell
$version = "<release-version>"
$asset = "kxm-$version.tgz"
$releaseDir = Join-Path $PWD ".kxm-release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
gh release download "v$version" --repo kontextmind/kxm --pattern $asset --dir $releaseDir --clobber
npm install --global --omit=peer (Join-Path $releaseDir $asset)
kxm mesh help
```

To operate from a clone instead, run `npm ci` in the clone and replace
`kxm` below with `node scripts/kxm.mjs`. Do not use
`npm install --global git+https://github.com/kontextmind/kxm.git` as
the operator install path; the supported global install is the versioned release
tarball.

In the hub terminal, initialize the workspace and load the Jira definition with
distinct administrative, project, workflow-start, and callback credentials:

```powershell
kxm mesh init
# Create or copy a reviewed definition to .kxm/config/workflows/jira-development.json.
$env:KXM_AUTH_TOKEN = "replace-with-the-admin-token"
$env:KXM_PROJECT_TOKENS = '{"product":"replace-with-the-project-token"}'
$env:JIRA_WEBHOOK_SECRET = "replace-with-the-workflow-start-secret"
$env:WORKFLOW_SIGNAL_SECRET = "replace-with-the-callback-secret"
$env:KXM_WEBHOOK_WORKFLOWS_FILE = ".kxm/config/workflows/jira-development.json"
kxm gate validate --file .kxm/config/workflows/jira-development.json
kxm hub start
```

In a separately supervised coordinator terminal, give the single writer only
the project credential and the tools required by the full Jira lifecycle. This
PowerShell example uses the Windows shell tool; replace `powershell` with `bash`
on macOS or Linux.

```powershell
$env:KXM_AUTH_TOKEN = "replace-with-the-project-token"
$coordinatorTools = @(
  "read", "powershell", "edit", "write", "grep", "find", "ls",
  "kxm_list", "kxm_send", "kxm_fanout", "kxm_get", "kxm_await",
  "kxm_workflow_get", "kxm_workflow_checkpoint", "kxm_workflow_wait",
  "kxm_workflow_record", "kxm_improvement_report"
) -join ","
kxm agent worker --name coordinator --project product --model xai/grok-4.6 `
  --fallback-models antigravity/gemini-3.1-pro --tools $coordinatorTools `
  --session-isolation workflow --fresh-start
```

Give review-only peers `read,grep,find,ls`; do not copy the coordinator's shell
or write capabilities to them. In an operator terminal, start and inspect work,
then run external watchers with the separate callback secret:

```powershell
$env:KXM_WORKFLOW_SECRET = "replace-with-the-workflow-start-secret"
$env:KXM_WORKFLOW_ID = "jira-development"
$env:KXM_WORKFLOW_SIGNAL_SECRET = "replace-with-the-callback-secret"
$env:GITHUB_TOKEN = "replace-with-a-checks-read-token"
kxm workflow start jira-development --payload '@ticket.json'
kxm workflow list
kxm workflow get run_123
kxm gate github watch --run-id run_123 --stage-id push-watch `
  --signal-key pr-42-checks --repo org/repo --pr 42 --required ci
kxm workflow export run_123
kxm hub stop
```

Use `--dry-run --json` to inspect mutation plans without exposing configured
token or secret values. Terminal workflows export proposed Markdown and JSON
retrospectives automatically; review them before adopting any improvement as
policy. Provenance quorum degradation is a separate admin-only operation; use
the [provenance runbook](docs/provenance-gates.md#degrade-only-through-an-explicit-admin-decision)
only for a workflow whose evidence policy declares a lower minimum.

## What is included?

| Component | What it does | Packaging |
|---|---|---|
| Mesh hub | Persists presence and routes authenticated HTTP/SSE messages | Node.js executable + SQLite |
| Pi extension | Adds communication, workflow, journal, and improvement tools | `pi.extensions` |
| Agent Skill | Teaches agents a safe, efficient coordination workflow | `pi.skills` and `SKILL.md` |
| Claude bridge | Exposes the same workflow plane through MCP and optional channel events | Claude Code plugin |
| Marketplace | Makes the Claude plugin installable from this repository | Claude marketplace catalog |

## How it works

```text
Pi planner ──HTTP──┐
                   ├── Mesh hub ──SSE──> addressed inbound requests
Pi reviewer ─HTTP──┤      │
                   │      └── presence, heartbeats, message state
Claude Code ─MCP───┘
```

The hub routes messages; it does not merge contexts, choose tasks, or bypass tool permissions. A typical request moves through `queued` → `delivered` → `replied`. It may instead end as `cancelled`, `expired`, or `error`. The sender can check it with `kxm_get`, wait with `kxm_await`, or stop pending work with `kxm_cancel`. A local `kxm_fanout` wait ending is nonterminal: it returns a durable pending handle that can be checked with `kxm_get` or retried with the same correlation and idempotency prefix.

## Documentation

| If you want to… | Read |
|---|---|
| Install, configure, and use every KXM surface | [KXM Handbook](docs/kxm-handbook.md) |
| Complete a Pi-to-Pi or Pi-to-Claude setup | [Getting started](docs/getting-started.md) |
| Configure the hub or an agent | [Configuration reference](docs/configuration.md) |
| Understand components and message flow | [Architecture](docs/architecture.md) |
| Run the hub responsibly | [Operations guide](docs/operations.md) |
| Fix connection or delivery problems | [Troubleshooting](docs/troubleshooting.md) |
| See which behaviors and examples are verified | [Test matrix](docs/test-matrix.md) |
| Start work from Jira or another webhook | [Webhook workflows](docs/webhook-workflows.md) |
| Require verified replies from eligible peers | [Peer provenance and quorum gates](docs/provenance-gates.md) |
| Improve the harness and delivery process from evidence | [Continuous improvement](docs/continuous-improvement.md) |
| Develop or submit a change | [Contributing](CONTRIBUTING.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
| Review user-facing changes | [Changelog](CHANGELOG.md) |

The [documentation index](docs/README.md) describes the intended audience and scope of each guide.

## Claude Code installation

Inside Claude Code:

```text
/plugin marketplace add kontextmind/kxm
/plugin install kxm
/reload-plugins
```

The plugin provides peer messaging plus workflow listing, checkpoints, structured journal capture, and project improvement reports. See the [plugin tool table](plugins/kxm/README.md#tools).

Pushed Claude channel delivery is a research-preview feature. Community channels currently require an explicit development-channel launch:

```text
claude --dangerously-load-development-channels plugin:kxm
```

Without channel mode, ordinary MCP tools still work; use `kxm_inbox` and `kxm_reply` for inbound requests. See [Getting started](docs/getting-started.md#connect-claude-code) for the complete flow.

## Production boundaries

The codebase is structured, typed, persisted, tested, packaged, and CI-gated. The current hub is suitable for production use on one workstation or a controlled trusted-team host, with these deliberate limits:

- One process owns one SQLite database; there is no clustering, leader election, or shared-state failover.
- Project tokens isolate hub access by project, but there are no per-user roles or external identity provider.
- Peer quorum proves durable message provenance only within the shared project-credential boundary; it does not prove truth, model independence, non-collusion, or human approval.
- Delivery is durable and retry-safe when callers supply an idempotency key, but it is not exactly-once execution.
- Rate-limit counters reset after restart, and capacity depends on the host and SQLite workload.
- The hub does not coordinate filesystem ownership; use separate worktrees or a single-writer rule.
- A non-loopback deployment requires authentication, TLS termination, process supervision, and network access controls.

The [operations guide](docs/operations.md) explains backup, recovery, monitoring, upgrade, and the safe deployment envelope.

## Package standards

This repository follows the native package structures for:

- [Pi package discovery](https://pi.dev/docs/latest/packages) through the `pi-package` keyword and `pi.extensions` / `pi.skills` manifests;
- portable [Pi Agent Skills](https://pi.dev/docs/latest/skills) using `<skill-name>/SKILL.md`;
- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference) through `.claude-plugin/plugin.json`;
- [Claude marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) through `.claude-plugin/marketplace.json`;
- standard MCP stdio tools and the optional [Claude channel](https://code.claude.com/docs/en/channels-reference) capability.

## Development

```powershell
npm ci
npm run test:coverage
npm run check
npm run check:generated
npm run validate:claude
npm pack --dry-run
```

Run the complete local gate with `npm run validate`. See [Contributing](CONTRIBUTING.md) before changing the protocol or generated runtimes.

## Repository layout

```text
.kxm/                          Workspace configuration, logs, assets, and state
.claude-plugin/                 Claude marketplace catalog
.github/                        CI and contribution templates
docs/                           User, operator, and architecture guides
plugins/kxm/
├── .claude-plugin/             Claude plugin manifest
├── dist/                       Generated self-contained CLI, hub, and MCP runtimes
├── skills/                     Portable Agent Skill
└── src/                        Pi extension, hub, client, and MCP source
scripts/                        Build and consistency helpers
test/                           Integration tests
examples/                       Executable transport scenarios and callback sender
scripts/kxm-worker.mjs      Restarting headless Pi RPC worker
```

## License

[MIT](LICENSE) © KontextMind contributors.
