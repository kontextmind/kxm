# Environment variables and limits

This page lists every environment variable KXM reads, what it controls and its default, and the fixed limits the [hub](../glossary.md#hub) and its clients enforce. Use it when you run a hub, a long-lived Pi worker, or an agent against a hub. The files under `.kxm/` and the `kxm.config.v1` preference keys are in the [configuration file reference](config-reference.md); commands are in the [CLI reference](cli-reference.md).

## Where settings come from

KXM reads settings from four places. The first three merge key by key into one `kxm.config.v1` view; environment variables configure processes and never override a `kxm.config.v1` key. The [configuration layering diagram](config-reference.md#configuration-layers) shows the same order.

| Layer | Location | Written by | Wins over |
|---|---|---|---|
| Built-in defaults | `plugins/kxm/src/config.ts` | Nobody; ships with KXM | Nothing |
| User preferences | `~/.config/kxm/config.yaml`, or `$KXM_USER_CONFIG_DIR/config.yaml` | `kxm config set <key> <value> --scope user` | Built-in defaults |
| Project preferences | `<project root>/.kxm/config.yaml` | `kxm config set <key> <value>` (project is the default scope) | User preferences |
| Environment variables | The shell, service manager, container, or secret manager that starts the process | You | Values persisted on this machine by `kxm hub start` and `kxm hub bind` |

Only `hub.autoStart` and the `improvement.*` keys change behavior today. The reviewed project files (`project.yaml`, `agents/`, `workflows/`, `gates.yaml` and the rest) are a separate, Git-tracked bundle that no environment variable overrides.

> [!WARNING]
> Keep tokens and secrets in environment variables or a secret manager. Never commit them, put them in a `.kxm/*.yaml` file, or pass them as command-line arguments.

## Environment-variable classification

Names that start with `KXM_` are not all operator settings. This map covers every name the KXM source reads from the environment.

| Group | Variables | Documented in |
|---|---|---|
| Hub process | `KXM_HOST`, `KXM_PORT`, `KXM_AUTH_TOKEN`, `KXM_PROJECT_TOKENS`, `KXM_DATA_PATH`, `KXM_LOG_PATH`, `KXM_MESSAGE_*`, `KXM_RATE_LIMIT_*` | [Hub settings](#hub-settings) |
| Workspace directories | `KXM_WORKDIR`, `KXM_WORKSPACE_DIR`, `KXM_CONFIG_DIR`, `KXM_LOGS_DIR`, `KXM_ASSETS_DIR`, `KXM_STATE_DIR` | [Workspace directories](#workspace-directories) |
| Webhook workflows | `KXM_WEBHOOK_WORKFLOWS`, `KXM_WEBHOOK_WORKFLOWS_FILE`, plus each definition's `secretEnv` and `signalSecretEnv` | [Webhook workflow settings](#webhook-workflow-settings) |
| Agents | `KXM_SERVER_URL`, `KXM_AUTH_TOKEN`, `KXM_PROJECT`, `KXM_AGENT_NAME`, `KXM_AGENT_PURPOSE` | [Agent settings](#agent-settings) |
| Long-lived Pi workers | `KXM_PI_COMMAND`, `KXM_WORKER_*` (operator settings), `KXM_AGENT_LOG_PATH` | [Long-lived worker settings](#long-lived-worker-settings) |
| Runtime supervisor | `KXM_STATE_HOME`, `KXM_RUNTIME_SYNC_INTERVAL_MS`, `KXM_RUNTIME_STOP_GRACE_MS` | [Runtime supervisor settings](#runtime-supervisor-settings) |
| Operator CLI and sessions | `KXM_USER_CONFIG_DIR`, `KXM_USER_TELEMETRY_DIR`, `KXM_SESSION_TOKEN`, `KXM_SESSION_BRIEF`, `KXM_WORKFLOW_*`, `GITHUB_TOKEN`, and others | [CLI and session settings](#cli-and-session-settings) |
| Nous model providers | `KXM_NOUS_PROVIDERS`, `KXM_NOUS_PROXY_URL`, `KXM_NOUS_DISCOVERY_TIMEOUT_MS`, `KXM_NOUS_CATALOG_FILE`, `NOUS_API_KEY` | [Nous providers](../guides/nous-providers.md) |
| Browser automation | `STEEL_API_URL`, `STEEL_API_KEY`, `STEEL_UI_URL`, `USE_PASS_CLI` | [Browser automation](../guides/browser-automation.md) |
| Set by a harness, not by you | `KXM_PROJECT_DIR` (Claude Code plugin), `KXM_ATTEMPT_TOKEN` (Runtime attempts), `KXM_WORKER_IDENTITY_KEY`, `KXM_WORKER_GENERATION`, `KXM_WORKER_CHILD_INCARCATION`, `KXM_WORKER_SESSION_SCOPE` (worker supervisor to its Pi child) | [Internal variables](#internal-variables) |
| Maintainer and test only | `KXM_SMOKE*`, `KXM_ASSET*`, `KXM_RELEASE_TAG`, `KXM_PUBLISH_WAIT_MS`, `KXM_DETERMINISTIC_TEST_CLOCK`, `KXM_WORKER_STOP_AFTER_MS`, `KXM_STUDIO_ONCE` | [Development](../contributing/development.md) |
| Maintainer critic script | `KXM_CRITIC_DIR`, `KXM_REVIEW_TARGET` | [Maintainer critic script](#maintainer-critic-script) |
| Not environment variables | `KXM_SLASH_SUBCOMMANDS`, `KXM_UPDATE_CACHE`, `KXM_UPDATE_SCHEMA`, and other `KXM_*_SCHEMA` constants | Source constants; do not set them |

## Hub settings

`kxm hub start` reads these when it starts the hub. Restart the hub after you change one.

| Variable | Default | Effect |
|---|---|---|
| `KXM_HOST` | `127.0.0.1` | Listening interface. Any non-loopback value requires `KXM_AUTH_TOKEN`, or the hub refuses to start |
| `KXM_PORT` | `7331` | TCP port, an integer from 0 to 65535; `0` picks a free port |
| `KXM_AUTH_TOKEN` | Persisted or generated (see below) | Administrative bearer token. Also accepted as the project token for any project without its own entry |
| `KXM_PROJECT_TOKENS` | Persisted value, else none | JSON object mapping project names to project tokens, for example `{"web":"replace-with-a-web-token"}`. Replaces the whole saved map |
| `KXM_DATA_PATH` | `$KXM_STATE_DIR/kxm.db` | SQLite database. `:memory:` keeps nothing across a restart; use it only for disposable runs |
| `KXM_LOG_PATH` | `$KXM_LOGS_DIR/kxm-hub.jsonl` | Structured JSON Lines hub log |
| `KXM_MESSAGE_TTL_MS` | `86400000` (24 hours) | Default request lifetime, at least `1000` |
| `KXM_MESSAGE_RETENTION_MS` | `604800000` (7 days) | How long replied, cancelled and expired messages are kept, at least `1000` |
| `KXM_RATE_LIMIT_MAX` | `600` | Requests accepted per client and window, at least `1` |
| `KXM_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window, at least `100` |

### Hub credentials

When `KXM_AUTH_TOKEN` is unset, `kxm hub start` reuses the admin token saved in `hub-env.json` under the [user state root](config-reference.md#state-outside-the-project). On first start it generates one, saves it with `0600` permissions, and reuses it on every restart, so workers and dashboards on the same machine share one credential. Delete the file and restart the hub to rotate a generated token.

Explicit `KXM_AUTH_TOKEN` and `KXM_PROJECT_TOKENS` values win and are saved for later restarts. `KXM_PROJECT_TOKENS` replaces the saved map rather than merging with it: a value that omits a project drops that project's token. List every project each time you set it; [Start the hub](../start/quickstart-claude-code.md#3-start-the-hub) shows a command that merges a new project into the saved map.

A project token is an authorization boundary: it registers agents only in its project and sees only that project's agents, messages and runs. Give agents project tokens and keep the admin token for operators. The [trust model](../concepts/trust-model.md) shows which credential reaches which endpoint.

> [!IMPORTANT]
> A hub on loopback with no admin token trusts every local caller and prints `auth=none`. `kxm hub start` always resolves or generates a token, so this happens only when you run the hub entry point directly.

### Hub auto-start from the Pi extension

The `hub.autoStart` preference controls whether the Pi extension starts a hub itself. The default is `background`: on load the extension reuses a healthy bound hub, a live local hub claim, or a hub already answering at `KXM_SERVER_URL`, and only otherwise starts one in the background, logging to `.kxm/logs/hub-autostart.log`. Set `hub.autoStart: off` with `kxm config set hub.autoStart off` to disable it. The Claude Code plugin never starts a hub.

### Hub log contents

The hub log records metadata, not message bodies. A context request is logged by size only: `context_packet_assembled` carries `taskChars`, `taskTokens` and `matchedCandidates`, and `context_recall` carries `queryChars`, `queryTokens`, `limit` and `results`. The task and query text appear only in the caller's own response. The SQLite database stores message bodies as sent and is not encrypted by KXM, so protect `.kxm/state/`.

## Workspace directories

The hub, the CLI and the worker supervisor keep runtime files under one workspace directory. Set only `KXM_WORKSPACE_DIR` and the four derived directories move with it.

| Variable | Default | Effect |
|---|---|---|
| `KXM_WORKDIR` | The current directory | Base for relative paths; the repository a Pi worker runs in |
| `KXM_WORKSPACE_DIR` | `.kxm` | Root of the derived directories below |
| `KXM_LOGS_DIR` | `$KXM_WORKSPACE_DIR/logs` | Hub, worker and Pi logs |
| `KXM_ASSETS_DIR` | `$KXM_WORKSPACE_DIR/assets` | Durable workflow assets and exported retrospectives |
| `KXM_STATE_DIR` | `$KXM_WORKSPACE_DIR/state` | Hub database, Pi sessions, worker manifests and recovery files |
| `KXM_CONFIG_DIR` | `$KXM_WORKSPACE_DIR/config` | Legacy. Created on start; read only by `kxm session start`. JSON files there make a project unloadable (`legacy_state_unsupported`) |

These variables never move the project configuration files, which always live in `<project root>/.kxm/`. The CLI's `--workspace <dir>` flag overrides all of them for one command. See [Workspace layout](config-reference.md#workspace-layout-tracked-ignored-and-state) for what to commit and what to ignore.

## Webhook workflow settings

Configure exactly one of these on the hub. With both set, the hub refuses to start.

| Variable | Default | Effect |
|---|---|---|
| `KXM_WEBHOOK_WORKFLOWS_FILE` | None | Path to a JSON file holding an array of [webhook workflow definitions](workflow-definitions.md#webhook-workflow-definitions) |
| `KXM_WEBHOOK_WORKFLOWS` | None | The same JSON array, inline |

Each definition names the variables that hold its secrets (`secretEnv`, `signalSecretEnv`); those variables must be set in the hub's environment when it starts, and in the environment of `kxm workflow start`, `kxm gate signal` and `kxm gate github watch`. Check a file with `kxm gate validate --file <path>` before you restart the hub.

## Agent settings

Every agent client (the Pi extension, the Claude Code MCP server, and the `kxm peer` commands) reads these.

| Variable | Default | Effect |
|---|---|---|
| `KXM_SERVER_URL` | `http://127.0.0.1:7331` | Hub base URL. For the CLI, the machine's `kxm hub bind` URL is used when this is unset |
| `KXM_AUTH_TOKEN` | See below | The project token for this agent's project |
| `KXM_PROJECT` | `name` in `package.json` in the working directory, else the directory name | Project for discovery and authentication |
| `KXM_AGENT_NAME` | Harness-specific (see below) | Name peers see; unique among online agents in the project, compared case-insensitively |
| `KXM_AGENT_PURPOSE` | Harness-specific (see below) | One line peers use to decide what to send this agent |

| Harness | Default name | Default purpose | Token when `KXM_AUTH_TOKEN` is unset |
|---|---|---|---|
| Pi extension | The Pi session name, else `pi-<pid>` | `General-purpose coding agent` | The admin token of a hub it auto-started, else the saved admin token |
| Claude Code MCP server | `claude` from the plugin settings, else `claude-<pid>` | `Claude Code implementation and review agent` | This project's saved project token only; never the admin token |
| `kxm peer` commands | `cli-<pid>` | `CLI agent client` | The saved project token for the project, else the saved admin token |

A clean shutdown marks an identity offline. Reconnecting with the same project and name resumes its durable agent ID and rotates its agent key. If the Claude Code name is already online in the project, the MCP server registers once more as `<name>-<pid>`.

## Claude Code plugin settings

The plugin asks for `server_url`, `auth_token`, `agent_name`, `agent_purpose` and `project` when you install it, and passes them to its MCP server as `KXM_SERVER_URL`, `KXM_AUTH_TOKEN`, `KXM_AGENT_NAME`, `KXM_AGENT_PURPOSE` and `KXM_PROJECT`. It also sets `KXM_PROJECT_DIR` to the directory Claude Code started in. Change them with `/plugin configure kxm@kxm`. Every field, default and token rule is in [Claude Code plugin settings](config-reference.md#claude-code-plugin-settings) and the [plugin README](../../plugins/kxm/README.md).

## Long-lived worker settings

`kxm agent worker` starts a supervised headless Pi process and passes these to it. The command's flags (`--model`, `--tools`, `--session-isolation` and the rest) set the same values; see [`kxm agent worker`](cli-reference.md#kxm-agent). How to run workers safely is in [Pi workers](../guides/pi-workers.md).

| Variable | Default | Effect |
|---|---|---|
| `KXM_AGENT_NAME`, `KXM_PROJECT` | None; required | The worker's identity in the hub |
| `KXM_PI_COMMAND` | `pi`, or `pi.cmd` on Windows | Pi executable when it is not on `PATH` |
| `KXM_WORKER_MODEL` | Pi's default | Primary model selector |
| `KXM_WORKER_FALLBACK_MODELS` | None | Up to eight comma-separated selectors, tried in order after a final provider failure. Requires `KXM_WORKER_MODEL` |
| `KXM_WORKER_PROVIDER_RETRY_MS` | `60000` | Retry delay after a final provider failure with no unused fallback, `1000` to `3600000` |
| `KXM_WORKER_TOOLS` | Pi's defaults | Allowlist of 1 to 64 comma-separated Pi tool names |
| `KXM_WORKER_EXTENSION_PATHS` | Discovery | 1 to 16 extension files, separated by `:` (`;` on Windows); relative paths resolve inside `KXM_WORKDIR` |
| `KXM_WORKER_SKILL_PATHS` | Discovery | 1 to 16 skill files or directories, same separator and base |
| `KXM_WORKER_CONTINUE` | `true` | Resume the active Pi session after a restart; `false` never resumes |
| `KXM_WORKER_INITIAL_CONTINUE` | Same as `KXM_WORKER_CONTINUE` | `false` starts this supervisor's first child fresh and still resumes later restarts |
| `KXM_WORKER_SESSION_ISOLATION` | `off` | `workflow` gives each workflow run its own Pi session beside a stable default session |
| `KXM_WORKER_MAX_RUN_SESSIONS` | `128` | Workflow-specific sessions kept per worker, `1` to `1024`; least recently used inactive ones are evicted |
| `KXM_WORKER_TOOL_TIMEOUT_MS` | `1860000` (31 minutes) | Watchdog for one Pi tool call, `1000` to `86400000`; `0` disables it |
| `KXM_WORKER_ACTIVATION_TIMEOUT_MS` | `60000` | Deadline for a delivered request to start a model turn, `1000` to `600000`; expiry restarts the child and keeps the request |
| `KXM_WORKER_DRAIN_MS` | `15000` | Graceful shutdown wait before the child is killed |
| `KXM_WORKER_MAX_RESTARTS` | Unlimited | Non-negative restart limit |
| `KXM_WORKER_LOG_PATH` | `$KXM_LOGS_DIR/kxm-worker-<project>-<agent>-<id>.jsonl` | Structured supervisor lifecycle log |
| `KXM_AGENT_LOG_PATH` | `$KXM_LOGS_DIR/pi-agent-<project>-<agent>-<id>.log` | Captured Pi stdout and stderr. May contain model output; protect it |

Two rules matter for safety. Setting either resource-path variable turns off discovery for that category only, and the listed extensions and skills run with the worker's repository, network and model credentials, so review them like executable dependencies and never derive them from a webhook payload. The tool allowlist bounds tool names, not file paths: a worker that keeps `write`, `edit` or a shell tool can change any file its OS user can reach.

For example, a review-only worker that cannot edit the checkout:

```bash
export KXM_WORKER_TOOLS="read,grep,find,ls,kxm_list,kxm_get,kxm_reply"
kxm agent worker --name reviewer --project <project> --model openrouter/qwen/qwen3-coder-plus
```

<details><summary>PowerShell</summary>

```powershell
$env:KXM_WORKER_TOOLS = "read,grep,find,ls,kxm_list,kxm_get,kxm_reply"
kxm agent worker --name reviewer --project <project> --model openrouter/qwen/qwen3-coder-plus
```

</details>

## Runtime supervisor settings

The Runtime supervisor runs `kxm run` workflows and syncs their summaries to the hub. See [Runtime sync](../operations/runtime-sync.md).

| Variable | Default | Effect |
|---|---|---|
| `KXM_STATE_HOME` | macOS `~/Library/Application Support/KXM`; Windows `%LOCALAPPDATA%\KXM`; Linux `$XDG_STATE_HOME/kxm`, else `~/.local/state/kxm` | User state root: Runtime event stores, supervisor token, `hub-env.json`, `hub-binding.json`, `update.yaml`. Must be absolute (`local_state_root_not_absolute`) |
| `KXM_RUNTIME_SYNC_INTERVAL_MS` | `10000` | How often the supervisor heartbeats and pushes its outbox, clamped to `250` through `60000` |
| `KXM_RUNTIME_STOP_GRACE_MS` | `30000` | How long a stopping supervisor waits for open drives, `0` to `600000`; an invalid value warns and uses the default |

## CLI and session settings

| Variable | Default | Effect |
|---|---|---|
| `KXM_USER_CONFIG_DIR` | `~/.config/kxm` | User preferences, global roles and workflows, `session.token`, shell completions |
| `KXM_USER_TELEMETRY_DIR` | `~/.config/kxm/telemetry` | User telemetry directory |
| `KXM_SESSION_TOKEN` | None | Session token whose tool policy limits the `kxm_*` tools. When unset, the `session.token` file applies if present. An invalid or expired token blocks every tool |
| `KXM_SESSION_BRIEF` | Picker on | `off` disables the Pi task and plan picker at session start; the status line still shows |
| `KXM_WORKFLOW_ID` | None | Default definition for `kxm workflow start`; required by `kxm gate signal` and `kxm gate github watch` for a hub run |
| `KXM_WORKFLOW_SECRET`, `KXM_WORKFLOW_SIGNAL_SECRET` | None | Start and callback secrets, used only when no active definition source is configured |
| `GITHUB_TOKEN`, `GH_TOKEN` | None | GitHub API token for `kxm gate github watch` and `kxm update` |
| `KXM_IMPROVE_TARGET` | Inferred | `cli` or `project`; overrides the `target` label written on telemetry events. Nothing reads the label yet |
| `KXM_SKIP_COMPLETION_PROMPT`, `KXM_SKIP_GUIDE_SETUP_PROMPT` | Unset | Any value skips the interactive `kxm init` prompts for shell completion and workflow-catalog setup |
| `KXM_OPENROUTER_MODELS_URL` | OpenRouter's public model list | Catalog URL for `kxm models inventory-refresh`; `OPENROUTER_API_KEY` is sent when set |
| `KXM_BIN` | `kxm` | CLI the Pi `/kxm memory` command runs |
| `NO_COLOR`, `KXM_TUI_NO_COLOR` | Unset | Any value turns off color in `kxm dash` and the terminal panels |
| `KXM_PICK_SELECT` | Unset | Answers an interactive role picker with an index or ID, for scripts |
| `KXM_DAEMON` | Unset | `1` or `true` stops structured loggers from echoing to stdout |
| `KXM_ENTRY` | The running script | Entry point `kxm completion install` resolves the CLI directory from |
| `KXM_SESSION_ID` | Unset | Session ID stamped on gate command result envelopes |

## Internal variables

KXM sets these for its own child processes. Do not set them yourself.

| Variable | Set by | Purpose |
|---|---|---|
| `KXM_PROJECT_DIR` | Claude Code plugin (`.mcp.json`) | Directory Claude Code started in; decides the default project and whether this is a KXM project |
| `KXM_ATTEMPT_TOKEN` | Runtime attempt dispatch | Attempt-scoped tool policy; `kxm_promote` needs an explicit grant in it |
| `KXM_WORKER_IDENTITY_KEY`, `KXM_WORKER_GENERATION`, `KXM_WORKER_CHILD_INCARCATION` | Worker supervisor | Binds the Pi child to its supervisor generation and incarnation |
| `KXM_WORKER_SESSION_SCOPE` | Worker supervisor | `default`, `legacy` or `workflow:<run-id>`: the session scope the child may serve |
| `KXM_USER_STATE_DIR`, `KXM_STATE_ROOT` | None (legacy aliases) | Read only by the local snapshot reader when `KXM_STATE_HOME` is unset; use `KXM_STATE_HOME` |

## Maintainer critic script

`scripts/native-critic.mjs`, a maintainer tool in the KXM repository, runs a read-only Claude or Codex review, saves the result as a JSON artifact, and posts a notice through the hub. It reads two variables of its own. Neither is part of the shipped CLI.

| Variable | Default | Effect |
|---|---|---|
| `KXM_CRITIC_DIR` | `.kxm/assets/critic-reviews` in the current directory | Where the review artifact is written, with `0600` permissions |
| `KXM_REVIEW_TARGET` | The critic's own agent ID | Online agent, by name or ID, that receives the `review completed` notice |

The notice is transport only: it is not approval or hub peer-reply evidence.

## Protocol limits

The hub and its clients enforce these fixed values. None of them is configurable except where the table names a variable.

### Messages and transport

| Limit | Value |
|---|---|
| Message content | 32,000 characters |
| HTTP request body | 256 KiB (`payload_too_large`) |
| Request lifetime (`ttlMs`) | 1 second to 7 days; default 24 hours (`KXM_MESSAGE_TTL_MS`) |
| Terminal message retention | 7 days (`KXM_MESSAGE_RETENTION_MS`) |
| Hop limit (`maxHops`) | Default 5, at most 20 |
| Idempotency key, correlation ID | 128 characters each |
| Agent name, purpose, project, host label | 64, 256, 128 and 64 characters |
| Rate limit | 600 requests per 60 seconds per agent or address (`KXM_RATE_LIMIT_*`) |

### Presence, waits and timeouts

| Limit | Value |
|---|---|
| Agent heartbeat interval | 10 seconds |
| Agent stale threshold (presence lease) | 30 seconds |
| SSE heartbeat | 15 seconds |
| Client request timeout | 15 seconds |
| `kxm_await` wait | 60 seconds, default and maximum |
| `kxm_fanout` local wait (`timeoutMs`) | 100 ms to 30 minutes; default 30 minutes |
| Workflow signal wait | 1 second to 30 days; default 24 hours |
| Fenced lease TTL | 5 seconds to 10 minutes; default 5 minutes |
| Runtime sync batch | 100 events |

### Workflows and context

| Limit | Value |
|---|---|
| Evidence per checkpoint or wait | 64 keys; each key 128 characters, each value 1,000 characters |
| Evidence references | 32 requirements; 1 to 16 message IDs each |
| Checkpoint or wait summary | 4,000 characters |
| Journal entry | Summary 1,000 characters, details 8,000, 32 evidence strings, 16 related entries |
| Context task, role | 2,000 and 64 characters |
| Context budget (`budgetTokens`) | 512 to 200,000; default by role, 32,000 for an unknown role |
| Recall results | 1 to 100; default 25 |
| Finished hub workflow runs and their journal | Purged 7 days after they finish; not configurable. Exported retrospectives remain |

Limits on webhook workflow definitions are in [Workflow definitions](workflow-definitions.md#limits).

### Timeouts, retries and idempotency

`ttlMs` bounds how long a request stays valid, including time queued behind other work. `kxm_fanout.timeoutMs` bounds only how long the caller waits. A local wait that ends first returns `status: pending` with the durable `messageId`; it does not cancel the request. Normally omit `ttlMs` for model work.

An automated sender should set a stable `idempotencyKey`, so an exact retry returns the original message instead of a duplicate. Reusing a key with different content fails with `idempotency_conflict`. While a request is pending, check it with `kxm_get` or repeat the exact call; do not mint a new key. `kxm_fanout` derives each target's key from `idempotencyKeyPrefix`, the correlation ID and the target name.

Correlation IDs and idempotency keys never prove where evidence came from. For a peer-reply requirement, pass `workflowContext` and cite the replies in `evidenceRefs`; see [Peer provenance and quorum gates](../guides/provenance-gates.md).

When a Pi peer's final response exceeds 32,000 characters, the extension replies with a truncated response and a note instead of leaving the request pending. The full output may remain in that peer's Pi session or `pi-agent-*.log`.

## Delivery modes

A request's `delivery` tells the receiving harness when to handle it.

| Mode | Use it when | Effect |
|---|---|---|
| `followUp` | Normal delegation; the default | Handled after the receiver's current work settles |
| `steer` | An active blocker needs a course change | Delivered at the receiver's next decision boundary |
| `nextTurn` | Context that should not interrupt | Stored with the message. The Pi extension handles it like `followUp`; the Claude MCP server passes it on as `delivery` metadata |

Webhook workflow definitions accept only `followUp` and `steer`, and `kxm_fanout` always sends `followUp`.

## Related

- [Configuration file reference](config-reference.md): every `.kxm` file and `kxm.config.v1` key
- [CLI reference](cli-reference.md): every command and flag
- [Agent tools](tools.md): the `kxm_*` tools and their parameters
- [Hub HTTP API](http-api.md): routes, credentials and error codes
- [Trust model](../concepts/trust-model.md): which credential reaches what
- [Nous providers](../guides/nous-providers.md): opt-in Nous model providers for Pi
