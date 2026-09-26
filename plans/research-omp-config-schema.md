---
schema: "kxm.doc.v1"
id: "RESEARCH-OMP-CONFIG-SCHEMA"
type: "research"
title: "oh-my-pi (omp) configuration surfaces: roles, rosters, models, agents, and everything else, compared with KXM"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-25"
updated: "2026-09-25"
authority: "hypothesis"
confidence: "verified"
summary: "Reference for omp 18.3.1 config: config.yml settings (modelRoles, retry.fallbackChains, task.*, plan, prewalk, advisor, providers), models.yml provider and model schema, agent markdown frontmatter, rules, commands, prompts, hooks, mcp.json, plugin.json, and the absence of a declarative workflow file. Each surface is explained key by key with an example and mapped onto the KXM file that plays the same part. Read from the installed package source, not from docs."
tags: ["research", "omp", "roles", "roster", "models", "agents", "config"]
related:
  - plan-omp-config-alignment.md
  - research-omp-config-examples.md
  - evidence/omp-config-settings-18.3.1.md
  - plan-usage-cost-quota-tracking.md
  - plan-workflow-modes-selective-loading.md
  - history/plan-role-configuration-governance.md
depends_on: []
blocked_by: []
details:
  describes: "observed"
  source_package: "@oh-my-pi/pi-coding-agent 18.3.1 at ~/.bun/install/global/node_modules"
  extracted_keys: 509
---

# oh-my-pi configuration surfaces, with KXM equivalents

This is a reference, not a plan. The migration proposal that uses it is
[`plan-omp-config-alignment.md`](plan-omp-config-alignment.md). Everything below
was read from the installed omp 18.3.1 source; file paths are relative to
`@oh-my-pi/pi-coding-agent/` unless stated. The full extracted table of all 509
`config.yml` keys with type, default, env var and source file is in
[`evidence/omp-config-settings-18.3.1.md`](evidence/omp-config-settings-18.3.1.md).

## 1. Where omp keeps configuration

omp has no single schema file. `config.yml` keys are declared by `register()`
calls in 40 domain modules (`src/config/all-settings.ts` lists them). Other
surfaces are separate files discovered by `src/discovery/*`.

| Surface | User scope | Project scope | Format |
|---|---|---|---|
| Settings (509 keys) | `~/.omp/agent/config.yml` | `.omp/config.yml` | YAML, nested by dot path |
| Model catalog overrides | `~/.omp/agent/models.yml` | none | YAML, `providers:` map |
| Agents (subagent definitions) | `~/.omp/agent/agents/*.md` | `.omp/agents/*.md` | Markdown with YAML frontmatter |
| Rules | `~/.omp/agent/rules/*.md` and `RULES.md` | `.omp/rules/*.md` and `.omp/RULES.md` | Markdown with frontmatter |
| Slash commands | `~/.omp/agent/commands/*.md` | `.omp/commands/*.md` | Markdown, name from filename |
| Prompt templates | `~/.omp/agent/prompts/*.md` | `.omp/prompts/*.md` | Markdown |
| Hooks | `~/.omp/agent/hooks/{pre,post}/<tool>.*` | `.omp/hooks/{pre,post}/<tool>.*` | Executable per tool name, `*` for all |
| Extensions | `~/.omp/agent/extensions/` | `.omp/extensions/` | JS or TS modules |
| Skills | `~/.omp/agent/skills/<name>/SKILL.md` | `.omp/skills/<name>/SKILL.md` | Same layout as Claude and Codex skills |
| MCP servers | `~/.omp/agent/mcp.json` | `.omp/mcp.json` or `.mcp.json` | JSON |
| Plugins | `~/.omp/agent/plugins/` | project plugin roots | `plugin.json` (agent-plugins.org 1.0.0) |
| Context files | `~/.omp/agent/AGENTS.md` | nearest `AGENTS.md` | Markdown |
| Plans (autosave) | `~/.omp/agent/plans/` | `plan.autosaveDir` | Markdown |

Settings merge in this precedence, highest first: runtime override, config
overlay, project `.omp/config.yml`, global `config.yml`, schema default. A
`null` value in YAML counts as unset. The project layer never supplies
credentials.

omp also reads foreign configs read-only: Claude (`.claude/`, plugins, skills,
`CLAUDE.md`), Codex, Cursor, Gemini, OpenCode, VS Code, Windsurf, Cline, GitHub
copilot files, and a skillshare registry. That is how it picks up this repo's
`.claude/` and `AGENTS.md` without omp-specific setup.

## 2. Model roles (`modelRoles`)

Declared in `src/config/model-settings.ts`. A role is a name that resolves to one
model selector string. Roles are the only model indirection omp has; agents,
subagents, evals, and the TUI all ask for a role or a selector.

### Selector grammar

```text
provider/model-id[:thinkingLevel][@upstream]
@role            role alias, e.g. "@smol"
*                alias for the default role
pi/role          legacy alias form
glob             "openai/*", "openai/*:auto"
bare id          "opus" fuzzy-matches the catalog
```

Thinking levels are `minimal low medium high xhigh max off auto`. Matching order
(`src/config/model-resolver.ts`): exact `provider/id`, exact bare id, retired
alias, provider-scoped fuzzy, substring.

### Built-in role ids (`src/config/model-roles.ts` line 56)

| Role | Label | Section | Default inheritance |
|---|---|---|---|
| `default` | Default | chat | |
| `smol` | Fast | chat | |
| `slow` | Thinking | chat | |
| `vision` | Vision | chat | |
| `plan` | Architect | chat | |
| `commit` | Commit | chat | |
| `tiny` | Tiny | chat | falls back to `smol` |
| `memory` | Memory | chat | falls back to `tiny`, then `smol` |
| `task` | Subtask | chat | |
| `advisor` | Advisor | chat | falls back to `slow` when configured |
| `image` | Image generation | kind | |
| `web` | Web search | kind | |
| `speech` | Speech | kind | |
| `dictation` | Dictation | kind | |
| `judge` | Judge | kind | |

Custom role ids are allowed; anything listed in `cycleOrder`, assigned in
`modelRoles`, or described in `modelTags` becomes a known role.

### Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `modelRoles` | record role to selector | `{}` | The primary model for each role |
| `modelRoleStorage` | `global` or `project` | `global` | Where UI role edits are saved. `project` writes `.omp/config.yml`; missing project roles fall back to global |
| `modelTags` | record tag to `{name, color?, hidden?}` | `{}` | Display metadata; `hidden` keeps a role usable but out of the picker |
| `cycleOrder` | array | `[smol, default, slow]` | Ctrl+P cycle order in the TUI |
| `modelProviderOrder` | array | `[]` | Provider precedence for ambiguous unqualified selectors |
| `enabledModels` | array of patterns | `[]` | Restrict the catalog; a `:level` suffix pins that level for every match |
| `enabledProviders` / `disabledProviders` | array | `[]` | Provider allow and deny lists |
| `defaultThinkingLevel` | enum | `high` | Level used when a selector has no suffix |
| `thinkingBudgets.{minimal,low,medium,high,xhigh,max}` | number | unset | Token budgets per level for budget-style models |

### Example

```yaml
modelRoles:
  default: xai-oauth/grok-4.7:medium
  plan: anthropic/claude-fable-5-1:medium
  slow: anthropic/claude-fable-5-1:high
  smol: alibaba-coding-plan/qwen3.8-flash:low
  tiny: "@smol"
  task: "@default"
  reviewer-cli: openai-codex/gpt-5.6-sol:low   # custom role
modelRoleStorage: project
modelTags:
  reviewer-cli: { name: "CLI reviewer", color: muted }
cycleOrder: [smol, default, slow, plan, reviewer-cli]
modelProviderOrder: [xai-oauth, anthropic, alibaba-coding-plan]
enabledModels: ["xai-oauth/grok-4.7", "anthropic/*", "alibaba-coding-plan/*"]
defaultThinkingLevel: medium
```

Provider ids `xai-oauth`, `anthropic` and `alibaba-coding-plan` are confirmed in
this machine's omp config and models file. Others need checking in `/models`.

### KXM equivalent

`.kxm/roles/<id>.yaml` (`kxm.role.v1`) is the role document. Differences:

- KXM role ids are free (`writer`, `planner`, `reviewer-arch`, `reviewer-cli`);
  omp built-ins carry meaning (`smol` is the cheap model, `plan` the architect).
- KXM roster entries are objects with a separate `effort` field limited to
  `low medium high xhigh`; omp puts the level in the string and also has
  `minimal`, `max`, `off`, `auto`.
- KXM has no role alias; omp roles can point at other roles.
- KXM matches exact ids; omp fuzzy-matches. KXM admission depends on exact ids.

## 3. Retry and fallback chains (`retry.*`)

Declared in `src/session/settings.ts` line 667 onward. Together with
`modelRoles` this is omp's roster: the role holds the primary, the chain holds
the ordered fallbacks. omp's own migration code splits a legacy candidate list
exactly that way (`src/config/settings.ts` line 3003).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `retry.enabled` | boolean | unset | Master switch for API retries |
| `retry.maxRetries` | number | 10 | Attempts on API errors before giving up |
| `retry.baseDelayMs` / `retry.maxDelayMs` | number | unset / 5 minutes | Backoff bounds |
| `retry.modelFallback` | boolean | true | Allow swapping models, not only retrying the same one |
| `retry.fallbackChains` | record key to ordered selectors | `{}` | The fallback roster, see key grammar below |
| `retry.fallbackRevertPolicy` | `cooldown-expiry` or `never` | `cooldown-expiry` | Return to the primary after its suppression window, or stay on the fallback |
| `retry.usageAwareFallback` | boolean | false | Use coding-plan quota reports to prefer another account, then the chain, before a hard limit. API keys are excluded |
| `retry.usageReservePct` | number | constant | Below this remaining percentage a plan model counts as near its limit |
| `retry.usageReservePolicy` | `confirm`, `auto`, `fail-closed` | `confirm` | What to do when the reserve is reached |
| `retry.waitForUsageReset` | boolean | false | Sleep until the provider's quota window resets instead of failing. Holds subagents too |

### Chain key grammar (from the setting's own description)

- A **role id** (`default`) applies to that role.
- An exact **`provider/model`** applies whenever that model is active, any role.
- A **provider wildcard** `provider/*` keeps the failing model's id and swaps the
  provider. An id-prefixed wildcard `openrouter/google/*` re-prefixes a bare id.
- A key with a level, `provider/model:low`, matches only a failing turn at that
  level, so a 429 retry never escalates effort by accident.
- A bare entry inherits the failing turn's effort; an entry with `:level` pins it;
  `provider/*` entries always inherit.

Chains are walked on provider errors (429, transport errors, and safe post tool
call failures), bounded by `maxRetries`, and only when no explicit chain exists
does a role fall back to the built-in inheritance table (`advisor` to `slow`,
`memory` to `tiny` to `smol`).

### Example

```yaml
retry:
  enabled: true
  maxRetries: 6
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    default:                                   # KXM writer roster order
      - openrouter/qwen/qwen3-coder-plus
      - zai-coding-cn/glm-5.3-flash
      - alibaba-coding-plan/qwen3.8-flash
      - google/gemini-3.8-flash-high:off
    plan:                                      # KXM planner roster
      - alibaba-coding-plan/qwen3.8-max
    "xai-oauth/grok-4.7:high":                 # step effort down inside the vendor first
      - xai-oauth/grok-4.7:medium
    "google-antigravity/*":                    # keep the id, swap the transport
      - "google/*"
  usageAwareFallback: true
  usageReservePct: 15
  usageReservePolicy: confirm
  waitForUsageReset: false
```

### KXM equivalent

KXM has three files that look like a roster and none of them is a fallback chain:

- `.kxm/roles/<id>.yaml` `roster[]`: ordered, with `enabled`. Used by
  `engine.ts` around line 1427 only as a **membership check**: the agent's pinned
  model must appear in the role's roster or the step is refused.
- `.kxm/routes.yaml` (`kxm.routes.v2`): `admitted[]`, `disabled[]`, and a second
  `roles:` map with different role names (`implementer`, `critic-arch`,
  `critic-cli`).
- `.kxm/roster.yaml` (`kxm.developer-roster.v1`): named routes with harness,
  model, vendor, roles, permissions, status, plus `lineup.<role>[]`. Live write
  steps must find their route in `lineup.writer` with `status: admitted` and an
  `edit` permission (`engine.ts` around line 2890).

The model that actually runs is pinned in `.kxm/agents/<id>.yaml`. Nothing walks
the roster before or during a run; a 429 ends the attempt. `schemas/model.schema.json`
(`kxm.model.v1`) already declares `priority` and `fallbacks[]` per model, but no
model files exist under `.kxm/models/` (only `inventory.yaml`) and the engine does
not read those fields.

## 4. Subagent settings (`task.*`)

Declared in `src/task/settings.ts`. Agents are markdown files (section 6);
these keys override them per agent name and govern spawning.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `task.agentModelOverrides` | record agent to selector or ordered list | `{}` | Pins a model per agent, overriding frontmatter `model:`. A list is an ordered candidate roster |
| `task.agentAdvisor` | record agent to selector | `{}` | Advisor model per agent |
| `task.agentPrewalk` | record agent to selector | `{}` | Prewalk hand-off target per agent |
| `task.agentServiceTierOverrides` | record | `{}` | Provider service tier per agent |
| `task.agentCompactionThresholdOverrides` | record | `{}` | Compaction threshold per agent |
| `task.disabledAgents` | array | `[]` | Agents hidden from the task tool |
| `task.enableEffort` | boolean | false | Expose an effort parameter on spawns |
| `task.maxEffort` | enum | `max` | Ceiling for that parameter; also clamps effort after a fallback swap |
| `task.maxConcurrency` | number | 32 | Parallel subagents |
| `task.maxRecursionDepth` | number | 2 | Subagents spawning subagents |
| `task.maxRuntimeMs` | number | 0 | Per subagent wall clock, 0 is unlimited |
| `task.softRequestBudget` / `task.softRequestBudgetNotice` | number, boolean | 200, true | Advisory request budget per subagent |
| `task.eager` | `default`, `preferred`, `always` | `default` | How readily the orchestrator delegates |
| `task.batch` | boolean | true | Batch queued items onto workers |
| `task.enableLsp` | boolean | false | LSP tools inside subagents |
| `task.showResolvedModelBadge` | boolean | false | Show the resolved model in the TUI |
| `task.isolation.enabled` | boolean | false | Each subagent works in its own worktree copy |
| `task.isolation.apply` | boolean | true | Apply subagent changes back |
| `task.isolation.merge` | `patch` or `branch` | `patch` | How changes come back |
| `task.isolation.commits` | `generic` or `ai` | `generic` | Commit message style for isolated work |
| `isolation.backend` | enum auto, apfs, btrfs, zfs, reflink, overlayfs, projfs, block-clone, rcopy | `auto` | Copy-on-write backend for isolation and worktrees |
| `tier.subagent` | enum | `inherit` | Service tier for spawned subagents |

### Example

```yaml
task:
  agentModelOverrides:
    reviewer: "@slow"
    security-reviewer: anthropic/claude-fable-5-1:high
    scout: ["@smol", "alibaba-coding-plan/qwen3.8-flash:low"]
  agentAdvisor: { task: "@advisor" }
  agentPrewalk: { task: "@smol" }
  disabledAgents: [init]
  enableEffort: true
  maxEffort: high
  maxConcurrency: 8
  maxRecursionDepth: 2
  maxRuntimeMs: 1800000
  isolation: { enabled: true, apply: true, merge: patch, commits: generic }
```

### KXM equivalent

`.kxm/agents/<id>.yaml` (`kxm.agent.v1`) holds `harness`, `model`, `tools`,
repository access, network, and `resultSchema`. Concurrency and isolation live in
the workflow (`maxAttempts`, `repositories`) and project limits
(`maxConcurrentRuns`). KXM has no per-agent advisor or prewalk, and no effort
ceiling.

## 5. Plan, prewalk, advisor, providers

| Key | Type | Default | Meaning |
|---|---|---|---|
| `plan.enabled` | boolean | true | Plan mode available |
| `plan.defaultOnStartup` | boolean | false | Start sessions read-only in plan mode |
| `plan.autosave` / `plan.autosaveDir` | boolean, string | false, unset | Save plans to disk |
| `prewalk.enabled` | boolean | false | Plan on the active model, then switch to the `smol` role at the first edit after the todo list exists |
| `advisor.enabled` | boolean | false | A second model reviews turns |
| `advisor.immuneTurns` | number | 3 | Turns before the advisor may interrupt |
| `advisor.maxNotesPerUpdate` | number | constant | Advisor note budget |
| `advisor.syncBacklog` | `off`, 1, 3, 5 | `off` | Backlog sync cadence |
| `providers.anthropic.serverSideFallback` | boolean | false | Retry a Fable or Mythos refusal on Opus 5 server-side |
| `providers.anthropic.slowMode` | `off`, `auto` | `off` | |
| `providers.autoThinkingMaxEffort` | `xhigh`, `max` | `xhigh` | Cap for auto thinking |
| `providers.cacheRetention` | `auto`, `short`, `long`, `none` | `auto` | Prompt cache TTL preference |
| `providers.openrouterVariant` | `default`, `nitro`, `floor`, `online`, `exacto` | `default` | OpenRouter routing variant |
| `providers.maxInFlightRequests` | record provider to number | `{}` | Per-provider concurrency |
| `providers.streamIdleTimeoutSeconds` / `streamFirstEventTimeoutSeconds` | number | -1 | Stream timeouts |
| `tier.anthropic` / `tier.openai` / `tier.google` / `tier.advisor` | enum | `none` | Service tier per family |

The remaining groups (`compaction`, `memories`, `hindsight`, `mnemopi`, `tui`,
`images`, `skills`, `mcp`, `eval`, `commit`, `gc`, `worktree`, `secrets`,
`security`, `goal`, `loop`, `startup`) are listed in the evidence file with
descriptions. Notable for KXM: `secrets.enabled` redacts credential-shaped
tokens before requests; `worktree.base` and `worktree.clone` govern
copy-on-write worktrees; `compaction.*` has 19 keys including remote
compaction; `eval.*` is the Python and JavaScript kernel behind workpools.

## 6. Agents (`agents/*.md`)

Parsed by `parseAgentFields` in `src/discovery/helpers.ts` line 288. Template in
`src/prompts/agents/frontmatter.md`. The markdown body is the system prompt.

| Frontmatter key | Type | Meaning |
|---|---|---|
| `name` | string, required | Agent id. `main` and `sub` are reserved |
| `description` | string, required | Shown to the spawner; drives selection |
| `tools` | CSV or array | Tool allow list. `yield` is always appended. Empty list means no tools |
| `spawns` | CSV, array, or `*` | Which agents this one may spawn. Inferred `*` when `tools` contains `task` |
| `model` | selector or list | Model or role alias, e.g. `"@slow"`, or an ordered list |
| `thinking-level` (also `thinkingLevel`, `thinking`) | level | Effort for this agent |
| `output` | JSON Typedef schema | Structured result contract; validated on return |
| `blocking` | boolean | Parent waits for this agent |
| `readSummarize` | boolean | Summarize large reads |
| `prewalk` | boolean or selector | Hand off to `smol` or a named model at first edit |
| `advisor` | boolean or selector | Attach the advisor role or a named model |
| `autoloadSkills` | CSV or array | Skills injected at start |

Bundled agents: `task` (general worker, full tools), `scout` (read-only research
on `@smol`, structured `output`), `reviewer` (on `@slow`, spawns `scout`,
structured verdict), `security-reviewer` (read-only, findings schema), `init`
(writes `AGENTS.md`). `omp agents unpack` copies them to disk for editing.

### Example

```markdown
---
name: kxm-critic-arch
description: "Read-only architecture critic for a KXM implementation diff"
tools: read, find, grep, glob, lsp, ast_grep
spawns: scout
model: "@slow"
thinking-level: high
readSummarize: true
autoloadSkills: kxm, kxm-protocol
output:
  properties:
    verdict: { enum: [passed, failed] }
    findings:
      elements:
        properties:
          path: { type: string }
          summary: { type: string }
          severity: { enum: [blocker, major, minor] }
---
Review the diff for architectural integrity. Cite `path:line` for every finding.
Never edit files. Return the schema above and nothing else.
```

### KXM equivalent

`.kxm/agents/<id>.yaml` (`kxm.agent.v1`, `schemas/agent.schema.json`):

| omp | KXM | Note |
|---|---|---|
| `name` | filename | |
| `description` | `purpose` | |
| body | `instructions` | |
| `tools` | `tools.preset` / `allow` / `deny` | KXM presets: `coordinator`, `read-only`, `workspace-writer`, `tests-writer`. Enforced at dispatch through `oneShotPermissionArgs` and `enforceToolPolicy` in `commands.ts` |
| `model` | `model: {provider, model}` | KXM pins one model; no `@role` alias, no list |
| `thinking-level` | none | `effort` lives on the role roster entry, not the agent |
| `output` | `resultSchema` | KXM points at a named schema; omp inlines Typedef |
| `spawns` | none | KXM sequencing is the workflow file |
| `autoloadSkills` | none on agent; `skills[]` on the role | |
| `prewalk`, `advisor`, `blocking`, `readSummarize` | none | |
| none | `harness`, `executor`, `repositories`, `defaultRepositoryAccess`, `network`, `secrets`, `session` | omp is single-harness and has no repository or network scoping per agent |

## 7. Models catalog (`models.yml`)

Schema in `src/config/models-config-schema-bundle.ts`. Loaded by
`ModelRegistry` from `~/.omp/agent/models.yml`. Top level is `providers:`.

### Provider fields

| Field | Type | Meaning |
|---|---|---|
| `baseUrl` | string | Endpoint root |
| `apiKey` | string | Key or env reference. Secrets should stay out of Git |
| `api` | enum | Wire format: `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `openrouter-decisions`, `typesafe` |
| `auth` | `apiKey`, `none`, `oauth` | Credential mode |
| `authHeader` | boolean | Send the key as a header |
| `headers` | map | Extra headers |
| `compat` | object | Wire quirks, see below |
| `discovery` | `{type, timeoutMs?, injectV1?}` | Auto-list models from `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, `proxy`, `litellm`, `apple-foundation-models` |
| `models[]` | model definitions | Models this provider serves |
| `modelOverrides` | map id to override | Patch a bundled model without redefining it |
| `disableStrictTools` | boolean | |
| `transport` | `pi-native` | Route via an omp auth gateway |
| `remoteCompaction` | object | Server-side compaction endpoint |
| `guardrailIdentifier`, `guardrailVersion`, `guardrailTrace`, `requestMetadata` | Bedrock only | |

### Model fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string, required | Model id as sent on the wire |
| `name` | string | Display name |
| `api`, `baseUrl`, `headers`, `compat` | | Per-model overrides of the provider values |
| `reasoning` | boolean | Model can think |
| `thinking` | object | `mode` (`effort`, `budget`, `google-level`, `anthropic-adaptive`, `anthropic-budget-effort`), `efforts[]` (accepted levels), `defaultLevel`, `effortMap`, `supportsDisplay`, `requiresEffort`; legacy `levels` or `minLevel` plus `maxLevel` |
| `input` | array of `text`, `image` | Accepted inputs |
| `tokenizer` | enum | `claude-v3`, `claude-v47`, `claude-v5`, `claude-v5-sonnet`, `qwen3`, `deepseek-v3`, `kimi-k2`, `glm5` |
| `supportsTools` | boolean | |
| `cost` | `{input, output, cacheRead, cacheWrite}` | Per million tokens |
| `premiumMultiplier` | number | |
| `contextWindow`, `maxContextWindow`, `maxTokens` | number | Limits |
| `omitMaxOutputTokens`, `preferWebsockets` | boolean | |
| `contextPromotionTarget`, `compactionModel` | string | Where to promote long contexts or compact |

`compat` has about fifty boolean and enum switches for wire dialects
(`thinkingFormat`, `reasoningContentField`, `supportsToolChoice`,
`supportsForcedToolChoice`, `toolStrictMode`, `maxTokensField`, and so on) plus a
`whenThinking` sub-object that applies only while thinking is on. The extracted
list is in the evidence file's source column pointer.

### Example

Taken from this machine's `~/.omp/agent/models.yml`, which was itself built from
endpoint probes rather than docs. Key names redacted.

```yaml
providers:
  alibaba-coding-plan:
    baseUrl: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
    api: openai-completions
    auth: oauth
    compat:
      supportsReasoningEffort: true
      thinkingFormat: qwen
      reasoningContentField: reasoning_content
      supportsForcedToolChoice: true
    models:
      - id: qwen3.8-max
        name: Qwen3.8 Max
        reasoning: true
        input: [text, image]
        contextWindow: 1000000
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        thinking: { mode: effort, efforts: [minimal, low, medium, high, xhigh, max] }
        compat: { supportsForcedToolChoice: false, supportsNamedToolChoice: false }
```

### KXM equivalent

Three KXM files cover this, none with the same shape:

- `.kxm/models/inventory.yaml` (`kxm.model-inventory.v1`): fetched catalog with
  `contextLength` and `capabilities.thinking.supported`. It records **no effort
  levels**; omp's `thinking.efforts[]` is the thing KXM lacks for validating a
  roster entry's `effort`.
- `.kxm/prices.yaml` (`kxm.prices.v1`): per-model tiers with input, output, cache
  read and cache write per million, with aliases and a content hash. omp's `cost`
  block is the equivalent, less structured.
- `schemas/model.schema.json` (`kxm.model.v1`): provider, model, thinking string,
  tags, capabilities, `priority`, `fallbacks[]`, limits. This is the closest KXM
  schema to a roster entry with fallbacks, and it is currently unused.

Provider wire compat, discovery, and auth modes have no KXM equivalent because
KXM delegates all of that to the native harness.

## 8. Rules, commands, prompts, hooks, MCP, plugins

### Rules (`rules/*.md`, `rules/*.mdc`, `RULES.md`)

Frontmatter (`src/capability/rule.ts`): `enabled`, `description`, `globs[]`,
`alwaysApply`, `agents` (agent name globs; `main` is the top session), and TTSR
keys `condition`, `astCondition`, `question`, `scope`, `interruptMode`
(`never`, `prose-only`, `tool-only`, `always`). A top-level `RULES.md` is forced
to `alwaysApply` and carried on every request. KXM has no rule surface; the
nearest is `AGENTS.md` plus the tool policy.

### Slash commands and prompts

Plain markdown; the name is the filename. Commands are `/name`; prompts are
templates for `prompt-templates.ts`. KXM equivalents are the plugin skills
under `plugins/kxm/skills/`.

### Hooks

`hooks/pre/<tool>` and `hooks/post/<tool>`; the basename is the tool name or
`*`. Any executable. KXM's `gates.yaml` (`kxm.gate-registry.v1`) is a workflow
gate registry, not a per-tool hook.

### MCP (`mcp.json`)

Top level `mcpServers`, `disabledServers`, `enabledServers`. A server is stdio
(`type`, `command`, `args`, `env`, `cwd`) or remote (`type`, `url`, `headers`),
with `enabled`, `timeout`, and `oauth`. Governed by `mcp.enableProjectConfig`,
`mcp.startupTimeoutMs`, `mcp.notifications`. KXM ships its own MCP server via
the plugin; it does not consume an MCP config.

### Plugins (`plugin.json`)

Agent Plugins 1.0.0 manifest: `$schema`, `name`, `version`, `description`,
`author {name,email,url}`, `homepage`, `repository`, `license`, `keywords`,
`extensions`. A plugin root may carry `skills/`, `commands/`, `rules/`,
`prompts/`, `hooks/`, `agents/`, and `mcp.json`. `${PLUGIN_ROOT}` and
`${PLUGIN_DATA}` are reserved env names. This is the format `kxm plugin install
--omp` targets.

## 9. Is there a workflow config?

No. omp has no declarative workflow file and no equivalent of
`kxm.workflow.v1`. What it has instead:

- **`workflowz` magic keyword** (`src/modes/magic-keywords.ts`, notice in
  `src/prompts/system/workflow-notice.md`): a hidden system notice that tells the
  model to run a multi-subagent DAG through the `eval` kernel using
  `workpool()`, `agent()`, `completion()`, `judge()`, `judge_batch()`, and
  `wait()`. Phases, dependencies, and verification are decided by the model at
  run time, bounded by `task.maxConcurrency` and an advisory or hard token
  budget (`+Nk` or `+Nk!` in the prompt).
- **`orchestrate` keyword**: a contract for the top-level model to decompose,
  dispatch parallel `task` subagents, verify each phase, and never yield early.
- **Goals** (`goal.*`): a per-session goal the agent may auto-continue between
  turns in the listed run modes.
- **`/loop`** (`loop.mode`: `prompt`, `compact`, `reset`; `loop.conditionTimeoutMs`):
  re-submit a prompt until a `--while` or `--until` command condition changes.

So omp's workflow is a prompt contract over a code kernel, not data. KXM's
`.kxm/workflows/default.yaml` (steps, `on.passed` / `on.failed` transitions,
`maxAttempts`, `maxTransitions`, gates, repository scopes, plan hash oracles) has
no omp counterpart, and nothing in omp should replace it. The one idea worth
noting is the token budget with advisory versus hard semantics, which maps onto
`plan-usage-cost-quota-tracking.md`.

## 10. KXM state observed on 2026-09-25

These are the facts the migration plan relies on.

- **Five places pin a role to a model**: `.kxm/roles/*.yaml`,
  `.kxm/routes.yaml` `roles:`, `.kxm/roster.yaml` `routes[].roles` and
  `lineup`, `.kxm/agents/*.yaml` `harness` plus `model`, and
  `DEFAULT_ROLE_SEATS` in `plugins/kxm/src/role.ts` line 412 (plus the optional
  `role-hosts.yaml`). They use two vocabularies: `writer/planner/reviewer-*` and
  `implementer/critic-*`, bridged by a hardcoded alias in `engine.ts` line 1426.
- **Dispatch order**: the agent's pinned model is the selector; it must be in
  `routes.yaml` `admitted`; it must appear in the role roster; a live write step
  must also be a `roster.yaml` `lineup.writer` route with `status: admitted` and
  an `edit` permission; the harness must have an audited one-shot profile for the
  permission. No fallback is attempted at any stage.
- **Role schema drift, three shapes**: `schemas/role.schema.json` requires
  `roster[].harness` and models as `{provider, model}` objects with
  `additionalProperties: false`; the TypeScript `KxmRosterEntry` requires
  `harness` as a string and has no `enabled`; the on-disk files use
  `model: provider/model` strings, no `harness`, and `enabled: true`. The JSON
  schema is referenced only by `test/core/policy-draft.test.ts`. The
  `role modify --add-model` path writes `{harness, model}` and defaults the
  harness to `pi` when the argument has no colon.
- **Role `tools`, `skills`, `produces`, `consumes`, `policy` are never
  consumed** outside the list output (`role.ts` lines 245 and 262). Agent
  `tools.preset` is enforced.
- **Effort**: roster entries allow `low` to `xhigh`; inventory records no
  accepted levels; the writer's Gemini entry has no effort at all.
- **omp on this machine**: `modelRoles.default` is grok-4.7 at `high` through
  omp's `xai-oauth` provider and `plan` is Opus 5.5. KXM's writer runs grok-4.7
  at `medium` through the native grok harness and its planner is Fable. The two
  configs are not derived from each other.
