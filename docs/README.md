# KXM documentation

KXM connects coding agents through a durable, authenticated [hub](glossary.md#hub) and runs workflows in a local [Runtime](glossary.md#runtime). Start with a quick start, use the guides for tasks, and use the reference for exact commands, files, tools and endpoints. The [glossary](glossary.md) defines every term these pages use.

**Groups:** [Start here](#start-here) · [Guides](#guides) · [Reference](#reference) · [Concepts](#concepts) · [Operations](#operations) · [Contributing](#contributing)

## Start here

| Page | For | What you get |
|---|---|---|
| [Install KXM](start/install.md) | Everyone | The `kxm` CLI from npm, the Claude Code plugin, the Pi package, or a source checkout |
| [Quick start: Claude Code](start/quickstart-claude-code.md) | Claude Code users | A new or existing project connected to a local hub, and how to update the CLI and plugin |
| [Run your first workflow](start/first-workflow.md) | Project owners | A workflow written, trust-reviewed, run and driven to a verified receipt |
| [Quick start: Pi](start/quickstart-pi.md) | Pi users | Two Pi agents, or Pi and Claude Code, exchanging peer requests |
| [Glossary](glossary.md) | Everyone | Every KXM term, including the ones that are easy to confuse |

## Guides

| Page | For | What you get |
|---|---|---|
| [Message peer agents](guides/peer-messaging.md) | Agent users | Send, await, fan out, cancel and reply; delivery modes, TTL and idempotency |
| [Run supervised Pi workers](guides/pi-workers.md) | Operators | Long-lived Pi agents with fallbacks, tool allowlists and one session per workflow run |
| [Run webhook workflows](guides/webhook-workflows.md) | Automation owners | Signed starts from Jira, GitHub or any webhook, durable waits and signed callbacks |
| [Peer provenance and quorum gates](guides/provenance-gates.md) | Workflow authors, security reviewers | Stages that require hub-verified replies from eligible peers |
| [Context and memory](guides/context-and-memory.md) | Agent users, project owners | Context packets, recall, temporal state, episodes, the wiki and Git memory |
| [Continuous improvement](guides/continuous-improvement.md) | Leads, workflow authors | Journals, retrospectives, improvement reports and coded-repeat candidates |
| [Governed skills](guides/governed-skills.md) | Operators, skill authors | The candidate, evaluation, promotion and rejection lifecycle |
| [Agent skills](guides/agent-skills.md) | Users of any harness | The bundled `SKILL.md` suite and how each harness loads it |
| [Browser automation](guides/browser-automation.md) | Developers, operators | Steel browser sessions, Playwright, safe credentials and human takeover |
| [Nous providers](guides/nous-providers.md) | Pi operators | Opt-in Nous Portal models for Pi agents |

### Browser knowledge base

| Page | For | What you get |
|---|---|---|
| [How are credentials retrieved without exposing them to the model?](kb/how-credentials-retrieved-safely.md) | Browser operators | How agents log in without the model seeing secrets |
| [How do I capture a UI section and annotate changes for an agent?](kb/how-to-capture-and-annotate-section.md) | Browser operators | Send an agent a marked-up UI section to change |
| [How do I connect Playwright to the existing Steel session?](kb/how-to-connect-playwright-to-steel.md) | Browser operators | Attach Playwright to an existing Steel session |
| [How do I recover an expired session or remove an orphaned browser?](kb/how-to-recover-expired-session-or-orphan.md) | Browser operators | Restore a session or remove an orphaned browser |
| [How does an agent resume after MFA?](kb/how-to-resume-after-mfa.md) | Browser operators | Continue agent work after a person completes MFA |
| [How do I take over a browser session to log in?](kb/how-to-take-over-session.md) | Browser operators | Log in by hand inside an agent's browser session |
| [Why did authentication disappear?](kb/why-authentication-disappeared.md) | Browser operators | Causes and fixes for a lost login |
| [Why did automation open a different browser?](kb/why-automation-opened-different-browser.md) | Browser operators | Causes and fixes when a local browser opens instead of the Steel session |
| [Why can I view a session but not control it?](kb/why-session-viewer-cannot-control.md) | Browser operators | Why the viewer shows the stream but not your clicks, and what to use instead |

### Browser prompt templates

| Page | For | What you get |
|---|---|---|
| [Task template: start browser work in a KXM project](prompts/browser-start.md) | Agent operators | A prompt that opens browser work in a KXM project |
| [Task template: explore an application with an authenticated session](prompts/browser-explore.md) | Agent operators | A prompt for exploring with an authenticated session |
| [Task template: reproduce a UI bug and produce a Playwright regression test](prompts/browser-repro-fix.md) | Agent operators | A prompt that ends in a Playwright regression test |
| [Task template: capture UI section annotations and send changes to an agent](prompts/browser-annotate-feedback.md) | Agent operators | A prompt that turns section annotations into changes |
| [Task template: request human authentication and resume afterward](prompts/browser-takeover.md) | Agent operators | A prompt that asks a person to log in, then resumes |
| [Task template: diagnose and recover a failed browser session](prompts/browser-diagnose-recover.md) | Agent operators | A prompt for a failed browser session |

## Reference

| Page | For | What you get |
|---|---|---|
| [KXM CLI reference](reference/cli-reference.md) | Operators, agent authors | Every `kxm` command with its options, output and examples |
| [KXM configuration file reference](reference/config-reference.md) | Project and workflow authors | Every `.kxm` file field by field, the workspace layout and configuration layers |
| [Environment variables and limits](reference/configuration.md) | Operators | Environment variables, limits and defaults for the hub, agents and workers |
| [Harness routing: native harness or Pi aggregator](reference/harness-routing.md) | Operators choosing models | Native harness or Pi route for a model, admission, and how to check the route used |
| [Agent tools reference](reference/tools.md) | Agent authors | The `kxm_*` MCP and Pi tools, `/kxm` commands, plugin hooks and plugin options |
| [Hub HTTP API reference](reference/http-api.md) | Integrators, operators | Hub endpoints for health, metrics, operations, messages, webhooks, signals, leases and sync |
| [Workflow definition reference](reference/workflow-definitions.md) | Workflow authors | Webhook definition fields, evidence policies and `kxm.workflow.v1` steps |
| [Workflow catalog](reference/workflow-catalog.md) | Workflow designers | The area, workflow, stage and role taxonomy, with the docs each workflow relies on |
| [KXM Claude Code plugin](../plugins/kxm/README.md) | Claude Code users | Plugin options, tokens, the SessionStart hook, tools, channel mode and fixes |

## Concepts

| Page | For | What you get |
|---|---|---|
| [Architecture](concepts/architecture.md) | Integrators, maintainers | The components, message and workflow lifecycles, and KXM's limits |
| [Trust model](concepts/trust-model.md) | Operators, security reviewers | Who holds which credential, project boundaries, and what provenance proves |
| [Data and storage](concepts/data-and-storage.md) | Operators, security reviewers | What each store holds, where it lives and how long it is kept |
| [Architecture decision records](adr/README.md) | Maintainers | The decision records: [browser automation](adr/ADR-0002-browser-automation-steel-doks.md), [SQLite-only store](adr/ADR-0003-sqlite-only-store.md), [edge identity](adr/ADR-0004-edge-identity-authentik.md) |
| [KXM contract package](contracts/README.md) | Maintainers, reviewers | The normative specifications for the local-first architecture, listed below |

### Contracts

| Page | For | What you get |
|---|---|---|
| [ADR-001: Local Runtime, project authority, and aggregate hub](contracts/architecture.md) | Maintainers | The architecture decision the contracts implement |
| [Canonical terminology](contracts/terminology.md) | All contributors | The normative definitions the [glossary](glossary.md) builds on |
| [Durable lifecycles](contracts/lifecycles.md) | Maintainers | Run, step, assignment, attempt, effect and delivery states |
| [Effects, idempotency, and recovery](contracts/effects-and-recovery.md) | Maintainers | Effect classes, the crash matrix, `blocked_uncertain` and recovery rules |
| [Hub synchronization contract](contracts/synchronization.md) | Maintainers | What the Runtime sends the hub, and how the hub accepts it |
| [Routing and cost telemetry](contracts/routing.md) | Maintainers | Routing records, cost bases and the routing report |
| [Configuration and contract validation](contracts/validation.md) | Maintainers | The YAML parser profile, the validation pipeline, schema evolution and the gate registry |
| [Migration and compatibility](contracts/migration.md) | Maintainers, operators | What KXM refuses rather than converts, and why |

## Operations

| Page | For | What you get |
|---|---|---|
| [Deploy KXM](operations/deploy.md) | Hub operators | Deployment classes, supervision, and hosted per-tenant hubs behind a proxy |
| [Monitor KXM](operations/monitoring.md) | Hub operators | `kxm dash`, health and readiness, metrics, logs and alerts |
| [Back up and restore KXM](operations/backup-and-restore.md) | Hub operators | `kxm backup` and `kxm restore`, the state roots, and a stopped-hub recipe |
| [Upgrade KXM](operations/upgrade.md) | Operators | `kxm update`, the plugin reinstall, rollback and schema ceilings |
| [Operate Runtime sync and leases](operations/runtime-sync.md) | Operators | The Runtime-to-hub outbox, refusals, `kxm runtime sync-retry` and leases |
| [Troubleshoot KXM](operations/troubleshooting.md) | Everyone | Symptoms, causes and fixes, grouped by area |

## Contributing

| Page | For | What you get |
|---|---|---|
| [Develop KXM](contributing/development.md) | Contributors | Setup, build and verify, packaging, and the repository layout |
| [CI and release](contributing/ci-and-release.md) | Maintainers | What CI runs on each change and how releases ship |
| [Write KXM documentation](contributing/writing-docs.md) | Contributors | The style rules, the page template and the docs checks |
| [Test matrix](contributing/test-matrix.md) | Maintainers | Features and use cases mapped to automated evidence |
| [Assignment runner](contributing/assignment-runner.md) | Maintainers | Developer assignments, witness verification and dual-critic acceptance |
| [Packages and workspaces](contributing/packages.md) | Maintainers | Workspace layout, Nx targets, Bun task running and the layer gate |
| [KXM terminal components](contributing/tui-components.md) | Maintainers, integrators | The panel kit behind `kxm dash` |
| [Repository work delivery skill](contributing/repo-work-delivery.md) | Contributors | The repository-local skill for delivering a change |
| [Operating rules](contributing/operating-rules.md) | Agents, maintainers | The operator's standing instructions, dated, and where each is enforced |
| [Learnings](contributing/learnings.md) | Agents, maintainers | Durable lessons from running the writer, landing, and docs loops |
| [Artifact templates](templates/README.md) | Workflow authors | Document templates and where workflows use them |

The templates: [feature](templates/feature.md) · [bug fix](templates/bug-fix.md) · [ADR](templates/adr.md) · [architecture](templates/architecture.md) · [research](templates/research.md) · [review](templates/review.md) · [test plan](templates/test-plan.md) · [test report](templates/test-report.md) · [runbook](templates/runbook.md) · [postmortem](templates/postmortem.md) · [handoff](templates/handoff.md).

## Documentation principles

- **Shortest path first.** Each page opens with what it helps you do; the working path comes before options and background.
- **Current behavior only.** Pages describe what the code does today, with no release numbers in prose. Planned behavior lives in [contracts](contracts/README.md) and [decisions](adr/README.md), marked as planned. Changes are recorded in the [changelog](../CHANGELOG.md).
- **Honest boundaries.** Wherever a feature could be over-read, the page says what is not guaranteed: single node, at-least-once delivery, no sandboxing, provenance rather than truth.
- **One vocabulary.** Pages use the [glossary](glossary.md) terms and qualify overloaded words such as run, session, gate, skill and project.
- **Bash first.** Examples show Bash; PowerShell appears only where the syntax differs.
- **Docs change with code.** A change to user-visible behavior updates the relevant page in the same pull request. [Write KXM documentation](contributing/writing-docs.md) has the full style guide.

## Related

- [Project README](../README.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Code of conduct](../CODE_OF_CONDUCT.md)
- [Changelog](../CHANGELOG.md)
- [License](../LICENSE)
