# Harness first-run research, retrieved 2026-09-27

Evidence for [`plan-kxm-harness-first-run.md`](../plan-kxm-harness-first-run.md).
This file records what was fetched on 2026-09-27. It does not re-extract the
omp 18.3.1 settings table. That table stays in
[`omp-config-settings-18.3.1.md`](omp-config-settings-18.3.1.md).

KXM facts in the plan were read from this checkout at `7a956e0` (`@kontextmind/kxm`
0.7.1). Package versions below are registry or release-page values, not versions
installed on a developer machine.

## How to read a row

| Mark | Meaning |
|---|---|
| verified | The cited page or command was fetched on 2026-09-27 and the sentence follows that page |
| prior | Already recorded in this repo's omp research from installed 18.3.1 source on 2026-09-25, and not re-read from 18.3.5 source |
| unverified | A search snippet, a third-party writeup, or a GitHub blob whose commit was not checked against the release tag |

## Version pins

| Tool | Pin | Retrieved | Mark |
|---|---|---|---|
| oh-my-pi | GitHub release **v18.3.5**, published 2026-09-27T13:35:03Z. npm `@oh-my-pi/pi-coding-agent` version `18.3.5`, packument `modified` 2026-09-27T13:42:26.853Z | `npm view @oh-my-pi/pi-coding-agent version` and the GitHub latest-release page | verified |
| Pi coding agent | GitHub `earendil-works/pi` release **v0.87.1**, published 2026-09-22T19:43:43Z. npm `@earendil-works/pi-coding-agent` version `0.87.1`. `@mariozechner/pi-coding-agent` is the deprecated name; the current home is `earendil-works/pi` | GitHub latest-release page and `npm view @earendil-works/pi-coding-agent version` | verified |
| DeepSeek Harness | npm `@deepseek-ai/dsh` **0.1.7-rc.2** (`npm view` latest). Official README names the repo `deepseek-ai/deepseek-harness` and the command `npx @deepseek-ai/dsh web`. The README states developer preview and compatibility-breaking changes. No release tag was opened for this note | npm view and the raw master README | verified for the npm latest version and the README text. The git SHA of master was not recorded |

v18.3.5 changelog items that touch first-run, and nothing else from that
changelog is used here:

- `@oh-my-pi/pi-tui` added an "OpenAI API" choice on the setup wizard web-search
  step. The existing ChatGPT-OAuth choice is labeled "OpenAI Codex"
  ([v18.3.5 notes](https://github.com/can1357/oh-my-pi/releases/tag/v18.3.5)).
- Prompt-cache warming and OpenAI Responses web search landed in the same
  release. They are not first-run behavior.

## omp (can1357/oh-my-pi)

Config layering, `modelRoles`, `retry.fallbackChains`, and
`retry.usageAwareFallback` are already written up for 18.3.1. This note only
adds first-run, auth, and the workflow keywords.

### First run and the setup wizard

| Fact | Source | Mark |
|---|---|---|
| `omp setup` with no component forces the setup wizard through `runRootCommand(..., { forceSetupWizard: true })`. It refuses when stdin or stdout is not a TTY, and prints `omp setup requires an interactive TTY.` | [`packages/coding-agent/src/commands/setup.ts`](https://github.com/can1357/oh-my-pi/blob/d94bdfa1/packages/coding-agent/src/commands/setup.ts) | unverified against the v18.3.5 tag. The blob id is the one search returned |
| The v18.3.5 notes name a setup-wizard web-search step, so a wizard exists in that release | [v18.3.5](https://github.com/can1357/oh-my-pi/releases/tag/v18.3.5) | verified |
| In-session `/setup` and `/providers` open provider setup. `/setup theme` is rejected with `Usage: /setup [providers]` | [`builtin-registry.ts`](https://github.com/can1357/oh-my-pi/blob/c0d0ad76/packages/coding-agent/src/slash-commands/builtin-registry.ts) and its test | unverified against the v18.3.5 tag |
| A maintainer comment describes wizard order `providers → glyph → theme`, with `SignInTab` and `WebSearchTab` on the providers scene, and `markSetupWizardComplete` bumping `setupVersion` | [issue 1921](https://github.com/can1357/oh-my-pi/issues/1921) | unverified. It is a comment, not a release note |
| `setupVersion` is a numeric settings key. A worked global config in this repo shows `setupVersion: 2` | [`omp-config-settings-18.3.1.md`](omp-config-settings-18.3.1.md), [`research-omp-config-examples.md`](../research-omp-config-examples.md) | prior |

What KXM should copy: a TTY-only wizard, a non-TTY refusal with a stable
sentence, a version integer so a later release can reopen only the new scene,
and a slash command that re-enters provider setup without replaying theme.

### Auth

Fetched from [docs/providers.md](https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md)
and [docs/settings.md](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)
on main, 2026-09-27. Those pages are not pinned to the v18.3.5 commit, so
wording may be newer than the release. Mark: verified as main-branch docs on
that date, not as a tag diff.

Resolution order on the providers page (highest first):

1. Runtime override, including CLI `--api-key`. Never persisted.
2. `models.yml` `apiKey` on a custom provider. This beats stored OAuth so a
   gateway key is not replaced by an upstream OAuth token.
3. Stored OAuth, refreshed, with accounts rotated. Anthropic organizations and
   ChatGPT workspaces count as separate accounts.
4. API key saved by `/login`.
5. Provider environment variable, including `.env`.
6. Other stored API key.
7. `models.yml` fallback resolver.

The same page's older mirror listed stored API key ahead of stored OAuth. The
main-branch page fetched here puts stored OAuth ahead of the login-sourced API
key. Treat the main-branch order as the one to design against, and re-read the
tag before implementation.

Other auth facts from those pages:

- Credentials live in `~/.omp/agent/agent.db`. `PI_CODING_AGENT_DIR` moves that
  directory. Broker mode uses the broker snapshot instead.
- `/login` and `/login <provider>` start OAuth or key entry. `/logout` removes
  stored credentials. A missing credential tells the user to `/login` or set
  the provider env var.
- Logins are provider-scoped.
- Global settings: `~/.omp/agent/config.yml` (existing `config.yaml` is updated
  in place). Project settings: `<repo>/.omp/config.yml`. The project layer is
  for allowing or hiding providers. The settings page says to keep secrets out
  of committed project config.
- `auth.broker.url` and `auth.broker.token` exist, overridden by
  `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN`. Broker details:
  [auth-broker-gateway.md](https://github.com/can1357/oh-my-pi/blob/main/docs/auth-broker-gateway.md).

`modelRoles`, `retry.fallbackChains`, and `retry.usageAwareFallback` (default
false; coding-plan quota, then the chain; ordinary API keys excluded) stay as
written in the 18.3.1 research. Mark: prior. v18.3.5 does not mention them.

### `workflowz` and `orchestrate`

Unchanged from
[`research-omp-config-schema.md`](../research-omp-config-schema.md) section 9
and
[`research-omp-config-examples.md`](../research-omp-config-examples.md)
section 1. Mark: prior, not re-read from 18.3.5.

Short form: there is no workflow file. `workflowz` appends a hidden notice and
the model builds a DAG inside the `eval` kernel (`workpool`, `agent`,
`completion`, `judge`, `judge_batch`, `wait`), bounded by `task.maxConcurrency`
and an optional `+Nk` or `+Nk!` budget. `orchestrate` is a prompt contract for
the top-level model to decompose, dispatch, and verify. Neither produces a
reviewable artifact.

## Pi (earendil-works/pi, v0.87.1)

| Fact | Source | Mark |
|---|---|---|
| Interactive auth is `/login` and `/login [provider]`. OAuth or an API key is saved in `auth.json`. Headless OAuth pastes the redirect URL or code back into Pi. `/logout` removes the stored credential and does not unset env vars or revoke the provider token | [pi.dev providers](https://pi.dev/docs/latest/providers), retrieved 2026-09-27 | verified as latest docs. The page does not name v0.87.1 |
| Env vars are the CI path. The table includes `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY` | same page | verified |
| A provider `key` in `auth.json` may be `!` plus a command. Pi runs it on first use, caches stdout for the process, and leaves the key unresolved on empty output, timeout, or nonzero exit. The documented example is `security find-generic-password` | same page | verified |
| `auth.json` must stay private and uncommitted | same page | verified |
| v0.87.1 defaults new xAI sessions to Grok 4.7 and adds Claude Opus 5.5, GPT-6 Sol, and GPT-6 Luna on the providers that release names | [v0.87.1](https://github.com/earendil-works/pi/releases/tag/v0.87.1) | verified |
| Package install line on the coding-agent tree is `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` | [packages/coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) | verified as main on 2026-09-27, which is ahead of the 2026-09-22 tag |
| Config dir override `PI_CODING_AGENT_DIR`, sessions under the agent dir, extensions as TypeScript | mintlify quick-start mirrors | unverified. Do not design from them. Re-read `packages/coding-agent/docs` at tag v0.87.1 during P4 |

Pi's `!command` pattern is the shape for a 1Password read: the reference stays
in the harness auth file, the secret is stdout for one process, and KXM does
not store the stdout.

## DeepSeek

Official interactive product, retrieved 2026-09-27:

- [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md):
  DeepSeek Harness (`dsh`) is a plugin kernel on Cordis. The documented run
  command is `npx @deepseek-ai/dsh web`, Web UI at `127.0.0.1:3080`. Developer
  preview. Compatibility-breaking changes are stated in the README.
- [Configure models](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers):
  Settings, Models, one API-key field. The page receives a redacted descriptor.
  The key is stored in `$DSH_HOME/.credentials.yaml`. Settings keep a
  credential reference. Built-in providers include `anthropic`, `openai`,
  `moonshotai`, and `zai`. The page says OAuth providers such as Codex are not
  supported on that form yet. The model picker selection becomes the default
  for new sessions. DeepSeek's own route already offers reasoning `off`, `low`,
  `high`, and `max`. `llm-deepseek.reasoningEffort` sets the picker default.
  The docs page has no version stamp.

There is no official terminal agent in that README. The only interactive
command it documents is `dsh web`. Headless `dsh --profile headless` is
described by third-party posts from 2026-08-14 and was not re-read from the
v0.1.7-rc.2 tree. Mark that flag unverified.

Not the official harness:

| Candidate | Why it is not the path | Mark |
|---|---|---|
| npm `deepseek-cli` 1.0.2 | `npm search` shows a third-party package. Publisher is not DeepSeek | verified that the package exists; unverified that its CLI matches anything |
| CodeWhale / `deepseek-tui-cli` | Community TUI. A lib.rs page says first launch asks for a key in `~/.codewhale/config.toml` | unverified |
| `deepseekdocs.com` quickstart dated 2026-09-09, claiming master `0.1.5-alpha.1` and npm latest `0.1.2-rc.1` | Not the docs URL in the official README. Those version claims are older than npm latest `0.1.7-rc.2` | unverified, and stale if compared with npm on 2026-09-27 |
| ofox.ai and deepseek-harness.app posts, 2026-08-14 | They agree there is no official TUI. They are not DeepSeek | unverified |

Most-used integration path that this repo can already name:

- Pi documents `DEEPSEEK_API_KEY` (verified, pi.dev).
- This checkout's admitted routes include `qwen-token-plan/deepseek-v4.1-flash`
  in `.kxm/routes.yaml`. That is a token-plan model id, not a `deepseek` CLI.
- KXM's harness catalog still probes a binary named `deepseek` and records
  `auth_unknown` (`plugins/kxm/src/harness.ts`). That binary name is not `dsh`.

## Comparable first-run UX

Only the decisions KXM should reuse.

| CLI | What was read | Decision it supports | Mark |
|---|---|---|---|
| Claude Code | [authentication](https://code.claude.com/docs/en/authentication) and [quickstart](https://code.claude.com/docs/quickstart), 2026-09-27. Bare `claude` on first launch opens a browser. `ANTHROPIC_API_KEY` skips login and asks the operator to approve the key. `/logout` resets first-launch state. `claude setup-token` prints a token and does not save it; CI uses `CLAUDE_CODE_OAUTH_TOKEN`. The auth page discusses `forceLoginMethod` as of Claude Code v2.1.212 | Bare TTY command is the login. An env key skips the wizard and still confirms. CI tokens are env, not project files | verified as those docs. CLI version on this machine was not probed |
| Codex CLI | [learn.chatgpt.com Codex CLI](https://learn.chatgpt.com/docs/codex/cli), 2026-09-27. First `codex` in a project asks the operator to sign in with ChatGPT or another method | Same bare-command login. Device-code and `config.toml` credential-store details came from a mintlify mirror and are not used | verified for the first-run prompt. Device-code steps unverified |
| Gemini CLI | [authentication.mdx](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx) on main, 2026-09-27. Run `gemini`, choose Sign in with Google, credentials cached locally. Cloud environments can authenticate from ambient credentials | Same pattern. No doc version on the page | verified as main-branch docs. Package version unverified |

Shared shape: the vendor keeps the credential, the project repo does not, a
repeat launch does not ask again, and a non-interactive path is an env var or
a one-shot token command.
