# Headless harness CLIs

Role routing comes from [`AGENTS.md`](../AGENTS.md). This file is the
**mechanics**: what each CLI actually supports headlessly, and the defaults we
use. If the routing table and this file disagree, `AGENTS.md` wins.

Snapshot date: **2026-09-05**. Re-probe after any CLI update; these surfaces
change without notice. Installed ≠ auth-verified ≠ helper-eligible.

## Installed vs auth-verified

| CLI | Installed (this host) | Auth-verified | Helper-eligible |
|---|---|---|---|
| `pi` | 0.85.0 | `pi auth check --provider <p>`; OpenRouter may be `ready`; native-lab prefixes are braked | OpenRouter only, after JSONL usage parse |
| `claude` | 2.1.260 | `claude auth status` → `claude.ai` | read-only plan/review (`fable`) |
| `codex` | 0.153.2 | `codex login status` → ChatGPT | read-only CLI/docs review (`gpt-5.6-sol`) |
| `grok` | 1.0.13 | `grok models` → logged in with grok.com | writer only (`grok-4.6`) |
| `kimi` | 0.40.1 | oauth via `kimi provider list` | **no** — unverified helper dispatch |
| `gemini` | 0.56.0 | **unknown** (installed only) | **no** |
| `agy` | 1.1.22 | `agy models` (gateway) | **no** |

**Not installed: `hermes`, `dsh`.** Windows helper dispatch is **unsupported**
in `scripts/harness-run.mjs` (shell:false, absolute `.exe` only; `.cmd`/`.bat`/
`.ps1` refused). That is not a claim that any harness works on Windows.

Product catalog still has no `grok` row and Codex has no `authArgs`. Do not
invent them here.

## Flag matrix (verified helper routes)

| | headless | prompt input | model | thinking / effort | auto-approve | output format |
|---|---|---|---|---|---|---|
| **pi** | `-p` | `@file` | `--model openrouter/<id>` | `--thinking` ladder | `-a` (experiment edit only) or `--tools read,grep,find,ls --no-extensions --no-skills --no-prompt-templates` | `--mode json` |
| **claude** | `-p` | **stdin** | `--model` | `--effort` (verified) | read-only: `--tools Read,Glob,Grep --safe-mode --strict-mcp-config --disable-slash-commands` | `--output-format json` |
| **codex** | `exec` | stdin `-` | `-m` | `-c model_reasoning_effort=...` (verified) | `--sandbox read-only` | `--json` (JSONL) |
| **grok** | `--prompt-file` | file | `-m` | `--reasoning-effort` | `--always-approve` | `--output-format json` |

Kimi, Gemini, and Agy stay fail-closed in the helper. Grok read-only is
unsupported pending a permission-mode probe. Never `--bare`. Never Bash on
read-only Claude. Never read `~/.grok/auth.json`.

## Defaults

| Role | Command |
|---|---|
| Implement / write | `grok --prompt-file <brief> -m grok-4.6 --reasoning-effort high --always-approve --output-format json` |
| Plan | `cat <brief> \| claude -p --model fable --tools Read,Glob,Grep --safe-mode --strict-mcp-config --mcp-config <empty.json> --disable-slash-commands --output-format json` |
| Review: architecture, permissions | same as Plan |
| Review: CLI, docs | `codex exec -m gpt-5.6-sol -C <dir> --sandbox read-only --json - < <brief>` |

Prefer `just impl|plan|review-arch|review-cli`. There is **no** `impl-pi`
writer fallback. If `grok` is logged out, stop.

**Provider-native rule.** Anthropic → Claude CLI; OpenAI → Codex; xAI → Grok
CLI; Moonshot → Kimi CLI when that helper is verified (not today); Google →
Gemini CLI when auth is verified (not today). Pi may run **OpenRouter** after
`pi auth check --provider openrouter`. Native-lab prefixes (`anthropic`,
`openai`, `xai`, `moonshot`, `google`, `deepseek`) fail closed on Pi. If the
native harness is missing or logged out, fail closed — never silently bill a
different provider's key.

Moving the writer to `grok` does not make it a long-lived worker: `kxm agent
worker` / `pi --mode rpc` is still Pi-only.

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
  --no-skills --no-prompt-templates`. `hooks:true` is refused.
- **requests**: `harness`, `role`, `model`, `permission`, and `prompt_file`
  are required nonempty strings. Missing model or permission does not
  default to the CLI. Grok and Codex reject `hooks`/`skills` even when
  `false` (no verified disable flag). Grok `--json-schema` stays supported.
- **grok**: `--prompt-file` is the headless prompt surface. Auth via
  `grok models`, not an auth.json scrape.
- **codex**: pass the prompt as `-` on stdin. `turn.failed` is `ok:false`
  even on exit 0. ChatGPT login is `unmetered`.
- **kimi / gemini / agy**: unverified in this helper; long inline prompts
  also hit the Windows command-line limit.

## Rules for every headless run

1. **Isolate.** One git worktree per concurrent lane.
2. **Background it.** Never block the interactive session on a long run.
3. **Log it.** The helper writes answer and stderr sidecars (mode 0600) and
   returns paths, not raw payloads. Headless plan/review callers read
   `answerPath`.
4. **Verify independently.** Re-check the tree and gates yourself.
5. **Artifacts, not evidence.** Claude/Codex critiques are artifacts plus
   human signoff, never hub `peer-reply` evidence.
