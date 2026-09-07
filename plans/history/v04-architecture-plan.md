# v0.4.0 architecture and rollout plan

Run: `run_04c0552a1b9e450fa874eed50049e34f`  
Selected after independent plans `msg_bc5538262f9d463fb8723d9a2966badf` (Grok) and `msg_922ef8fc87e14dfca224777b38c56ae9` (Gemini).  
Grok’s plan is the implementation source. Gemini’s SIGINT-cancel and mock-CI reminders are kept.

Increment: **0.3.1 → 0.4.0**. No SQLite schema bump. One PR closes issues 5, 6, 10, 11, 12, 13.

## Architecture

Hub stays the durable source of truth. Nothing in the hub polls GitHub.

```text
pi-mesh CLI
  diagnostics.ts     classify 401/403/tool failures
  redact.ts          secret/allowlist stripping
  github-watch.ts    poll required checks → existing signal POST
  retrospective.ts   run+journal → atomic MD/JSON
  worker.mjs         drain / continue-fallback / envelope file
  hub/extension/MCP  extra error fields + classified auto-journal
```

## Command contracts

Additive bin `pi-mesh`. Keep `kxm-hub` and `kxm-worker`.

Global: `--json`, `--dry-run`, `--workspace <dir>`.

| Command | Exit |
|---|---|
| `init` `validate` `status` `hub` `worker` `stop` | 0 ok, 1 fail, 2 usage |
| `workflow list\|get` | 3 = 403/404 |
| `workflow start` | live start rejected (exit 2); `--dry-run` prints HMAC plan |
| `signal` | wraps existing signed POST |
| `github watch` | 0 posted, 1 adapter error, 2 usage, **4 timeout without POST** |
| `retrospective export` | atomic MD+JSON |
| `smoke --real-pi` | 0 pass or skip, 1 fail |

`--json` is allowlisted. Secrets are never printed.

## Security boundaries

Never print or persist: tokens, HMAC secrets, prompts, peer bodies, argv, stdout/stderr, `pi-agent-*.log`, raw CI logs, webhook payloads.

May persist: ids, tool names, allowlisted class/operation/nextAction, coordinator name, check URLs, conclusions, timestamps.

CLI does not push, merge, comment, or mutate Jira. GitHub watch is checks-read plus signed mesh signal only.

## File ownership

Coordinator writes the paths listed in the research synthesis plus this plan. Tests cover diagnostics, CLI, GitHub watch, retrospective, extension journal classification, hub extras, worker drain/fallback, and skip-by-default smoke.

## Rollout

1. `redact` + `diagnostics` + hub extras + classified auto-journal (#5)
2. Worker drain + envelope + session_start consume (#10)
3. CLI skeleton (#11)
4. GitHub watch (#6)
5. Retrospective export (#12)
6. Opt-in smoke (#13)
7. Docs, versions 0.4.0, local gates

## Out of scope

New protocol codes, locking journals after terminal, watcher-synthesized hub signals, rewriting Pi session files, hub GitHub polling, auto policy edits, schema 3, ordinary CI model downloads.

## Rollback

0.3.1 clients ignore extra JSON fields. 0.4 CLI tolerates missing `nextAction`. Restore the package; no database downgrade.
