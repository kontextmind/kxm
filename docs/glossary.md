# Glossary

This page defines the words KXM uses in its docs, CLI help and tools, and separates the ones that are easy to confuse, such as a hub workflow run and a Runtime run. [Canonical terminology](contracts/terminology.md) remains the normative source for the Runtime, workflow and evidence terms used in specifications; this glossary adds the hub, credential and operator terms and says how each applies today.

Terms are grouped by topic and sorted alphabetically within each group. Every term has its own anchor, so other pages can link to it directly, for example `glossary.md#hub`.

- **Product and components:** [Claude Code plugin](#claude-code-plugin) · [Dashboard](#dashboard) · [Harness](#harness) · [Home Runtime](#home-runtime) · [Hub](#hub) · [Hub binding](#hub-binding) · [KontextMind](#kontextmind) · [KXM](#kxm) · [Loopback](#loopback) · [Native harness](#native-harness) · [Pi extension](#pi-extension) · [Runtime](#runtime) · [Runtime supervisor](#runtime-supervisor) · [Studio](#studio) · [User state root](#user-state-root) · [Workspace](#workspace)
- **Projects, identities and credentials:** [Admin token](#admin-token) · [Agent](#agent) · [Agent key](#agent-key) · [Coordinator](#coordinator) · [Peer](#peer) · [Project](#project) · [Project ID](#project-id) · [Project token](#project-token) · [Session token](#session-token) · [Signal secret](#signal-secret) · [Tenant](#tenant) · [Worker](#worker) · [Workflow start secret](#workflow-start-secret)
- **Messages:** [Channel mode](#channel-mode) · [Correlation ID](#correlation-id) · [Delivery mode](#delivery-mode) · [Fanout](#fanout) · [Idempotency key](#idempotency-key) · [Message](#message) · [Pull mode](#pull-mode) · [Reply](#reply) · [Request](#request)
- **Hub workflows:** [Audit escalation](#audit-escalation) · [Checkpoint](#checkpoint) · [Delivery ID](#delivery-id) · [Journal](#journal) · [Retrospective](#retrospective) · [Signal](#signal) · [Stage](#stage) · [Wait](#wait) · [Webhook workflow definition](#webhook-workflow-definition) · [Workflow run](#workflow-run)
- **Runtime runs:** [Assignment](#assignment) · [Attempt](#attempt) · [`blocked_uncertain`](#blocked_uncertain) · [Configuration revision](#configuration-revision) · [Drive](#drive) · [Drive receipt](#drive-receipt) · [Handoff](#handoff) · [Outbox](#outbox) · [Run](#run) · [Step](#step) · [Sync event](#sync-event) · [Workflow](#workflow)
- **Evidence and provenance:** [Degradation](#degradation) · [Effect](#effect) · [Evidence](#evidence) · [Evidence policy](#evidence-policy) · [Evidence reference](#evidence-reference) · [Fencing token](#fencing-token) · [Gate](#gate) · [Lease](#lease) · [Peer-reply evidence](#peer-reply-evidence) · [Producer](#producer) · [Quorum](#quorum) · [Receipt](#receipt) · [Required evidence](#required-evidence)
- **Context, memory and learning:** [Authority](#authority) · [Candidate](#candidate) · [Coded-repeat candidate](#coded-repeat-candidate) · [Context item](#context-item) · [Context packet](#context-packet) · [Dispatch context](#dispatch-context) · [Episode](#episode) · [Governed skill](#governed-skill) · [Improvement report](#improvement-report) · [Memory](#memory) · [Memory revision](#memory-revision) · [Promotion](#promotion) · [Promotion readiness](#promotion-readiness) · [Recall](#recall) · [Skill](#skill) · [Temporal state](#temporal-state) · [Wiki](#wiki)
- **Configuration and routing:** [Admission](#admission) · [Agent definition](#agent-definition) · [Cost basis](#cost-basis) · [Expansion](#expansion) · [Role](#role) · [Roster](#roster) · [Route](#route) · [Session](#session) · [Session isolation](#session-isolation) · [Trust diff](#trust-diff)
- [Words to avoid](#words-to-avoid)

## Product and components

### Claude Code plugin

The `kxm@kxm` plugin for Claude Code. It adds an MCP server with the `kxm_*` tools, optional [channel mode](#channel-mode), a read-only SessionStart hook that briefs Claude in a KXM project, and the [suite skills](#skill). See the [plugin README](../plugins/kxm/README.md).

### Dashboard

`kxm dash`: live terminal screens for agents, tasks, workflows, plans, inbox, processes and spend. Its operations stream carries metadata only, never message bodies. The spend screen is always empty today; `kxm routing report` shows route costs.

### Harness

The coding-agent program an [agent](#agent) runs in. KXM knows `pi` (the default), `claude`, `codex`, `grok`, `agy`, `kimi` and `deepseek`, and refuses unknown ones. A harness runs only the models it hosts. `kxm harness list` shows which are installed and logged in. Compare [worker](#worker).

### Home Runtime

The [Runtime](#runtime) that accepted a [run](#run), recorded as its `homeRuntimeId` (an `rtm_` ID). It owns that run for the run's whole life.

### Hub

The service that authenticates [agents](#agent), stores [messages](#message) and [workflow runs](#workflow-run) in SQLite, and pushes events over server-sent events (SSE). `kxm hub start` runs it on `127.0.0.1:7331` by default, with its database at `.kxm/state/kxm.db` in the directory it starts in. It routes work and tracks workflow runs, but never runs a model, executes a Runtime [run](#run), or merges agent contexts. Compare [Runtime](#runtime).

### Hub binding

The record that `kxm hub bind <url>` writes to `hub-binding.json` in the [user state root](#user-state-root), naming the hub this machine uses. `kxm hub view` checks it, and the Runtime syncs to it. Binding a remote hub requires a credential.

### KontextMind

The organization that builds KXM, and the name of a separate knowledge plane that the [mind-plane skills](#skill) target. Do not use it as a name for KXM itself.

### KXM

The product: the `kxm` CLI, the [hub](#hub), the [Runtime](#runtime), the [Pi extension](#pi-extension), the [Claude Code plugin](#claude-code-plugin) and the Agent Skills, published together as `@kontextmind/kxm`. Write it in capitals.

### Loopback

The `127.0.0.1` interface. The hub and the Runtime supervisor listen there by default, and the hub refuses to listen on any other address without a token. Serving a hub to other machines needs TLS and an authenticating proxy; see [Deploy KXM](operations/deploy.md).

### Native harness

A model vendor's own [harness](#harness), such as `claude` for Anthropic models or `codex` for OpenAI models. The rule is to run a vendor's model in its native harness, not through Pi. The Pi native-vendor brake enforces it at dispatch and when a long-lived [worker](#worker) starts, and [admission](#admission) is a second layer. A few cases are still operator policy; see [where the code is looser than the rules](reference/harness-routing.md#where-the-code-is-looser-than-the-rules).

### Pi extension

The KXM extension that Pi loads from the `@kontextmind/kxm` package. It registers the same `kxm_*` tools as the Claude Code plugin plus the `/kxm` command, connects to the hub, and starts a local hub in the background when none is running (`hub.autoStart: background`).

### Runtime

The per-user, per-machine KXM service that owns [runs](#run). It executes workflow steps, keeps an append-only event store per project, and sends [sync events](#sync-event) to the hub through an [outbox](#outbox). It keeps working while the hub is down, and its state lives in the [user state root](#user-state-root), not in the repository. Compare [hub](#hub).

### Runtime supervisor

The background process that hosts the [Runtime](#runtime) on a `127.0.0.1` port behind a bearer token. `kxm run` starts it when needed, and `kxm runtime start`, `status` and `stop` manage it.

### Studio

`kxm studio`: Web Studio utilities that lay out a workflow as a graph, stepper or swimlanes (`kxm studio layout`) and serve that view on your machine (`kxm studio serve`, port 4242).

### User state root

The per-user directory for machine state: `hub-env.json` (the hub's saved credentials), `hub-binding.json`, and the Runtime's `runtime/` stores. It is `KXM_STATE_HOME` when set, otherwise `~/Library/Application Support/KXM` on macOS, `${XDG_STATE_HOME:-~/.local/state}/kxm` on Linux, or `%LOCALAPPDATA%\KXM` on Windows.

### Workspace

The `.kxm/` directory at the project root. It holds the tracked project definition (`project.yaml`, `agents/`, `workflows/`, `gates.yaml` and more) plus the local `state/`, `logs/` and `backups/` directories that you keep out of Git. `--workspace` points a command at another one. It is not the [project](#project), and not a Git worktree.

## Projects, identities and credentials

### Admin token

The hub operator's credential (`KXM_AUTH_TOKEN` when you run `kxm hub start`). The hub generates one on first start and saves it in `hub-env.json` in the [user state root](#user-state-root). It opens the admin routes, and the hub also accepts it for any project without its own token, so never give it to an agent.

### Agent

A registered identity in one hub [project](#project), with a purpose and a name that is unique among the project's live agents. Pi sessions, Claude Code sessions and [workers](#worker) all register as agents. When a Claude Code session's name is taken, it registers as `<name>-<pid>`. Compare [worker](#worker).

### Agent key

A per-agent secret the hub issues when an agent registers, and replaces each time it registers again. Clients send it with the agent ID (`x-kxm-agent-id` and `x-kxm-agent-key`) on every operation that acts as that agent.

### Coordinator

The agent a [workflow run](#workflow-run) is assigned to. It follows the stages, gathers evidence and records [checkpoints](#checkpoint), and it can never count as a [producer](#producer) for its own run. A `kxm.workflow.v1` [workflow](#workflow) names its coordinator agent in `coordinator:`.

### Peer

Another [agent](#agent) in the same [project](#project). `kxm_list` and `kxm peer list` show peers with their presence: online, stale or offline.

### Project

The authentication and discovery namespace on the hub. An agent names it with `KXM_PROJECT` (otherwise the `package.json` name, then the directory name), and its key in the hub's `KXM_PROJECT_TOKENS` holds its token. Agents see only peers in the same project. Compare [project ID](#project-id).

### Project ID

The stable `prj_` identifier in `.kxm/project.yaml`. The [Runtime](#runtime) and hub sync use it. It is not the hub [project](#project) name, even though both describe the same body of work.

### Project token

The credential that the agents of one [project](#project) use. The operator sets it in the hub's `KXM_PROJECT_TOKENS` JSON map, and agents receive it as `KXM_AUTH_TOKEN` or the plugin's `auth_token`. Setting `KXM_PROJECT_TOKENS` replaces the hub's saved map, so list every project each time.

### Session token

A local token that carries a tool policy and expires after 24 hours. It lives in your KXM user configuration directory or in `KXM_SESSION_TOKEN`. When one is present, the MCP and Pi tools refuse calls it does not allow, and refuse every call once it is malformed or expired. It is an unsigned local policy, not a hub credential. `kxm session brief` creates one when none is valid; `kxm session token --clear` removes the file.

### Signal secret

The HMAC-SHA256 secret that signs a [signal](#signal) for a running workflow. A definition sets it with `signalSecret` or `signalSecretEnv`, and falls back to the [workflow start secret](#workflow-start-secret) when it sets neither; use a separate one. `kxm gate signal` and `kxm gate github watch` read it from `KXM_WORKFLOW_SIGNAL_SECRET`.

### Tenant

One hosted KXM deployment for one customer: a hub and a Runtime on one host behind an authenticating proxy. `kxm tenant status` reads both as one labeled view. The hub itself has no tenant concept; separate hosts provide the separation. See [Deploy KXM](operations/deploy.md).

### Worker

A long-lived Pi process that `kxm agent worker` starts and restarts, with model fallbacks, a tool allowlist and optional [session isolation](#session-isolation). A worker is a process; the [agent](#agent) is the identity it registers. See [Run supervised Pi workers](guides/pi-workers.md).

### Workflow start secret

The HMAC-SHA256 secret that signs a webhook delivery that starts a [workflow run](#workflow-run). A [webhook workflow definition](#webhook-workflow-definition) names it with `secret` or `secretEnv`, and `kxm workflow start` reads it from `KXM_WORKFLOW_SECRET`.

## Messages

### Channel mode

Pushed delivery in Claude Code: the plugin injects each peer request into the running session as a channel event, and Claude answers with `kxm_reply`. It needs a Claude Code launch with the plugin's channel enabled. Compare [pull mode](#pull-mode).

### Correlation ID

A sender-chosen label that groups related messages. When a message carries `workflowContext`, the hub binds the correlation ID to the run. Like an [idempotency key](#idempotency-key), it is not evidence.

### Delivery mode

A priority hint for how the recipient takes up a request: `steer` for an active blocker, `followUp` (the default), or `nextTurn`. The Pi extension orders its queue of inbound requests by mode.

### Fanout

One request sent independently to one to three peers, with `kxm_fanout` or `kxm peer fanout`. When the local wait ends first, it returns pending entries with durable message IDs to check later; they are not failures.

### Idempotency key

A sender-chosen key that makes a retried send return the original message instead of creating a duplicate; reusing it for a different request is refused. It is a transport feature and proves nothing about who answered.

### Message

<a id="message-request-reply"></a>The durable hub record of one [request](#request) and its [reply](#reply). Its state moves `queued → delivered → replied`, or ends `cancelled` (by the sender) or `expired` (past its time to live). A queued message is pushed again whenever its recipient reconnects, until the recipient acknowledges it; an acknowledged (delivered) message is not replayed. See [Message peer agents](guides/peer-messaging.md).

### Pull mode

The default in Claude Code: Claude lists open requests with `kxm_inbox` and answers each with `kxm_reply`. Nothing arrives on its own. Compare [channel mode](#channel-mode).

### Reply

The recipient's final answer to a request, sent with `kxm_reply` or `kxm peer reply`, or settled automatically by the Pi extension. A reply settles the [message](#message).

### Request

What a sender creates with `kxm_send`, `kxm_fanout` or `kxm peer send`: one focused ask for one peer, stored as a [message](#message).

## Hub workflows

### Audit escalation

What a stage does when it has failed as many times as its `autoResumeLimit` allows: instead of retrying, the run waits for an operator ruling. A signal or `kxm role resume` gives the ruling.

### Checkpoint

The coordinator's recorded result for the active [stage](#stage): `passed`, `warning` or `failed`, with the stage's [required evidence](#required-evidence). A warning or failure uses up an attempt; the stage passes only when a checkpoint passes.

### Delivery ID

The identifier a webhook sender puts in `x-kxm-delivery-id`, which the KXM sender contract signs, or for a Jira or GitHub delivery in `X-Atlassian-Webhook-Identifier` or `X-GitHub-Delivery`. The hub requires one and deduplicates on it: a repeated start with the same body returns the existing run ID, and the same ID with a different body is refused.

### Journal

A [workflow run](#workflow-run)'s structured record of what agents learned, in ten categories: `plan`, `decision`, `contradiction`, `error`, `lesson`, `observation`, `hypothesis`, `experiment`, `state-change` and `skill-candidate`. Lessons and skill candidates need evidence. An entry can name its `stageId`, and the hub derives the attempt. The hub also journals errors on its own. See [Continuous improvement](guides/continuous-improvement.md).

### Retrospective

A proposed-only summary of a finished workflow run, in Markdown and JSON. The hub exports one when a run ends, and `kxm workflow export` exports one on demand. It proposes improvements; it never applies them.

### Signal

A signed external result, such as CI passing, posted to the hub for a waiting [stage](#stage). It checkpoints the stage and creates a fresh message that resumes the [coordinator](#coordinator). `kxm gate signal` and `kxm gate github watch` send signals.

### Stage

One ordered unit of a [webhook workflow definition](#webhook-workflow-definition), with `requiredEvidence`, optional [evidence policies](#evidence-policy) and `maxAttempts`. A stage passes only through a [checkpoint](#checkpoint). Compare [step](#step).

### Wait

A durable pause on the active stage, entered with `kxm_workflow_wait`, that lasts until a signed [signal](#signal) arrives or the deadline passes (24 hours by default, 30 days at most). The coordinator can end its turn while it waits, and an expired wait fails the run.

### Webhook workflow definition

A JSON definition with ordered [stages](#stage). The hub loads definitions from the JSON array in `KXM_WEBHOOK_WORKFLOWS_FILE`, and a signed webhook or `kxm workflow start` starts a run of one. Compare [workflow](#workflow), the `kxm.workflow.v1` YAML the Runtime runs. See [Workflow definition reference](reference/workflow-definitions.md).

### Workflow run

A durable hub run of a [webhook workflow definition](#webhook-workflow-definition), assigned to a [coordinator](#coordinator). Inspect it with `kxm workflow list` and `kxm workflow get`, or the `kxm_workflow_*` tools. Compare [run](#run): Runtime runs use the same `run_` ID format, so check which command created an ID.

## Runtime runs

### Assignment

One unit of work inside the active [step](#step), such as one agent's part in a panel. Its ID stays the same across recovery.

### Attempt

One try at something that can be retried: one entry into a [stage](#stage) or [step](#step), bounded by `maxAttempts`, or one physical execution of an [assignment](#assignment). Evidence from an earlier attempt does not satisfy a later one unless the workflow allows reuse.

### `blocked_uncertain`

A Runtime state for a run whose [effect](#effect) KXM cannot prove happened or did not happen. KXM will not replay it automatically; an operator decides with `kxm gate signal --recovery-action` and one of `retry`, `unblock`, `fail` or `cancel`.

### Configuration revision

The content hash of the validated `.kxm/` bundle a [run](#run) uses, printed as `config sha256:…` when `kxm run` creates the run. See [memory revision](#memory-revision) for what happens when it changes.

### Drive

Advancing a [run](#run): `kxm runs drive <runId>` asks the Runtime to execute steps until the run settles or hands off. `--simulated` uses a model-free producer; without it, the Runtime calls live harnesses on [admitted](#admission) routes.

### Drive receipt

The record that closes each [drive](#drive) (`kxm.drive-receipt.v1`): how the run settled, or why it handed off, with a hash of the event sequence it covered. `kxm runs status` verifies it and reports `receipt verified`. Not the same as an effect [receipt](#receipt).

### Handoff

A drive that stops without settling the run, because the run needs something this Runtime cannot do yet, such as an unsupported step kind or limit. The run stays open. A handoff found during the drive is recorded in the [drive receipt](#drive-receipt); one found when the drive opens, such as an unsupported limit, is refused with HTTP 409 `run_handoff_required` and writes no receipt.

### Outbox

The Runtime table that receives a sync-safe copy of each event in the same transaction as the event itself. The supervisor posts outbox rows to the hub and parks any row the hub durably refuses until `kxm runtime sync-retry`. See [Runtime sync](operations/runtime-sync.md).

### Run

One execution of a [workflow](#workflow), owned by one [home Runtime](#home-runtime) and pinned to the revisions it was accepted with. `kxm run` creates it, and `kxm runs` inspects, drives and cancels it. Compare [workflow run](#workflow-run).

### Step

One top-level state of a [workflow](#workflow): an `agent`, `moa` (a panel of agents), `gate`, `approval` or `wait` step, with `on:` transitions to the next step or to a terminal status. Only one step is active at a time. Today the Runtime dispatches `approval` and `wait` steps to an agent like any other step; it does not wait for a person or a signal. Compare [stage](#stage).

### Sync event

A bounded, redacted summary of a Runtime event that the Runtime sends the hub (`kxm.sync-event.v1`). It carries allowlisted metadata, not local payloads, and the hub accepts each project, run and sequence once.

### Workflow

A `kxm.workflow.v1` YAML file in `.kxm/workflows/`, whose file name is its ID. It declares a [coordinator](#coordinator), limits, and ordered [steps](#step) with transitions between them, and `kxm run` runs it in the [Runtime](#runtime). Compare [webhook workflow definition](#webhook-workflow-definition).

## Evidence and provenance

### Degradation

An admin-only, recorded decision (`kxm gate degrade`) to accept fewer [producers](#producer) than a policy's minimum, down to the floor the policy declares, for one stage attempt.

### Effect

A read or a change that a tool, gate or adapter causes outside the event log. The Runtime classifies every effect for recovery. Today, Runtime effects come from gate steps.

### Evidence

What a checkpoint supplies to satisfy [required evidence](#required-evidence). In a hub workflow, evidence is keyed strings whose keys must match exactly after normalization; extra keys never stand in for a missing one. Caller-written text proves nothing on its own; see [evidence reference](#evidence-reference).

### Evidence policy

A stage rule, under `evidencePolicies`, that one requirement is met only by [peer-reply evidence](#peer-reply-evidence): at least `minProducers` distinct replies from `eligibleAgents`, with an optional [degradation](#degradation) floor.

### Evidence reference

A durable identifier cited as proof, such as a message ID in a checkpoint's `evidenceRefs`, which the hub then verifies. Compare [evidence](#evidence), which the caller writes.

### Fencing token

The number a [lease](#lease) carries. It rises only when another holder takes the lease over, and the hub refuses a commit that presents a superseded token.

### Gate

Always qualify this word:

- **gate command**: a `kxm gate …` command, such as `kxm gate validate` or `kxm gate github watch`;
- **evidence gate**: a stage's required evidence and evidence policies, checked at each checkpoint;
- **gate step**: a Runtime `kind: gate` step that runs a command from `.kxm/gates.yaml` and records hashed results;
- **witness gate**: the `npm run verify` check that the developer [assignment runner](contributing/assignment-runner.md) runs.

### Lease

A time-bounded grant from the hub on a shared resource, carrying a [fencing token](#fencing-token), for work that more than one Runtime could change. A lease lasts from 5 seconds to 10 minutes.

### Peer-reply evidence

A reply to a request that the coordinator sent with exact `workflowContext`: the run, stage, requirement and attempt. The hub stamps that context when the request is sent and checks it again at the checkpoint, so only replies the hub routed can count.

### Producer

This word has two meanings. In provenance, a producer is the peer agent whose hub-recorded reply counts toward a requirement; the [coordinator](#coordinator) never counts. In the [Runtime](#runtime), a producer is the component that answers an attempt: the model-free simulated producer or a live one-shot harness. Runtime producers must return a structured outcome, so prose never passes a step.

### Quorum

The number of distinct eligible [producers](#producer) that an [evidence policy](#evidence-policy) requires. A quorum proves which identities answered through the hub under one project credential. It does not prove that the answers are correct, independent or approved.

### Receipt

A durable external identifier that proves an [effect](#effect)'s outcome, such as a Git ref, a pull request ID or a deployment ID. Compare [drive receipt](#drive-receipt).

### Required evidence

The evidence a [stage](#stage) (hub) or [step](#step) (Runtime) declares under `requiredEvidence`. A checkpoint cannot pass until every entry is satisfied.

## Context, memory and learning

### Authority

How much weight a [context item](#context-item) carries: `policy`, `instruction`, `evidence` or `hypothesis`. An item's origin caps it (the authority grant floor): human and workflow origins can reach `policy`, Git `instruction`, and peer, tool, external and derived content only `evidence`. An agent's state proposal counts as peer origin, and a derived item never gains authority.

### Candidate

A proposed change, such as a memory note, a [governed skill](#governed-skill) or a [coded-repeat candidate](#coded-repeat-candidate), stored with its evidence. A candidate is never active until a person promotes or merges it.

### Coded-repeat candidate

A step that `kxm improve` found repeating: the same workflow step, role and prompt, with the same objective decided in at least two runs, accepted in at least 75% of its decided attempts, and writing no repository. The candidate proposes replacing the model turn with a coded gate step or a governed skill, and is written to `.kxm/candidates/` for review. It changes nothing by itself.

### Context item

One durable record the context system can select: evidence, state, an episode, knowledge or a skill, with a scope, a confidence and an [authority](#authority). A context item can never carry permissions or tool grants.

### Context packet

A token-budgeted set of [context items](#context-item) for one role and task, built by `kxm context get` or `kxm_context`. Selection is deterministic (no model, clock or randomness), ranked by relevance to the task, and filled first-fit to the budget. The packet has `currentState`, `knowledge`, `evidence`, `episodes`, `skills` and `contradictions` sections; superseded and rejected records are left out.

### Dispatch context

The project [memory](#memory) and verified promoted skills that the Runtime gives an agent it dispatches, rendered in the prompt under "Environment & Memory" and "Active Skills". Only content committed at the pinned revision is delivered. Otherwise the packet records a `dispatch_context_*` gap and the step runs without it.

### Episode

A [context item](#context-item) drawn from workflow journals (errors, lessons, observations and experiments) so that later work can learn from earlier runs. Read episodes with `kxm context episode` or `kxm_episode`.

### Governed skill

A skill candidate managed by `kxm skills`. `create` submits it, `evaluate` records static-review, sandbox, functional and safety results, and `promote` or `reject` decides it; a failed functional or safety evaluation quarantines it. Promotion needs every evaluation passed and a promoter who is not the author. Promoted skills are hash-pinned and served as context. Evaluations are recorded results; KXM does not run them.

### Improvement report

Two reports share this name. `kxm_improvement_report` summarizes a project's workflow journals by improvement area, with ranked cross-run signals. `kxm improve report` reads Runtime routing records and telemetry and writes [coded-repeat candidates](#coded-repeat-candidate).

### Memory

Git-authored project facts in `.kxm/memory/`. `kxm memory brief` prints them, `kxm memory note` records a candidate that a pull request promotes, and `kxm memory sync` projects them into whichever of `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` the project already has. Reserve the word for this; other context records are [context items](#context-item).

### Memory revision

A hash of the project's memory and promoted skills, pinned with the [configuration revision](#configuration-revision) when a run is accepted. If either changes before the run's plan is pinned, the Runtime refuses to prepare it (`run_revision_drift`); after that, changed memory is withheld from [dispatch context](#dispatch-context).

### Promotion

An authorized decision that makes something current. For [temporal state](#temporal-state), an operator runs `kxm context promote` with the admin token, and the promoter cannot be the author; agents only propose, with `kxm_promote`. For a [governed skill](#governed-skill), it is `kxm skills promote`, and for [memory](#memory), a merged pull request. Compare [promotion readiness](#promotion-readiness).

### Promotion readiness

Whether a [candidate](#candidate) is ready for a person to review, under `improvement.promotionPolicy`: `manual_pr` (the default), `critic_quorum` or `auto_threshold`. Readiness never authorizes anything; every policy ends in a reviewed Git change.

### Recall

A metadata-only search of context records by text (`kxm context recall` or `kxm_recall`), with a relevance score for each item and no summaries.

### Skill

Always qualify this word:

- **suite skill**: one of the bundled `kxm-*` Agent Skills that teach a harness the `kxm` commands and tools;
- **browser skill**: a bundled `kxm-browser-*` skill for browser automation;
- **mind-plane skill**: a bundled skill, such as `kxm-mind`, for the separate [KontextMind](#kontextmind) knowledge plane;
- **governed skill**: a candidate managed by `kxm skills`; see [governed skill](#governed-skill);
- **repo-local skill**: a skill kept in a repository's own `.agents/skills/` directory.

### Temporal state

Project facts stored as state keys with a `proposed → current → superseded` lifecycle and historical queries (`--as-of`). State informs work but never grants a capability.

### Wiki

Markdown pages compiled from a project's context records by `kxm context wiki-compile` (a dry run unless you pass `--out`), with state, decisions, contradictions and history linked to their evidence. `kxm context wiki-lint` checks the result.

## Configuration and routing

### Admission

The decision that a [route](#route) may run live. `kxm routes admit` lists it under `admitted` in `.kxm/routes.yaml`, and `kxm routes disable` blocks it. A live [drive](#drive) refuses an unadmitted route with `producer_route_not_admitted`.

### Agent definition

A `kxm.agent.v1` file in `.kxm/agents/` that states an agent's purpose and its ceilings for tools, repositories and network. `kxm init` creates `coordinator` and `implementer`.

### Cost basis

How the cost of one Runtime attempt is known: `metered`, `unmetered` (a subscription login) or `unknown`. Settlement requires a basis. Today's producers record `unmetered` for subscription logins and `unknown` otherwise, and a list-price estimate never becomes a metered cost.

### Expansion

A [trust diff](#trust-diff) change that widens what agents may do, such as a new workflow or write access to a repository. A person reviews and commits each one.

### Role

A `kxm.role.v1` definition in `.kxm/roles/`, managed with `kxm role`, that describes a seat such as `planner`, `writer` or `verifier` and its model roster. When a role file exists, a Runtime step that uses the role may run only routes in its roster.

### Roster

A list of allowed models. It means either a [role](#role)'s roster, or the developer roster `.kxm/roster.yaml` that the [assignment runner](contributing/assignment-runner.md) trusts to choose writers and critics. Neither one admits a route; see [admission](#admission).

### Route

A model selector, such as `xai/grok-4.6` or `openrouter/qwen/qwen3-coder-plus`, that a step can run on. The harness that runs it comes from the agent or the project default. See [Harness routing](reference/harness-routing.md).

### Session

Always qualify this word:

- **session manifest**: the plan `kxm session start` writes; it launches nothing;
- **Pi session**: one Pi model conversation, stored on disk;
- **Claude session**: one running Claude Code conversation;
- **session brief**: the summary of recent work that `kxm session brief` prints, read from the hub's `kxm.db` and this machine's Runtime stores, with a `source` of `legacy`, `runtime` or `both`;
- **session token**: see [session token](#session-token);
- **session isolation**: see [session isolation](#session-isolation).

### Session isolation

A [worker](#worker) setting (`--session-isolation workflow`) that keeps one ordinary Pi session plus a separate Pi session for each [workflow run](#workflow-run), so work on one run never sees another run's model history. It separates model context, not processes or files, so it is not a sandbox.

### Trust diff

The structured permission diff that `kxm trust diff` prints between `.kxm/` in the working tree and a base Git revision. Each change is classified, and `kxm trust check` exits non-zero while any [expansion](#expansion) is present. It covers project, repository, agent, model, environment, workflow and gate-registry files, not `routes.yaml`, roles, the roster or prices.

## Words to avoid

| Instead of | Write |
|---|---|
| "server" or "broker" for the hub | hub |
| "bot" | agent (the identity) or worker (the process) |
| "task" for a peer message (`kxm task` is a separate feature) | request |
| "API key" | admin token, project token, agent key or session token |
| "log" for a run's structured record | journal |
| "memory" for context records | context item; memory means Git memory |
| "independent verification" for a quorum | peer-reply quorum, which proves routing provenance |
| "TUI" as a product name | dashboard (`kxm dash`) |
| Bare "run", "session", "gate", "skill" or "project" | The qualified term from this page |
| Model nicknames | The model ID, such as `xai/grok-4.6` |

## Related

- [Canonical terminology](contracts/terminology.md): the normative definitions
- [Architecture](concepts/architecture.md): how the components fit together
- [Trust model](concepts/trust-model.md): credentials and what each proves
- [Documentation index](README.md)
