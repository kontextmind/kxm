# Headless harness CLIs

Role routing comes from [`AGENTS.md`](../AGENTS.md). This file is the
**mechanics**: what each CLI actually supports headlessly, and the defaults we
use. If the routing table and this file disagree, `AGENTS.md` wins. Agents are
a rotation; Grok is the currently admitted native writer, not a fixed sole
writer.

Snapshot date: **2026-09-08** (agy helper admission). **Admission authority (2026-09-20):**
this file documents what each CLI *can* do; it does not decide what is *admitted*. Google's
admitted route is the `antigravity` Pi provider (Tracking → Decided, 2026-09-15); the `agy`
rows below are catalog/helper capability, not a writer admission. Catalog/auth rows below
are corrected from `plugins/kxm/src/vnext-harness.ts` and helper argv (M5
docs). Codex flags were re-audited against official online docs and installed
CLI **0.153.4 on 2026-09-10**; that does not refresh the other rows. Re-probe
after any CLI update; these surfaces change without notice.
Installed ≠ auth-verified ≠ helper-eligible.

## Installed vs auth-verified

| CLI | Installed (this host) | Auth-verified | Helper-eligible |
|---|---|---|---|
| `pi` | 0.85.0 | `pi auth check --provider <p>`; OpenRouter or Nous Portal may be `ready`; native-lab prefixes are braked | OpenRouter or Nous Portal, after JSONL usage parse |
| `claude` | 2.1.261 | `claude auth status` → `claude.ai` | read-only plan/review (`fable`) |
| `codex` | 0.153.4 | `codex login status` → ChatGPT | read-only CLI/docs review (`gpt-5.6-sol`) |
| `grok` | 1.0.5 | `grok models` → logged in with grok.com | writer only (`grok-4.6`) |
| `kimi` | 0.40.1 | oauth via `kimi provider list` | **no** — unverified helper dispatch |
| `gemini` | 0.56.0 | **unknown** (installed only) | **no** — deprecated individual-tier CLI; catalog stays |
| `agy` | 1.1.27 | `agy models` → non-empty models list (Antigravity OAuth) | writer/experiment **edit**, Gemini kebab ids only |

**Not installed: `hermes`, `dsh`.** Windows helper dispatch is **unsupported**
in `scripts/harness-run.mjs` (shell:false, absolute `.exe` only; `.cmd`/`.bat`/
`.ps1` refused). That is not a claim that any harness works on Windows.

Product catalog (`BUILTIN_HARNESSES`): `grok` and `agy` are present
(`mode: either`, `authArgs: ["models"]`). Codex `authArgs` are
`["login", "status"]`. Helper auth is observational inventory, not a
Phase 11 adapter.

## Flag matrix (verified helper routes)

| | headless | prompt input | model | thinking / effort | auto-approve | output format |
|---|---|---|---|---|---|---|
| **pi** | `-p` | `@file` | `--model openrouter/<id>` or `--model nous-portal/<id>` | `--thinking` ladder | `-a` (experiment edit only) or `--tools read,grep,find,ls --no-extensions --no-skills --no-prompt-templates` | `--mode json` |
| **claude** | `-p` | **stdin** | `--model` | `--effort` (verified) | read-only: `--tools Read,Glob,Grep --safe-mode --strict-mcp-config --disable-slash-commands` | `--output-format json` |
| **codex** | `exec` | stdin `-` | `-m` | `-c model_reasoning_effort=...` (verified) | `--sandbox read-only --ignore-user-config -c 'approval_policy="never"'` | `--json` (JSONL) |
| **grok** | `--prompt-file` | file | `-m` | `--reasoning-effort` | `--always-approve --no-subagents --disable-web-search` | `--output-format json` |
| **agy** | `-p <text>` | argv (no `--prompt-file`, stdin is extra only) | `--model` (Gemini kebab ids; model id already embeds a tier) | `--effort` (also pass; do not dedupe with the id) | `--dangerously-skip-permissions` | `--output-format json` |

Kimi and Gemini stay fail-closed in the helper. Grok read-only is
unsupported pending a permission-mode probe. Agy read-only roles are
deferred until a granular read-permission route exists. Never `--bare`.
Never Bash on read-only Claude. Never read `~/.grok/auth.json`.

## Defaults

Evidence-informed recipe defaults (not a ranking): **medium** for
implementation, planning, and architecture review; **low** for CLI review.

| Role | Command |
|---|---|
| Implement / write | `grok --prompt-file <brief> -m grok-4.6 --reasoning-effort medium --always-approve --no-subagents --disable-web-search --output-format json` |
| Plan | `cat <brief> \| claude -p --model fable --effort medium --tools Read,Glob,Grep --safe-mode --strict-mcp-config --mcp-config <empty.json> --disable-slash-commands --output-format json` |
| Review: architecture, permissions | same as Plan |
| Review: CLI, docs | `codex exec -m gpt-5.6-sol -c 'model_reasoning_effort="low"' -C <dir> --sandbox read-only --ignore-user-config -c 'approval_policy="never"' --json - < <brief>` |

`just impl|plan|review-arch|review-cli` are **low-level harness transport**.
They do not mint assignment, witness, or acceptance proof. Normal entry is
`just assign` with a closed manifest; then `just witness`, `just attribute`,
`just observe-cost`, `just accept`, `just plan-current`, and
`just change-report` (positional quoted arguments). There is **no** `impl-pi`
writer fallback. If `grok` is logged out, do not bill Grok through another harness: take an **admitted** relief route from Tracking, or stop and name the limits hit. Two attempts by default; a
third only with new evidence or a changed approach, then relief.

**Provider-native rule.** Anthropic → Claude CLI; OpenAI → Codex; xAI → Grok
CLI; Moonshot → Kimi CLI when that helper is verified (not today); **Google → the
`antigravity` Pi provider, not a shell-out to the `agy` CLI** (Tracking → Decided,
2026-09-15; `agy` and the deprecated Gemini CLI remain catalog/helper entries, and the
`agy` rows in this file state capability, never admission). Starting rotation
unchanged. Pi may run **OpenRouter** after
`pi auth check --provider openrouter`, or **Nous Research Portal** after
`pi install npm:@jayteelabs/pi-nous-portal-provider` and
`pi auth check --provider nous-portal`. Login: `/login openrouter`, or
`/login` → subscription or API key → Nous Research Portal (`NOUS_API_KEY`;
optional `NOUS_PORTAL_BASE_URL` / `NOUS_INFERENCE_BASE_URL`). Example:
`pi -p --model nous-portal/tencent/hy4-preview` (same as
`pi -p nous-portal -m tencent/hy4-preview`). Verify Hy4 availability and
list prices on Portal `/models` (publicly cited Portal ~$0.67/$2.00, 20%
off OpenRouter list ~$0.83/$2.50). Hy4 is experiment-only in this helper;
the only admitted Pi writer is `openrouter/qwen/qwen3-coder-plus`.
Native-lab prefixes (`anthropic`, `openai`, `xai`, `moonshot`, `google`,
`deepseek`) fail closed on Pi. If the native harness is missing or logged
out, fail closed — never silently bill a different provider's key. There
is no Nous CLI harness.

Moving the writer to `grok` does not make it a long-lived worker: `kxm agent
worker` / `pi --mode rpc` is still Pi-only. `agy` is one-shot headless, not
an RPC worker.

## Per-CLI gotchas, all hit in practice

- **claude**: `--allowedTools` is variadic and will swallow a positional
  prompt. The helper uses `--tools Read,Glob,Grep` as one argument and stdin
  for the brief. `--bare` is replaced by `--safe-mode` plus empty MCP config.
  Hooks or skills on a read-only request are rejected, not ignored.
  `--max-budget-usd` is passed only for a positive finite `max_cost_usd`
  (zero is not a verified Claude budget).
- **pi**: prefer `@<file>`. JSONL `message_end` usage is **per call**; sum
  every assistant usage-bearing event for assignment totals. `stopReason`
  `error`/`aborted` fails even on exit 0. Planner/reviewer cannot `edit`;
  only an explicit `experiment` role may. Read-only adds `--no-extensions
  --no-skills --no-prompt-templates`. `hooks:true` is refused. Helper
  prefixes are `openrouter/*` and `nous-portal/*` (not
  `nous-portal-api-key`, which is the package's login-picker alias). Auth
  is `pi auth check --provider <prefix>`; writer still requires exact
  OpenRouter Qwen JSON readiness.
- **requests**: `harness`, `role`, `model`, `permission`, and `prompt_file`
  are required nonempty strings. Missing model or permission does not
  default to the CLI. Grok and Codex reject `hooks`/`skills` even when
  `false` (no verified disable flag). Grok `--json-schema` stays supported.
- **grok**: `--prompt-file` is the headless prompt surface. Auth via
  `grok models`, not an auth.json scrape. Helper also passes
  `--no-subagents --disable-web-search` and optional `--max-turns` from a
  positive integer `max_turns` (other harnesses refuse that field). Combining
  `--max-turns` with `--json-schema` is unproven here; later native smoke
  must show it.
- **codex**: pass the prompt as `-` on stdin. `turn.failed` is `ok:false`
  in the native helper even on exit 0. ChatGPT login is `unmetered`. The
  helper and product launch explicitly set read-only sandboxing and
  `approval_policy="never"` (no interactive approval or sandbox escalation).
  `--ignore-user-config` skips `$CODEX_HOME/config.toml`, **not auth**, project
  configuration, all plugins, or all MCP connections. Shell sandboxing is not
  complete customization/network isolation. Exec-policy rules remain enabled.
  Do not use `--ignore-rules`, deprecated `--full-auto`, `--approve-for-me`, or
  sandbox-bypass flags for a critic. `--ephemeral` is optional rollout retention,
  not a timeout fix; KXM retains its own private transport artifacts either way.
  Top-level help omits `--ignore-user-config`; use `codex exec --help`.
  A parser probe is not live combination or model-identity proof.
  Official references (read 2026-09-10): [CLI commands and flags](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-exec),
  [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
  [approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security),
  [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
  The old `/codex/security` URL now describes the separate Codex Security product.
- **results**: helper stdout is `kxm.harness-result.v2` only. `just runs`
  diagnoses obsolete `kxm.harness-result.v1` files (path, observed known
  schema or `unrecognized`, obsolete id) and does not parse or upgrade
  them. Transport `completed|failed|interrupted` is not a model claim and
  not product `finalOutcome`. Timeout is interrupted with `timedOut` true;
  SIGTERM then SIGKILL after a bounded grace; missing `close` is not
  descendant death. Direct-child signal termination keeps `exitCode` null
  and the exact `signal` and is `interrupted` even without a helper
  timeout. Public metadata is a closed allowlist (bounded `errorCode` /
  `stopReason`); raw model/stdio text stays in private sidecars
  (`answer.txt`, `stderr.log`, `error.txt`, `model-claim.json`). Review
  top-level `PASS`/`BLOCK` is a model claim, never verify/acceptance.
  Private `dispatch.json` is written before billed spawn.
- **agy**: prompt is argv `-p <text>` (no `--prompt-file`; stdin is only
  extra input). Trust JSON `status`, never the exit code (`SUCCESS` /
  `ERROR` / timeout all exit 0). Timeout string is
  `timeout waiting for response`. Non-empty `denied_actions` is
  `turn_failed` (list in the private error sidecar). Cost basis
  `unmetered`; never `$0`. `effectiveModel` only if agy reports a `model`
  field. `--json-schema` takes a path; `--print-timeout` is Go duration
  (`<timeout_ms>ms`). Model id and `--effort` are both passed. Auth is
  `agy models` → models list, method `antigravity-oauth`. Gemini kebab ids
  only in this helper; hosted Claude/GPT ids need separate admission.
- **kimi / gemini**: unverified in this helper; long inline prompts
  also hit the Windows command-line limit.

## Rules for every headless run

1. **Isolate.** One git worktree per concurrent lane.
2. **Background it.** Never block the interactive session on a long run.
3. **Log it.** The helper writes answer, stderr, dispatch, and model-claim
   sidecars (mode 0600) and returns paths, not raw payloads. Headless
   plan/review callers read `answerPath`. Do not treat transport `ok` or a
   model `status` as verify/accept.
4. **Verify independently.** Re-check the tree and gates yourself.
5. **Artifacts, not evidence.** Claude/Codex critiques are artifacts plus
   human signoff, never hub `peer-reply` evidence.
