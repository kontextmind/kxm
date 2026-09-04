# KontextMind workspace

`.kxm` is the canonical home for repository-local Pi Mesh configuration, logs, assets, and runtime state.

| Directory | Contents | Git policy |
|---|---|---|
| `config/` | Reviewable workflow and harness configuration without secrets | Tracked |
| `logs/` | Hub, worker, and agent process logs | Ignored except documentation |
| `assets/` | Durable workflow inputs and outputs that belong to this workspace | Track intentionally; generated content is ignored |
| `state/` | SQLite and other restart-recovery state | Ignored except documentation |

Secrets remain in environment variables or an approved secret manager. Do not put tokens, webhook secrets, credentials, or private prompt dumps anywhere under `.kxm/config`.

All directory defaults derive from `.kxm`. Set `KXM_WORKSPACE_DIR` to relocate the complete workspace or use a specific path override when an operator-managed volume requires it.
