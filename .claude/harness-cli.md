# Headless harness CLIs

Role routing comes from [`AGENTS.md`](../AGENTS.md). This file is the
**mechanics**: what each CLI actually supports headlessly, and the defaults we
use. If the routing table and this file disagree, `AGENTS.md` wins.

Everything below was probed on this machine on 2026-09-04. Re-probe after any
CLI update; these surfaces change without notice.

## Installed and authenticated

| CLI | Version | Provider / auth | Verified |
|---|---|---|---|
| `pi` | 0.85.0 | multi-provider; `xai`, `anthropic`, `google`, `openrouter` = `ready`; `openai`, `moonshot`, `deepseek` = `not_ready` | `pi auth check --provider <p>` |
| `claude` | 2.1.260 | Anthropic subscription | running now |
| `codex` | 0.153.2 | `Logged in using ChatGPT` | `codex login status` |
| `grok` | 1.0.13 | OAuth to `auth.x.ai` | `~/.grok/auth.json` |
| `kimi` | 0.40.1 | `managed:kimi-code`, oauth, 4 models; default `kimi-code/kimi-for-coding` | `kimi provider list` |
| `gemini` | 0.56.0 | Google | installed |
| `agy` | 1.1.22 | gateway over Gemini / Claude / GPT-OSS models | `agy models` |

**Not installed: `hermes`, `dsh`.** Neither is on `PATH` and neither has a
home directory under `~`. If they exist under other binary names, say which and
I will probe them.

## Flag matrix

| | headless | prompt input | model | thinking / effort | auto-approve | output format |
|---|---|---|---|---|---|---|
| **pi** | `-p` | positional, or `@file` | `--model <provider/id>`; `:level` shorthand (`sonnet:high`) | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` | `-a` trusts project files; `--tools` / `--exclude-tools` | `--mode text\|json\|rpc` |
| **claude** | `-p` | **stdin** (preferred) or positional | `--model` | model-encoded, no flag | `--dangerously-skip-permissions`; `--allowedTools` | `--output-format text\|json\|stream-json` |
| **codex** | `exec` | positional | `-m` | no flag; via `-c model_reasoning_effort=...` (unverified) | `--sandbox <profile>`; `--dangerously-bypass-approvals-and-sandbox` | `--json` (JSONL), `--output-schema`, `-o <file>` |
| **grok** | `-p/--single` | `-p`, **`--prompt-file`**, `--prompt-json` | `-m` | `--reasoning-effort` (alias `--effort`) | `--always-approve`; `--permission-mode`; `--sandbox` | `--output-format plain\|json\|streaming-json\|streaming-messages-json` |
| **kimi** | `-p/--prompt` | `-p` | `-m` | none | `-y/--yolo`; `--auto` | `--output-format text\|stream-json` |
| **gemini** | `-p/--prompt` | `-p`, appended to stdin | `-m` | none | `-y`; `--approval-mode default\|auto_edit\|yolo\|plan` | `-o text\|json\|stream-json` |
| **agy** | `-p/--print` | `-p` / `--prompt` | `--model` | `--effort low\|medium\|high` | `--dangerously-skip-permissions`; `--sandbox` | `--output-format text\|json\|stream-json` |

There is no `--fast` flag on any of them. Claude Code's fast mode is the
interactive `/fast` toggle, not a CLI flag. `agy` encodes effort in the model id
instead (`gemini-3.8-flash-high`, `-medium`, `-low`).

Read-only modes worth knowing: `gemini --approval-mode plan`, `grok --sandbox` /
`--permission-mode plan`, `codex exec --sandbox read-only`, `pi --tools
read,grep,find,ls`, `claude --allowedTools Read Grep Glob Bash`.

## Defaults

| Role | Command |
|---|---|
| Implement / write | `grok --prompt-file <brief> -m grok-4.6 --reasoning-effort high --always-approve --output-format json` |
| Implement / write (fallback, only if `grok` is logged out) | `pi -p --model xai/grok-4.6 --thinking medium -a "@<brief>"` |
| Plan | `cat <brief> \| claude -p --model fable --allowedTools Read Grep Glob Bash` |
| Review: architecture, permissions | `cat <brief> \| claude -p --model fable --allowedTools Read Grep Glob Bash` |
| Review: CLI, docs | `codex exec -m gpt-5.6-sol -C <dir> --sandbox read-only --json - < <brief>` |

**Provider-native rule.** Anthropic models go through the Claude CLI
subscription, never Pi's Anthropic API key — even though `pi auth check
--provider anthropic` says `ready`. OpenAI goes through Codex. Moonshot goes
through `kimi` (Pi's `moonshot` is `not_ready` anyway). **xAI goes through the
Grok CLI**, which is OAuth'd to `auth.x.ai`; Pi's `xai` provider is the fallback
only when `grok` is logged out. If the native harness is missing or logged out,
**fail closed and say so** rather than silently billing a different provider's key.

Moving the writer to `grok` does not make it a long-lived worker: `kxm agent
worker` / `pi --mode rpc` is still Pi-only. `grok` is a one-shot headless writer.

## Per-CLI gotchas, all hit in practice

- **claude**: `--allowedTools` is variadic. A prompt passed positionally after it
  is swallowed as tool rules and split on commas; the run then dies with "Input
  must be provided either through stdin or as a prompt argument". Pass the
  prompt on **stdin**, and space-separate the tool values.
- **pi**: prefer `@<file>` over shell-quoting a long brief. A fresh worktree has
  no `node_modules`, so any lane that runs gates needs `npm ci` first.
- **grok**: `--prompt-file` takes the brief from a file, which sidesteps quoting
  entirely — the best headless prompt surface of the seven. Note `-w/--worktree`
  does **not** create a worktree in headless `-p` mode.
- **agy**: `--print-timeout` defaults to 5m. Raise it for long units or the run
  is truncated.
- **codex**: `exec` is the non-interactive subcommand; `-C` sets the directory.
  Pass the prompt as `-` on **stdin**. Positionally it dies as `spawn
  ENAMETOOLONG` once a brief passes the ~32k Windows command-line limit.
- **kimi / gemini / agy**: no prompt-file and no stdin prompt, so they cannot
  take a long brief at all on Windows. `harness-run.mjs` refuses these above 30k
  bytes with an explanation rather than a bare errno.

## Rules for every headless run

1. **Isolate.** One git worktree per concurrent lane. Two writers in one tree
   clobber each other.
2. **Background it.** Never block the interactive session on a long run.
3. **Log it.** Redirect stdout and stderr to a scratchpad file and read that.
4. **Verify independently.** Re-check the tree, the gates, and the PR yourself.
   The agent's summary is a claim, not evidence.
5. **Artifacts, not evidence.** Claude/Codex/Kimi critiques are artifacts plus
   human signoff. They are never hub `peer-reply` evidence, and a fallback model
   is not a second critic.
