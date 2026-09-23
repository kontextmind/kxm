# Documentation

This documentation is organized by task. Start with the guide that matches what you are trying to accomplish.

| Guide | Audience | Purpose |
|---|---|---|
| [KXM Handbook](kxm-handbook.md) | Operators, Pi users, and Claude Code users | Wiki-ready installation, configuration, and complete feature guide |
| [Getting started](start/quickstart-pi.md) | Pi and Claude Code users | Complete the first successful multi-agent exchange |
| [Configuration](reference/configuration.md) | Users and operators | Understand every supported setting and default |
| [CLI reference](reference/cli-reference.md) | Operators and agent authors | Every `kxm` command and subcommand with options, JSON output, and examples |
| [Configuration file reference](reference/config-reference.md) | Project and workflow authors | Every `.kxm` file schema field by field, with validated examples and a worked two-step project |
| [Native harness or OpenRouter](reference/harness-routing.md) | Operators choosing models | Decide which route runs a model reachable both natively and through an aggregator, and confirm which route a config line uses |
| [Architecture](concepts/architecture.md) | Maintainers and integrators | Learn the component boundaries and message lifecycle |
| [Terminal components](contributing/tui-components.md) | Maintainers and integrators | The reusable panel kit behind `kxm dash` and every configuration surface |
| [Packages and workspaces](contributing/packages.md) | Maintainers | Workspace layout, Nx targets, Bun task running, and the layer gate |
| [Agent Skills](guides/agent-skills.md) | Users and integrators | Comprehensive skill suite covering all KXM commands with progressive disclosure |
| [Browser automation](guides/browser-automation.md) | Developers and operators | Self-hosted Steel on DOKS, agent-browser, Playwright, pass-cli, and human takeover. See the [knowledge base](guides/browser-automation.md#knowledge-base) and [prompt templates](guides/browser-automation.md#prompt-templates) |
| [Skills](guides/governed-skills.md) | Operators and skill authors | Governed candidate lifecycle; also the [repository work delivery](contributing/repo-work-delivery.md) skill |
| [Operations](operations/deploy.md) | Hub operators | Run, monitor, secure, and recover the service |
| [Troubleshooting](operations/troubleshooting.md) | Everyone | Diagnose common installation and delivery failures |
| [Test matrix](contributing/test-matrix.md) | Users and maintainers | Map features and use cases to automated evidence |
| [Webhook workflows](guides/webhook-workflows.md) | Automation owners | Start durable work from Jira or another signed webhook |
| [Peer provenance and quorum gates](guides/provenance-gates.md) | Workflow authors and security reviewers | Require durable replies from eligible peer identities without overstating the trust guarantee |
| [Continuous improvement](guides/continuous-improvement.md) | Product and engineering leads | Turn run evidence into reviewed workflow improvements |
| [Workflow guide](reference/workflow-catalog.md) | Workflow designers and operators | Area -> Workflow -> Stage -> Role taxonomy with documentation slugs, dated research candidates, and selection policy |
| [Templates](templates/README.md) | Workflow authors | Markdown templates for features, ADRs, reviews, runbooks, and related artifacts |
| [Agent Envelopes & Quality Gates](../plans/history/agent-communication-envelopes-draft.md) | Multi-agent workflow engineers | Production communication envelopes, quality gates, and work loops |
| [Assignment runner](contributing/assignment-runner.md) | Maintainers and developers | Native developer assignments, deterministic witness verification, and multi-vendor dual-critic acceptance |
| [This host's Pi packages](../plans/history/operator-pi-packages.md) | Maintainers on this development host | Snapshot of operator `pi list` packages and file extensions; not a KXM install requirement |
| [KXM contract package](contracts/README.md) | Maintainers and reviewers | Review the accepted local-first target architecture and implementation contracts |

Project-level policies live at the repository root:

- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

## Documentation principles

- Put the shortest successful path before optional details.
- Use the product terms **hub**, **agent**, **peer**, **project**, **request**, and **reply** consistently.
- Distinguish verified behavior from planned behavior; `docs/contracts` is a planned normative target until activation.
- Distinguish durable single-node delivery from clustering and exactly-once execution.
- Update the relevant guide in the same change that modifies user-visible behavior.

## Which docs each workflow relies on

Cross-reference only. Guide slugs imply no runtime config, admission, schema, or
CLI behavior.

| Workflow slug | Primary docs |
|---|---|
| `build-feature` | [Getting started](start/quickstart-pi.md), [Configuration](reference/configuration.md), [Architecture](concepts/architecture.md), [Test matrix](contributing/test-matrix.md) |
| `refactor-repair-regressions` | [Architecture](concepts/architecture.md), [Test matrix](contributing/test-matrix.md), [Troubleshooting](operations/troubleshooting.md), [Provenance gates](guides/provenance-gates.md) |
| `stabilize-flaky-tests` | [Test matrix](contributing/test-matrix.md), [Operations](operations/deploy.md), [Troubleshooting](operations/troubleshooting.md) |
| `design-software-system` | [Architecture](concepts/architecture.md), [Configuration](reference/configuration.md), [KXM contracts](contracts/README.md) |
| `investigate-incident` | [Operations](operations/deploy.md), [Troubleshooting](operations/troubleshooting.md), [Webhook workflows](guides/webhook-workflows.md) |
| `patch-vulnerability` | [Provenance gates](guides/provenance-gates.md), [Operations](operations/deploy.md), [Configuration](reference/configuration.md) |
