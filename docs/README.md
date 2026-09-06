# Documentation

This documentation is organized by task. Start with the guide that matches what you are trying to accomplish.

| Guide | Audience | Purpose |
|---|---|---|
| [KXM Handbook](kxm-handbook.md) | Operators, Pi users, and Claude Code users | Wiki-ready installation, configuration, and complete feature guide |
| [Getting started](getting-started.md) | Pi and Claude Code users | Complete the first successful multi-agent exchange |
| [Configuration](configuration.md) | Users and operators | Understand every supported setting and default |
| [Architecture](architecture.md) | Maintainers and integrators | Learn the component boundaries and message lifecycle |
| [Operations](operations.md) | Hub operators | Run, monitor, secure, and recover the service |
| [Troubleshooting](troubleshooting.md) | Everyone | Diagnose common installation and delivery failures |
| [Test matrix](test-matrix.md) | Users and maintainers | Map features and use cases to automated evidence |
| [Webhook workflows](webhook-workflows.md) | Automation owners | Start durable work from Jira or another signed webhook |
| [Peer provenance and quorum gates](provenance-gates.md) | Workflow authors and security reviewers | Require durable replies from eligible peer identities without overstating the trust guarantee |
| [Continuous improvement](continuous-improvement.md) | Product and engineering leads | Turn run evidence into reviewed workflow improvements |
| [OpenRouter Model Workforce Guide](openrouter-model-workforce-guide.md) | Workflow designers and operators | Comprehensive OpenRouter models, roles, workflows, and routing guide |
| [Agent Envelopes & Quality Gates](agent-communication-envelopes-and-gates.md) | Multi-agent workflow engineers | Production communication envelopes, quality gates, and work loops |
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
