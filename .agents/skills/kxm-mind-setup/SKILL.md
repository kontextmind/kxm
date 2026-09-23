---
name: kxm-mind-setup
description: KontextMind knowledge plane only, the separate kontext CLI and km_ tools, not KXM or this plugin's kxm_* tools. Connects a machine to a KontextMind server with the kontext CLI. Use only when the user names KontextMind, the kontext CLI, or a km_ tool.
license: Apache-2.0
compatibility: Any agent that can run a shell or MCP client. No vendor-only tools.
metadata:
  workflow: setup
  version: "0.1.1"
  argument-hint: "[serve|login|init|doctor]"
  complete: "npx kontextmind serve, kontext login, kontext init, kontext doctor"
  suite: kxm
---

# kxm-mind-setup

Beacon after the server is up — `km_status` with `skill: "kxm-mind-setup"`.

## Zero-install server

Needs the Node.js version the KontextMind server requires (a separate product
from KXM). One data dir (`~/.kontextmind`).

```bash
npx kontextmind serve
# MCP  http://127.0.0.1:13013/mcp
# native POST /v1/call on the same host
```

DB resolution — `DATABASE_URL` → docker Postgres → local Postgres → embedded. Do not invent another store.

From source (this monorepo) — `bun install --no-save`, `bun run seed`, `docker compose -f deploy/docker-compose.yml up`. Demo bearer `km-demo-local`.

## Connect a project

```bash
npm install -g @kontextmind/cli
kontext login    # hosted — device-code OAuth in the browser
kontext init     # MCP config + commit-msg trailer hook + AGENTS.md contract
kontext doctor   # install + release check
```

`init` is idempotent and is the upgrade path. The commit-msg hook attaches `KM-Session` when a session file exists. Agents may omit trailers; they must not fake them.

Token order — `KM_TOKEN` → stored OAuth (auto-refresh) → demo default. Override base with `--url` or `KM_URL`.

## Doctor failures

Report the exact check that failed (server unreachable, auth 401, hook missing, version lag). Do not edit hook scripts into forging trailers. Do not weaken secret gates to "make it work".

## Autocomplete

Slash hint — `[serve|login|init|doctor]`

Complete — `npx kontextmind serve, kontext login, kontext init, kontext doctor`

Works on any harness. Catalog — `plugins/kxm/skills/hints.json`.
