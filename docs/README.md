# Documentation

This documentation is organized by task. Start with the guide that matches what you are trying to accomplish.

| Guide | Audience | Purpose |
|---|---|---|
| [KXM Handbook](kxm-handbook.md) | Operators, Pi users, and Claude Code users | Wiki-ready installation, configuration, and complete feature guide |
| [Getting started](getting-started.md) | Pi and Claude Code users | Complete the first successful multi-agent exchange |
| [Configuration](configuration.md) | Users and operators | Understand every supported setting and default |
| [Architecture](architecture.md) | Maintainers and integrators | Learn the component boundaries and message lifecycle |
| [Agent Skills](agent-skills.md) | Users and integrators | Comprehensive skill suite covering all KXM commands with progressive disclosure |
| [Operations](operations.md) | Hub operators | Run, monitor, secure, and recover the service |
| [Troubleshooting](troubleshooting.md) | Everyone | Diagnose common installation and delivery failures |
| [Test matrix](test-matrix.md) | Users and maintainers | Map features and use cases to automated evidence |
| [Webhook workflows](webhook-workflows.md) | Automation owners | Start durable work from Jira or another signed webhook |
| [Peer provenance and quorum gates](provenance-gates.md) | Workflow authors and security reviewers | Require durable replies from eligible peer identities without overstating the trust guarantee |
| [Continuous improvement](continuous-improvement.md) | Product and engineering leads | Turn run evidence into reviewed workflow improvements |
| [Workflow guide](workflow-guide.md) | Workflow designers and operators | Area -> Workflow -> Stage -> Role taxonomy with documentation slugs, dated research candidates, and selection policy |
| [Agent Envelopes & Quality Gates](agent-communication-envelopes-and-gates.md) | Multi-agent workflow engineers | Production communication envelopes, quality gates, and work loops |
| [Assignment runner](assignment-runner.md) | Maintainers and developers | Native developer assignments, deterministic witness verification, and multi-vendor dual-critic acceptance |
| [This host's Pi packages](operator-pi-packages.md) | Maintainers on this development host | Snapshot of operator `pi list` packages and file extensions; not a KXM install requirement |
| [vNext contract package](vnext/README.md) | Maintainers and reviewers | Review the accepted local-first target architecture and implementation contracts |

Project-level policies live at the repository root:

- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [Changelog](../CHANGELOG.md)

## Documentation principles

- Put the shortest successful path before optional details.
- Use the product terms **hub**, **agent**, **peer**, **project**, **request**, and **reply** consistently.
- Distinguish verified behavior from planned behavior; `docs/vnext` is a planned normative target until activation.
- Distinguish durable single-node delivery from clustering and exactly-once execution.
- Update the relevant guide in the same change that modifies user-visible behavior.

## Which docs each workflow relies on

Cross-reference only. Guide slugs imply no runtime config, admission, schema, or
CLI behavior.

| Workflow slug | Primary docs |
|---|---|
| `build-feature` | [Getting started](getting-started.md), [Configuration](configuration.md), [Architecture](architecture.md), [Test matrix](test-matrix.md) |
| `refactor-repair-regressions` | [Architecture](architecture.md), [Test matrix](test-matrix.md), [Troubleshooting](troubleshooting.md), [Provenance gates](provenance-gates.md) |
| `stabilize-flaky-tests` | [Test matrix](test-matrix.md), [Operations](operations.md), [Troubleshooting](troubleshooting.md) |
| `design-software-system` | [Architecture](architecture.md), [Configuration](configuration.md), [vNext contracts](vnext/README.md) |
| `investigate-incident` | [Operations](operations.md), [Troubleshooting](troubleshooting.md), [Webhook workflows](webhook-workflows.md) |
| `patch-vulnerability` | [Provenance gates](provenance-gates.md), [Operations](operations.md), [Configuration](configuration.md) |
