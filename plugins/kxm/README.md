# KXM Claude Code plugin

This plugin connects a Claude Code session to a KXM hub. Claude can then exchange requests with Pi and Claude peers, work on durable workflow runs, and read the project's KXM context. The same directory is also the source of the repository's Pi extension and of the KXM Agent Skills.

This page is the plugin reference. For the whole path from an empty repository to a first workflow (initialize, start the hub, install this plugin, run a workflow), follow the root README: [Set up a new project with Claude Code](../../README.md#set-up-a-new-project-with-claude-code).

## Requirements

- Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer, on the `PATH` that Claude Code uses. The plugin's MCP server and its hook both run `node`.
- A running KXM hub that Claude Code can reach. The operator starts it with [`kxm hub start`](../../docs/cli-reference.md#kxm-hub-start).
- A project token for this project on that hub. See [Which token to use](#which-token-to-use).
- The `kxm` CLI, to create projects and run the hub. The plugin does not install it:

  ```bash
  npm install --global --omit=peer @kontextmind/kxm
  ```

The plugin's hook and MCP server run from the plugin's own bundled files, so they do not need `kxm` on `PATH`.

`kxm init` writes no Git ignore rules. Add `.kxm/state/` and `.kxm/logs/` to `.gitignore` yourself, and commit the rest of `.kxm/`. [Workspace layout](../../docs/config-reference.md#workspace-layout-tracked-ignored-and-state) lists what to track.

## Install

In Claude Code:

```text
/plugin marketplace add kontextmind/kxm
/plugin install kxm@kxm
/reload-plugins
```

Choose project scope to share the plugin with everyone who works in the repository.

From a shell, the same install at project scope:

```bash
claude plugin marketplace add kontextmind/kxm
claude plugin install kxm@kxm --scope project \
  --config server_url=http://127.0.0.1:7331 \
  --config agent_name=<unique agent name> \
  --config agent_purpose="<what this agent does>" \
  --config project=<hub project key>
```

A project-scope install writes `{"enabledPlugins": {"kxm@kxm": true}}` to `.claude/settings.json`. Claude Code then prints `1 userConfig option not yet set` for the empty `auth_token`, which is expected on the machine that runs the hub.

Enter `auth_token` only at `/plugin configure kxm@kxm` inside Claude Code. Do not pass it with `--config`, which leaves the token in your shell history.

To check the connection, start Claude Code in the project (or run `/reload-plugins`), confirm in `/mcp` that the `kxm` server is connected, and ask Claude to call `kxm_list`. It lists this session in your hub project.

## Configure

Claude Code asks for these options when you install the plugin. Change them later with `/plugin configure kxm@kxm`, then restart Claude Code: the MCP server reads them when it starts. The plugin's `.mcp.json` passes each option to the MCP server as an environment variable.

| Option | Variable | Default | What to enter |
|---|---|---|---|
| `server_url` | `KXM_SERVER_URL` | `http://127.0.0.1:7331` | URL of the KXM hub. The SessionStart hook probes the same URL. |
| `auth_token` | `KXM_AUTH_TOKEN` | Blank | The project token for this project, from the hub's `KXM_PROJECT_TOKENS`. Leave it blank on the machine that runs the hub. Never the hub admin token. Marked sensitive. |
| `agent_name` | `KXM_AGENT_NAME` | `claude` | Name other agents see. The first active session in a project keeps it; a later concurrent session registers as `<name>-<pid>`. |
| `agent_purpose` | `KXM_AGENT_PURPOSE` | `Claude Code implementation and review agent` | One line that peers use to decide what to send this agent. |
| `project` | `KXM_PROJECT` | Blank | Hub project key. It must match a key in the hub's `KXM_PROJECT_TOKENS`. Blank uses the `name` in `package.json` in the project directory, then the directory name. |

The MCP server also receives `KXM_PROJECT_DIR`, set to the directory Claude Code was started in (`CLAUDE_PROJECT_DIR`). It decides the default project key and whether this is a KXM project (one with a `.kxm/` directory).

### Which token to use

The plugin acts as an agent of one hub project and authenticates with that project's token. It never uses the hub admin token.

- On the machine that runs the hub, leave `auth_token` blank. The MCP server then uses the project token the hub saved for this project in `hub-env.json` under the user state root (`KXM_STATE_HOME`, or the platform default listed in [State outside the project](../../docs/config-reference.md#state-outside-the-project)). It uses only that entry, never the admin token saved beside it.
- On any other machine, enter this project's token at `/plugin configure kxm@kxm`. Get it from whoever runs the hub, through your password manager.
- Never enter the hub admin token. It is the operator's credential. The hub accepts it for any project that has no token of its own, so an agent holding it could act in projects it was never given.
- Without a project token, every `kxm_*` tool fails with `KXM has no project token for project <p> on this machine`, and the MCP server does not contact the hub.

To give a project a token, the operator adds it to `KXM_PROJECT_TOKENS` and restarts the hub. That variable replaces the hub's saved token map rather than merging with it, so it must list every project, existing and new. The root README section [Add Claude Code to an existing KXM project](../../README.md#add-claude-code-to-an-existing-kxm-project) has a command that builds the full map. Run it in your own terminal, and never paste tokens or `hub-env.json` into Claude.

## What the plugin adds

### MCP server

`.mcp.json` starts `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.js` over stdio. The server registers with the hub as `agent_name` in the hub project:

- at startup, when the project directory has `.kxm/`, a project token is available, and the KXM session policy (if any) allows `kxm_inbox` and `kxm_reply`. Peers see the session, and requests can reach it, before Claude calls any tool.
- otherwise, at the first `kxm_*` tool call.

The server's instructions tell Claude to call `kxm_context` with its role and task before planning in a KXM project, and to answer peer requests with `kxm_reply`. When a tool reports a hub or token problem, the error names the fix, and Claude is told to continue without KXM and pass that step on to you.

### SessionStart hook

The plugin registers one SessionStart hook: `node ${CLAUDE_PLUGIN_ROOT}/dist/claude-hook.js session-start`, with a 5-second timeout. Claude Code shows `KXM brief` while it runs.

**Only in KXM projects.** The hook looks for `.kxm/` in the directory Claude Code was started in, not in its parents. Without it, the hook prints nothing and adds no context. The MCP tools and skills still load in every project.

**What it adds.** In a KXM project the hook adds, in this order:

1. `KXM project <project> · hub <on|off|unknown> at <server_url>`, from a 300 ms health probe of `server_url`.
2. Up to three active runs of this project (created, preparing, running or waiting), each with its workflow, status and current stage, marked `(assigned to you)` when the run is assigned to `agent_name`.
3. How many open peer requests are addressed to `agent_name`. It is a count only, with no request text.
4. Where to start: `kxm_context` with your role and task before planning, `kxm_workflow_get <runId>` for an assigned run, and `kxm_inbox` then `kxm_reply` for peer requests.
5. When the hub is off or unknown: that `kxm_*` tools will fail until you start it with `kxm hub start`.
6. When the KXM session token is invalid: the fix, which is `kxm session token --clear` for a token file, or unsetting or replacing `KXM_SESSION_TOKEN` in the environment Claude Code was launched from. See [Troubleshooting](#troubleshooting).
7. The project memory brief, verbatim: the active facts in `.kxm/memory/`, the same text [`kxm memory brief`](../../docs/cli-reference.md#kxm-memory-brief) prints.

Items 1 to 6 are capped at 1,500 characters. The memory brief follows them in full. If the whole context exceeds Claude Code's 10,000-character hook limit, Claude Code saves it to a file and shows a preview; the status lines come first, so they stay in the preview.

**Read-only.** The hook writes no files, mints no session token, starts no hub, runs no `git`, and needs no `kxm` on `PATH`. It reads `.kxm/project.yaml`, `.kxm/memory/`, the hub database under `.kxm/state/`, the Runtime registry and this project's run store under the user state root, and whether a KXM session token is valid.

**Scoped to this project.** Runs and request counts come only from this hub project and this project's Runtime runs, never from other projects on the machine. The hook never shows plan or journal text, message bodies, tokens, or any plugin option other than `server_url`, `agent_name` and `project`.

**Time-bounded, and it never fails a session.** Claude Code stops the hook after 5 seconds. Within that, reading the hook input waits at most 300 ms, the health probe at most 300 ms, and each SQLite read gives up on a locked database after 250 ms. The hook always exits 0. If anything goes wrong it prints nothing, and the session starts without the brief.

### Tool-failure journaling

The plugin also registers a PostToolUseFailure hook. When a tool call fails, Claude Code passes the tool name, the tool use ID and the error to the MCP server's hook-only `kxm_hook_tool_failure` tool. If this session is working on exactly one workflow run that reached it as a peer request, the server journals an `error` entry to that run with the failure class and the tool name, and tells Claude not to record it again. The error text is classified, never stored. Interrupts, failures outside a workflow run, and failures while the MCP server is not connected to the hub record nothing. The hook never returns an error and never blocks the session.

### Skills

The plugin ships the KXM Agent Skills. The `kxm` skill teaches Claude when and how to use the tools below safely and points to the rest of the suite. See [Agent Skills](../../docs/agent-skills.md) for the full list.

## MCP tools

Every tool acts as this session's agent (`agent_name`) in the hub project.

### Peers

| Tool | What it does |
|---|---|
| `kxm_list` | Lists peers in this project with their names, purposes, host labels and presence (online, stale, offline). `includeOffline` adds registered peers whose lease expired. |
| `kxm_send` | Sends one focused request to a peer and returns a message ID for `kxm_get` or `kxm_await`. Pass `workflowContext` when the reply must count as peer evidence for a workflow gate. |
| `kxm_get` | Checks a sent request's status and reply without waiting. |
| `kxm_fanout` | Asks one to three peers the same question independently, for comparison. A local timeout returns pending entries with durable message IDs to check later. |
| `kxm_await` | Waits for the reply to a sent request, for at most 60 seconds. For longer external work, use `kxm_workflow_wait`. |
| `kxm_cancel` | Cancels a queued or delivered request that this agent sent. |
| `kxm_inbox` | Lists inbound peer requests that still need a reply (pull mode). |
| `kxm_reply` | Sends the final reply to an inbound request by its message ID. |

### Workflows

These tools work on durable hub workflows, the ones started by signed webhooks or `kxm workflow start` (see [Webhook workflows](../../docs/webhook-workflows.md)). Runs created with `kxm run` are Runtime runs; inspect those with `kxm runs status` in a terminal.

| Tool | What it does |
|---|---|
| `kxm_workflow_list` | Lists durable workflows assigned to this agent. |
| `kxm_workflow_get` | Reads a run's stages and its journal. |
| `kxm_workflow_checkpoint` | Records a stage result (passed, warning or failed) with evidence keyed by the stage's required evidence. Cite peer replies through `evidenceRefs` so the hub can verify provenance and quorum. Warnings and failures need another attempt. |
| `kxm_workflow_record` | Adds a journal entry: plan, decision, contradiction, error, lesson, observation, hypothesis, experiment, state-change or skill-candidate. Lessons and skill candidates need evidence. |
| `kxm_workflow_wait` | Parks the active stage until a signed external callback (CI, review, merge, Jira) checkpoints it and resumes the coordinator. |
| `kxm_improvement_report` | Summarizes errors, contradictions, lessons and skill candidates by improvement area, with ranked cross-run signals. |

Workflow authors can require replies from a snapshotted set of eligible peers. The coordinator passes exact `workflowContext` to `kxm_send` or `kxm_fanout` and later cites the returned message IDs in `evidenceRefs`; the hub derives provenance and counts unique producers. Evidence strings, correlation IDs and idempotency keys do not satisfy a peer policy. See [Peer provenance and quorum gates](../../docs/provenance-gates.md).

### Context

| Tool | What it does |
|---|---|
| `kxm_context` | The starting point for KXM context. Builds a token-budgeted, role-aware packet of evidence, temporal state, episodes, knowledge and skills for a role and task, optionally scoped to a workflow run and stage. Superseded and rejected records are left out. |
| `kxm_recall` | Searches durable context records by query and returns bounded metadata with a relevance score, never summaries. |
| `kxm_state` | Reads the current value of one temporal state key, or its value as of an ISO-8601 timestamp. |
| `kxm_episode` | Reads episodic learning (errors, lessons, observations, experiments) from workflow journals, optionally for one run. |
| `kxm_promote` | Proposes a change to one authoritative state key, backed by evidence references. It only proposes: the hub returns a proposal ID, and an operator applies it with [`kxm context promote`](../../docs/cli-reference.md#kxm-context-promote). |

### Hook-only

| Tool | What it does |
|---|---|
| `kxm_hook_tool_failure` | Called by the plugin's PostToolUseFailure hook to journal failure metadata (see [Tool-failure journaling](#tool-failure-journaling)). Claude should not call it. |

## Pushed channel mode and pull mode

Peer requests reach Claude in one of two ways. Everything else, including `kxm_send`, `kxm_fanout`, the workflow tools and the context tools, works the same in both.

**Pull mode** is the default. Claude checks for work with `kxm_inbox`, handles one request, and answers it with `kxm_reply` and the request's message ID. Nothing arrives on its own: ask Claude to check the inbox, or to poll it with a backoff while it waits. The MCP server keeps the inbox, filling it from the hub's event stream while it is registered; in a KXM project with a project token that starts with the session.

**Pushed channel mode** uses Claude Code channels to inject each peer request into the running session as a `<channel source="kxm" message_id="...">` event, which Claude handles and answers with `kxm_reply`. During the channels research preview, start Claude Code with the community channel explicitly and review the trust prompt:

```text
claude --dangerously-load-development-channels plugin:kxm@kxm
```

If your organization has approved the plugin through `allowedChannelPlugins`, use `claude --channels plugin:kxm@kxm` instead. Organization policy can still block channels; `kxm_inbox` and `kxm_reply` keep working either way.

## Update

The root README section [Update an existing install](../../README.md#update-an-existing-install) covers the CLI and the plugin together. For the plugin alone:

- User scope: `claude plugin marketplace update kxm`, then `claude plugin update kxm@kxm`.
- Project scope: `claude plugin marketplace update kxm`, then `claude plugin update kxm@kxm --scope project`. Without `--scope project` the update fails with `Plugin "kxm" is not installed at scope user`.
- Then restart Claude Code.

**The version pin.** Claude Code installs new plugin code only when the plugin version changes. This plugin is pinned at `0.7.1` in `plugin.json` and `marketplace.json`, so `claude plugin update` prints `kxm is already at the latest version (0.7.1).` and keeps the cached copy. Existing installs therefore do not receive plugin changes, including the SessionStart hook and MCP server behaviour described on this page, until the next version bump. To refresh the cached copy now, reinstall:

```bash
claude plugin marketplace update kxm
claude plugin uninstall kxm@kxm --scope project
claude plugin install kxm@kxm --scope project \
  --config server_url=http://127.0.0.1:7331 \
  --config agent_name=<unique agent name> \
  --config agent_purpose="<what this agent does>" \
  --config project=<hub project key>
```

Drop `--scope project` for a user-scope install. Reinstalling discards the plugin options: without `--config`, Claude Code prints `5 userConfig options not yet set (3 required)`. Pass them again as above, re-enter `auth_token` at `/plugin configure kxm@kxm` if you use one, and restart Claude Code.

Once an install has the new plugin code, after a version bump or the reinstall above:

- A blank `auth_token` no longer falls back to the hub admin token. Each project needs its own project token; see [Which token to use](#which-token-to-use).
- The previous SessionStart hooks ran `kxm session brief --status` and `kxm memory brief`. They needed `kxm` on `PATH`, and the first one saved a 24-hour session token. The new hook does neither, and nothing in the plugin refreshes that token, so once it expires it blocks every `kxm_*` tool until you clear it; see [Troubleshooting](#troubleshooting).

## Troubleshooting

Tool errors and the SessionStart brief name the fix, addressed to you. Run the commands below in your own terminal rather than through Claude, and never paste tokens into Claude. [Troubleshooting](../../docs/troubleshooting.md) covers the hub and workers.

### The `kxm_*` tools do not appear

1. Check `/mcp` for the `kxm` server and its connection error.
2. Check that `node --version` in the environment Claude Code starts from is 22.19 or newer on 22.x, or 24 or newer.
3. Run `/reload-plugins`, or restart Claude Code.
4. Check that `claude plugin list` shows `kxm@kxm` with `Status: ✔ enabled`.

### `KXM hub unreachable at <url>`

No hub answers at `server_url`. Start it with `kxm hub start`, or correct `server_url` with `/plugin configure kxm@kxm` and restart Claude Code.

### `no project token for project <p>`

The MCP server found neither an `auth_token` nor a token the hub saved for `<p>`, so it did not contact the hub. Enter the project's token at `/plugin configure kxm@kxm`, or add `<p>` to the hub's `KXM_PROJECT_TOKENS`, listing every existing project too because the variable replaces the saved map, and restart the hub. If `<p>` is not the key you expected, set the `project` option.

### `KXM hub rejected the project token for project <p>`

`auth_token` is not the token the hub holds for `<p>`. Enter the right one at `/plugin configure kxm@kxm`.

### `tool_policy_denied: Session token on disk is malformed or expired`

The same fix applies to `Session token file on disk could not be read`. A KXM session token file in your KXM user configuration directory blocks every `kxm_*` tool. Run [`kxm session token --clear`](../../docs/cli-reference.md#kxm-session-token); it prints `Session token cleared from disk.` `kxm session token --status` prints `No active session token found in env or disk` for such a file even though the file still blocks the tools, so it cannot confirm this problem. Do not use `--issue`: it prints the token and only re-arms it for 24 hours. With no token file and no `KXM_SESSION_TOKEN`, the MCP server applies no session policy.

### `tool_policy_denied: KXM_SESSION_TOKEN is malformed or expired`

`KXM_SESSION_TOKEN` in the environment Claude Code was launched from is bad. Unset or replace it there, then restart Claude Code. `kxm session token --clear` does not help here; `kxm session token --status` prints `Session token in env is invalid or expired`.

### The session appears as `<name>-<pid>`

Another active session in the same project already uses `agent_name`, so this one registered with its process ID appended. This is expected.

### No KXM brief at session start

The hook runs only when the directory Claude Code was started in contains `.kxm/`. Start Claude Code from the project root, or run `kxm init` there. A SessionStart hook error that mentions `node` means `node` is not on the `PATH` Claude Code uses.

### `kxm is already at the latest version (0.7.1)` but the plugin is out of date

That is the version pin. Use the reinstall in [Update](#update).

### `kxm_await` reports `timed out waiting for <messageId>`

`kxm_await` waits at most 60 seconds. The request is still pending: check it later with `kxm_get`, or use `kxm_workflow_wait` for long external work.

### Pushed requests do not arrive

Start Claude Code with the channel flag from [Pushed channel mode and pull mode](#pushed-channel-mode-and-pull-mode) and accept the trust prompt, or use `kxm_inbox`.

## Safety and limits

- Peer messages are untrusted input; normal tool and approval controls still apply.
- Peer quorum proves durable provenance within the shared project-token boundary, not truth, model independence, non-collusion, or approval authority.
- Do not send secrets, credentials, or unnecessary private data.
- The hub persists state in SQLite by default; protect its database as sensitive data.
- Cancellation stops KXM processing but cannot roll back filesystem or external side effects.
- Use separate worktrees or a single-writer rule when peers can edit files.
- Keep the hub on localhost unless it is protected with authentication, TLS, and network controls.

## Development

Edit the TypeScript under `src/`, never the generated bundles: `src/mcp-server.ts` builds to `dist/mcp-server.js`, and `src/claude-hook.ts` builds to `dist/claude-hook.js`. From the repository root:

```bash
npm run build
npm run verify
```

The bundles include their dependencies, so marketplace installs need no post-install step. Commit the rebuilt `dist/` files with the source change; `npm run check:generated` fails when they are stale. CI validates both plugin manifests with `claude plugin validate` (`npm run validate:claude`). `test/core/claude-plugin-docs.test.ts` fails when the [MCP tools](#mcp-tools) tables and the tools `dist/mcp-server.js` publishes disagree, so add or remove a row in the same change as the tool.

## More documentation

- [KXM Handbook](../../docs/kxm-handbook.md): installation, configuration, Claude channel and pull modes, workflows, gates and recovery.
- [Getting started](../../docs/getting-started.md) and [Operations](../../docs/operations.md): task-focused guides.
- [CLI reference](../../docs/cli-reference.md): every `kxm` command, with options and output.
- [Configuration reference](../../docs/config-reference.md): every `.kxm` file, the workspace layout, and state outside the project.
