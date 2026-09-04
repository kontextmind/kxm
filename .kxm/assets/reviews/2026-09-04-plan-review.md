# KXM plan review, 2026-09-04

Reviewer: Claude Fable (planner / architecture critic), with five independent
critic passes (fact-check vs code, hub setup, installation, CLI surface,
implementation workflow) and one research pass (cross-harness packaging).
This is a review artifact. It proposes plan and slice edits; Grok applies them
with the change that justifies each one. Human signoff is required before any
Tracking edit lands. Nothing in this file is hub peer-reply evidence.

Scope requested: implementation plan ordering, MVP definition, implementation
workflow, hub setup and configuration, extension and plugin installation, the
`kxm` CLI, Claude plugin and Pi extension support, universal packages for
other harnesses, npm package boundaries, and multi-repository sub-workflows.

## 1. Verdict

The contract package and the landed Phase 1 and Phase 2 code are strong, and
fail-closed is a tested idiom rather than a slogan. Three things are wrong at
the plan level:

1. **The critical path has no code.** Phase 3 (the workflow engine) is the
   only thing between today and the Phase 4 gate that is the de-facto MVP, and
   it has zero lines. Every commit since PR #75 has been rename, dashboard,
   session brief, update notice, or plan prose. `kxm run` creates a run that
   can never advance and that no screen displays.
2. **The plan describes things as landed or required that do not exist.**
   Brakes on old names, harness and cost fields on routing records,
   `kxm init --hub` doing setup, a `kxm dash` spend view, and an installable
   release asset are all stated or implied and all absent.
3. **The first-run documentation teaches a removed product.** A new user
   copies `kxm mesh init` and `/mesh-status` from the README. Neither should
   work, and `kxm init` and `kxm session brief` appear in no first-run doc.

The fix is not more plan. It is one small "truth" slice (docs, brakes, honest
messages), one gate slice (coverage, dist, three failing tests), a plan patch
that names the MVP and splits Phase 3, and then Phase 3a with nothing else in
front of it.

## 2. Accuracy: plan statements versus code

| Plan statement | Reality | Evidence |
|---|---|---|
| `/mesh-status` removed "(brakes)" | Deleted outright. No brake anywhere in the source. Only a negative unit test. | `test/extension.test.ts:180`; no `removed` / `braked` helper in `cli.ts` |
| Old names fail closed | `kxm mesh init` and `kxm mesh smoke` run. `hostMode()` returns `"mesh"` into telemetry and session manifests. Wire headers are `x-mesh-agent-id`. Admin caller is `mesh-admin`. Prometheus metrics are `mesh_*`. | `cli.ts:2447-2451`, `:167-174`, `:154`, `:1432`; `hub.ts:512`, `:521`, `:545`, `:1047-1082` |
| Cost tracking is required; routing records carry harness, provider, context tokens, latency, cost | `RoutingRecord` has no `harness`, no `provider`, no latency field. Cost and token fields are optional. | `routing.ts:51-80` |
| `kxm harness list` shows detected **and authenticated** | Only `pi` and `claude` have an auth probe. `kimi`, `codex`, `gemini`, `deepseek` report `n/a`, so the native-harness preference predicate is unsatisfiable for four of six. | `vnext-harness.ts:65-130`, `:181-209`, `:322` |
| `kxm dash` spend and quality views | Six tabs exist. No spend or quality view. | `tui.ts:43-48` |
| `kxm init --hub existing\|new` landed | Parses the flag and prints advice. Persists no URL, starts no hub. The reachability probe parameter is never passed, so it always prints "not probed". | `cli.ts:479`, `:521-529`; `hub-setup.ts:50-65` |
| Session-ready `/new` and `/fork` "as a failing test" | One passing assertion on a helper predicate. No end-to-end test. | `test/session-work.test.ts:74` |
| "Confirm GitHub repository identity" still open | Remote and `package.json` both say `kontextmind/kxm`. Close it. | `git remote -v`, `package.json:7-12` |
| Install from GitHub release tarball `kxm-<v>.tgz` | No release workflow exists. `npm pack` emits `kontextmind-kxm-<v>.tgz`. The updater hardcodes the other name. | `.github/workflows/`, `kxm-update.ts:174` |
| Fixture ids renamed | Workflow fixtures are renamed. `.kxm/config/agents.json` still says `pi-extensions-v04`. | `.kxm/config/agents.json:3` |
| Cross-cutting test gates apply to every phase | Coverage thresholds cover 13 legacy files (9,774 of 23,275 lines). All eleven `vnext-*.ts` files (8,437 lines) are exempt. Deleting a vNext test file would not fail CI. | `package.json` `test:coverage` |
| Landed list | The uncommitted `kxm-update-config.ts` split is load-bearing (keeps `yaml` out of the Pi extension import graph) and is not recorded. | `git status` |

Everything else checked out: hub CLI, dash tabs, harness catalog and updater,
`kxm routing report`, migrate and trust commands, SSH fail-closed, fixture ids,
version consistency across seven surfaces.

## 3. Ordering, MVP, and dependencies

### P1. Name the MVP

No phase gate is labelled MVP. "Hub local is MVP" and "public npm first" are
decisions without a gate. Proposed Decided line:

> **MVP is the Phase 4 gate plus the first public npm release (0.6.0).**
> Anything marked *required* in this section that is not in Phase 4 or earlier
> carries its phase tag. Hub local means the current v0.5 hub process on
> loopback, read by session brief and `kxm dash`; the vNext hub (Phase 8)
> replaces its store, not its role.

### P2. Put Phase 3 first, literally

"Next PR" in Still open is a rename cleanup. Replace it with Phase 3a. Rename
leftovers ride in the truth slice (section 11), which is one day of work and
should land before or beside 3a, never instead of it.

### P3. Split Phase 3

The gate requires `fix.yaml`: thirteen steps, approval, a two-producer join,
plan hash, repro oracle. The plan itself says dual-critic `/fix` is Phase 7
and that `fix.yaml` need not run live in Phase 4. Proposed:

- **Phase 3a (MVP path).** Compile `default.yaml`: agent and gate steps, typed
  transitions, `$terminal`, `step.maxAttempts`, per-edge `maxTransitions`,
  global `limits`, run states `created → preparing → running → completed |
  failed`, cancel, crash recovery mid-step, driver-simulated producers,
  caller-authored replies rejected. Gate: the model-free driver completes and
  recovers `default.yaml`.
- **Phase 3b (before Phase 7).** Approval and wait steps, `moa` two-producer
  join, evidence reuse rules, `planHash` and `reproOracle`, `blocked_uncertain`
  from uncertain effects. Gate: the driver completes and recovers `fix.yaml`.

Phase 4 depends on 3a only.

### P4. Routing decisions that need non-Pi dispatch are unenforceable until Phase 11

Provider-native harness preference, quota failover, and "never fall over onto
Pi's other-provider key" all presuppose dispatch to Claude, Codex, or Kimi.
Dispatch is Phase 11, after SSH, MOA, hub vNext, context, and web. Meanwhile
the team runs `claude -p` and `codex exec` by hand for three of four roles,
producing no routing record at all.

Proposed: a **Phase 4b one-shot adapter** slice. Spawn `claude -p` or
`codex exec`, capture stdout as an artifact, record harness, model, tokens if
reported, latency, and cost or `unknown`. No RPC, no supervision, no
isolation; those stay in Phase 11. This is the smallest thing that makes the
insight loop real. If that is rejected, tag the three routing rules "Phase 11"
in Decided and stop restating them as current requirements.

Also required for the predicate to be satisfiable: an auth probe for every
catalog harness, or an explicit `authenticated: unknown` that is treated as
not eligible.

### P5. "Public release" is defined twice

Tracking says GitHub tarballs until public npm. The Phase 5 gate says "the
public local release runs a dirty two-repository workflow". Proposed: public
npm 0.6.0 ships at the Phase 4 gate. Retitle Phase 5 "multi-repository
release" and drop "public" from its gate.

### P6. Tracking is becoming the diary that plan hygiene forbids

Seventeen of the last twenty-two commits touch the plan or `AGENTS.md`. The
routing, cost, insights, catalog, failover, rollover, and coded-steps text is
restated three times (AGENTS.md, Decided, Still open) and is drifting.
`kxm mesh` and `MeshClient` each appear twice in Still open. "Rebuild dist" is
a chore, not a plan item.

Proposed: move the routing and cost text into one normative
`docs/vnext/routing.md` with phase tags. Leave one bullet each in Decided
pointing there. Delete the duplicates. AGENTS.md keeps the short operator
rules. Fold plan edits into the code commit that justified them, as the rule
already says.

### P7. Phase 6 before Phase 7 and 8 has no stated dependency

The only later consumer of SSH and exe.dev is Phase 11 remote Runtimes. Live
`/fix` (7) and hub vNext (8) deliver more to a single operator. Proposed: mark
Phase 6 and Phase 3b as off the critical path, and state the critical path as
3a → 4 → 5 → 7 → 8.

### P8. Phase 1 prose

The Phase 1 implemented-slices paragraph is a 300-word changelog. Collapse to
three lines and link PR #73 and the CHANGELOG.

### P9. Reserve the sub-workflow step kind

See section 10. Add `workflow` to the step-kind enum now with validation that
rejects it as not yet supported, so nobody designs around its absence.

### P10. Dogfooding is blocked and that is correct

This repo has no `.kxm/**/*.yaml`. It cannot run its own vNext workflow until
Phase 3a. Make the first live workflow this repo's own verify gate, and say so
in Phase 4.

## 4. Implementation workflow and gates

| # | Finding | Severity | Fix |
|---|---|---|---|
| W1 | Coverage enforces 42% of source. All `vnext-*.ts`, `routing.ts`, `arbiter.ts`, `skills.ts`, `state.ts`, `context.ts`, `mcp-server.ts`, `tui.ts`, and `session*.ts` are exempt. | major | Invert to `--test-coverage-include=plugins/kxm/src/**.ts` plus an explicit exclude list, so a new file is enforced by default. |
| W2 | `npm run verify` never runs `check:generated`. A stale `dist` passes the commit gate. Three of the last thirty dist commits are pure rebuilds. | major | Add `check:generated` to `verify`. Both already build, so the cost is one build. |
| W3 | `check:generated` runs on one CI leg (Linux, Node 24). The team works on Windows. | major | Run on all four legs, or write down why Linux/Node 24 is canonical. |
| W4 | Plan hygiene is inverted: 17 of 22 recent commits touch the plan. | major | Fold plan edits into the justifying code commit. Add a PR-template line: "which code change aged the plan". |
| W5 | The PR loop (auto-merge, background CI watch) is prose only. No CODEOWNERS, no script. `smoke.yml` is gated on a variable and has likely never run. | major | Add CODEOWNERS naming the two reviewers plus a short `gh pr merge --auto` wrapper, or delete the auto-merge sentence. |
| W6 | Loop rules without a test: harness/model pair rejection, quota failover next-best selection and fail-closed on empty, verify-before-pass tied to this repo's gate. | major | Three failing tests, one per rule. |
| W7 | Markdown lint checks no cross-file links and skips `examples/**`. | minor | Offline link checker in `check`; widen globs. |
| W8 | `provenance-quorum.json` is beside three shipped fixtures but not in `files`. | minor | Add it or delete it. |
| W9 | `kxm-hub` and `kxm-worker` are public bins with no `--help`, duplicating `kxm hub start` and `kxm agent worker`. | minor | Drop from `bin`; keep as internal scripts. |

Keep: two gates and a PR template that mirrors them; the four-leg matrix with
Windows; `check:versions` over seven surfaces; 18k test lines; more than
twenty tests named for fail-closed; the strong-form dist checker.

## 5. Hub setup and configuration

| # | Finding | Severity | Fix |
|---|---|---|---|
| H1 | `kxm init --hub existing\|new` writes nothing and starts nothing. | blocker | `--hub existing <url>` persists the URL into Runtime-local bindings and probes `/health`. Brake `--hub new` with "run `kxm hub start`" until the hub can detach. |
| H2 | Two config worlds, one documented. `kxm init` writes `project.yaml`, `repo/repo.yaml`, two agents, `workflows/default.yaml`, provenance. Zero mentions outside `docs/vnext`. Getting-started teaches `kxm mesh init`, which writes the unrelated legacy tree. | blocker | Getting-started uses `kxm init`. Add a "what init writes" table to `docs/configuration.md`. |
| H3 | Second `kxm hub start` dies with a raw Node stack trace saying "pi-mesh hub is already managed". | major | Catch at the call site; one-line KXM message pointing at `kxm hub stop`; exit 1. |
| H4 | `kxm hub start` is foreground and nothing says so. | major | One sentence in getting-started. |
| H5 | `kxm hub start` awaits the update check (up to 2.5 s) and exits 2 without starting the hub if `.kxm/update.yaml` is malformed. | major | Cache plus background refresh on this path; malformed config is a warning here. |
| H6 | A fresh loopback hub has no auth and never says so. | major | Print `auth=none` or `auth=token` on the startup line; stderr warning when unset. |
| H7 | Docs name the MCP server `pi-mesh`; the key is `kxm`. | major | Rename in troubleshooting and handbook. |
| H8 | Dash key table wrong in two docs (four panels listed; six exist). | major | Copy the in-app help string from `tui.ts:476`. |
| H9 | Operator command tables list 6 groups; the CLI registers 21. The "Complete CLI guide" has no `kxm init`. | major | Generate the table from `createProgram` in a test so it cannot drift. |
| H10 | `env.example` lacks `KXM_STATE_HOME`, `KXM_WORKFLOW_SECRET`, `KXM_WORKFLOW_SIGNAL_SECRET`, `KXM_SESSION_ID`, `KXM_UPDATE_CACHE`. | minor | Add as commented lines. |
| H11 | `KXM_SESSION_BRIEF` filed under hub settings; only the extension reads it. | minor | Move the row. |
| H12 | Operations doc says schema v2 and v3; README and operations say 0.4.x. | minor | Correct; extend `check-versions` to doc strings. |
| H13 | `.kxm/update.yaml` exists only in one table cell. | minor | Short section in operations plus a shipped `update.example.yaml`. |

Keep: SSH truly fail-closed; `O_EXCL` pid claim; `kxm hub stop` validates
version, role, generation, and liveness; Windows `taskkill` fallback;
non-loopback without token refused; redaction on all CLI output.

## 6. Installation and update

| # | Finding | Severity | Fix |
|---|---|---|---|
| I1 | The only documented install path downloads a release asset nothing produces, under a name `npm pack` does not emit. | blocker | Tag-triggered release job: pack, rename to `kxm-<version>.tgz`, upload. A test asserts the asset name the updater expects. |
| I2 | README first verification step is `/mesh-status`. | blocker | `/kxm hub`. |
| I3 | Twelve first-run steps across two terminals; `kxm init` and `kxm session brief` appear in none of them. | blocker | Rewrite first-run: install, `kxm init`, `kxm hub start` (foreground note), `kxm session brief`, `pi` then `/kxm hub`. Target six steps. |
| I4 | `kxm update --kxm` installs with no digest check and always targets the npm global prefix even when the running copy is a Pi git install or a Claude marketplace plugin. | major | Verify the asset digest against the release. Detect install kind; fail closed with the right command otherwise. |
| I5 | `.kxm/update.yaml` `auto: true` is read from the working directory, so an untrusted clone plus `kxm update codex` triggers a global install. | major | Read `auto` from user state, or require `--kxm` to honor it. |
| I6 | The `kxm` skill teaches `pi-mesh` and `mesh_*` tools that do not exist. Both Pi and Claude load it. | major | Rename to `kxm_*` throughout. |
| I7 | Getting-started labels the Claude prompt "Mesh server URL"; the manifest says "KXM server URL". | minor | Match the manifest. |
| I8 | Install docs are PowerShell-only in README and getting-started. | minor | Add the bash form. |

Keep: the `kxm-update-config.ts` split (commit it); names clean on every
install surface; pack includes dist, skills, plugin manifests; the `engines`
pin that makes `node:sqlite` safe.

## 7. CLI surface

| # | Finding | Severity | Fix |
|---|---|---|---|
| C1 | `kxm mesh init\|smoke` alive; no brake mechanism exists. Both `mesh init` and `init` emit `command: "init"`. | blocker | Delete the group. Add one `brakedCommand(old, pointer)` helper: stderr pointer, exit 2. Test asserts exit 2. Apply to `mesh` and to the `/mesh-status` slash. |
| C2 | The primary path dead-ends. `kxm run` writes the vNext runtime store; `kxm dash` reads the legacy hub database. A new run appears on no screen. | major | Dash reads the vNext registry (Phase 4 gate requires it), or says so and points to `kxm runs list`. |
| C3 | `kxm run` prints "run created" with no Phase 3 caveat. | major | Append the caveat; add a `phase` field to the JSON payload. |
| C4 | `ok:false` payloads go to stdout. | major | Route errors through stderr inside `print`. |
| C5 | No `--version`; no `schema` tag on JSON output. | major | `.version()` from package.json; constant schema field in `print`. |
| C6 | Help lists nineteen groups in registration order, vNext and legacy interleaved. `run`, `runs`, and `workflow start` are three confusable worlds. | major | Two help sections, "Project" and "Legacy hub", with a legacy prefix on descriptions. |
| C7 | `hostMode()` returns `"mesh"` into telemetry and manifests; `--project` is "Mesh project"; both bin scripts print "pi-mesh hub". | major | Rename the host value; replace the strings. |
| C8 | `kxm runs status` reports itself as "run status" and tells the user to type a command that does not exist. | minor | Fix labels and messages. |
| C9 | `--workspace` is ignored by `init`, rejected by `run`, honored elsewhere. | minor | Reject on `init`; document as legacy-only. |
| C10 | `kxm dash --json` is a usage error while `--dry-run` works. | minor | State it in help. |
| C11 | `gate github watch` is three levels deep with nine flags. | minor | Hide; it is CI-invoked. |

Target command tree for 0.6:

- Keep: `--version` (add), `init`, `run` (with phase notice), `runs` (fixed
  labels), `dash` (reads vNext), `runtime`, `trust`, `harness`, `update`,
  `migrate`, `routing report`.
- Prefix "[legacy hub]": `hub`, `session`, `agent worker`.
- Hide until Phase 3: `workflow *`, `gate validate|artifacts-exist|degrade|signal`.
- Hide until Phase 5: `context get..explain`, `skills *`.
- Hide: `gate github watch`, `context wiki-*`, `improve`.
- Brake: `mesh *`, `/mesh-status`.
- Bins: keep `kxm`; drop `kxm-hub` and `kxm-worker` from `bin`.

Keep: the uniform global-option helper; usage errors mapped to exit 2;
`exitOverride` with injectable IO; redaction at the boundary;
`kxm run --dry-run` ending with "(no run created)".

## 8. Packaging: one package with enforced seams

Do not split into published packages before public 0.6. Phase 3 and 4 churn
the contracts a split would have to version across packages, there is no
external consumer, and `check:versions` already covers seven surfaces in one
repo. The only cost a split would remove today is the `*` peer dependency on
the Pi coding agent pulled by a CLI-only global install, and
`peerDependenciesMeta: optional` removes that for one line.

"Harness support" means two different things that must never share a package:

- **Dispatching to a harness** (Pi RPC, `claude -p`, `codex exec`) is engine
  code. It touches fail-closed auth and routing records. It lives with the
  Runtime.
- **Being installed into a harness** (Pi extension, Claude plugin, later a
  Gemini extension) is an edge surface with its own peer dependency. These are
  the future split candidates.

Internal layering, enforced by an import-boundary test rather than by memory:

| Layer | Contents | May import |
|---|---|---|
| core | schemas, YAML parse and validate, protocol, envelope, redaction, routing record types | node only |
| runtime | event store, supervisor, Phase 3 engine, harness catalog and dispatch adapters | core |
| hub | current hub, store, arbiter, wiki, later Phase 8 | core |
| cli | commander, dash TUI | core, runtime, hub |
| surfaces | Pi extension, Claude plugin and MCP bundle, later Gemini or Codex | core, client |

One violation exists now: the Pi extension imports the legacy workflow engine
module directly instead of going through the client. Add `exports` subpaths
(`.`, `./runtime`, `./client`, `./extension`, `./mcp`) so the seams are public
without a second package. Split when a second consumer exists: a non-Pi surface
that must not carry Pi peers, or someone embedding the Runtime without the CLI.
The Claude marketplace installs from a git path, not npm, so it never cares
about package boundaries.

## 9. Cross-harness packages and what to support

Verified against official docs on 2026-09-04:

| Harness | Instructions | Skills discovery | Package manifest | MCP config | Hooks |
|---|---|---|---|---|---|
| Claude Code | `CLAUDE.md` only (import `@AGENTS.md`) | `.claude/skills`, plugin `skills/` | `plugin.json` + `marketplace.json` | plugin `.mcp.json` | yes |
| Codex CLI | `AGENTS.md` | `.agents/skills`, `~/.agents/skills` | none | `~/.codex/config.toml` | no |
| Gemini CLI | `GEMINI.md` | `skills/` inside extension | `gemini-extension.json` | manifest `mcpServers` | `hooks/hooks.json` |
| Kimi CLI | not documented | `.agents/skills`, `~/.config/agents/skills` | unverified | `kimi mcp add` | unverified |
| Copilot CLI | `AGENTS.md` | `.agents/skills`, `.github/skills` | `*.agent.md` | `~/.copilot/mcp-config.json` | no |
| OpenCode | `AGENTS.md` | `.agents/skills`, `.opencode/skills` | npm plugins | config `mcp` block | via plugins |

The Agent Skills standard (agentskills.io, released 2025-12-18) is implemented
by forty-plus products. `.agents/skills` for repos and `~/.config/agents/skills`
for users is the shared discovery path. Claude Code is the holdout that reads
only its own paths.

What KXM already has that ports with near-zero change: the two skills (standard
`name` plus `description` frontmatter), the stdio MCP server with nineteen
`kxm_*` tools, `AGENTS.md`, and the harness catalog as the natural home for
install steps. What does not port: the Claude `userConfig` block (URL, token,
agent, purpose, project). Token delivery is per-harness, never portable, and
the design does not yet say how the token reaches a Codex or Copilot config.

Recommended layering:

1. **Portable core.** The authored skill tree, the stdio MCP server plus a
   generated MCP registry `server.json`, and a marker-delimited `AGENTS.md`
   block that regenerates idempotently.
2. **One source of truth**, a committed `.kxm/harness.yaml` (name, version,
   MCP launch command, env keys, skill list), generating: Claude `plugin.json`
   and `marketplace.json`, a Gemini extension directory, a Codex TOML snippet,
   the `.agents/skills` tree, and the `pi` fields in `package.json`. The
   existing generated-file check gives drift detection for free. Copying skills
   into two authored locations is a dual-surface alias and will drift.
3. **Harness-native, not portable.** Pi status line and `/kxm` picker; Claude
   hooks and `userConfig`; Gemini hooks. Codex has no hooks, so any behavior
   that depends on a Claude hook today must become a workflow gate before Codex
   support means anything.

`kxm harness install <id>`: pi does nothing beyond npm; claude adds the
marketplace and installs; codex writes the MCP block, materializes
`.agents/skills`, appends the AGENTS.md block; gemini links the generated
extension directory; kimi runs `kimi mcp add`; copilot writes its MCP config.

Roadmap, in order:

1. Emit the portable `.agents/skills` tree. One generator unlocks Codex, Kimi,
   Copilot, OpenCode, and Amp at once.
2. Codex: MCP TOML block plus AGENTS.md block. Codex is already a designated
   reviewer, so this serves work done today. Say plainly there is no Codex
   plugin mechanism.
3. MCP registry manifest. Blocked on public npm; schedule it there.
4. Gemini extension, emitted by the generator, never hand-maintained.
5. Copilot and OpenCode: a small MCP-config writer each.
6. Cursor, Amp, Crush: no bespoke work; confirm against official docs before
   claiming support.

Rule flags: installing a manifest is not authorizing a run, so the installer
may write files for a detected-but-logged-out harness, but that harness must
not become a routing target until the auth probe returns true, never on the
`null` it returns today when unprobed. Per-harness enablement stays in
committed KXM YAML; home-directory Claude, Codex, or Copilot configs are MCP
install targets only. Writing enablement into them is the preferences overlay
the rules forbid.

## 10. Multi-repository sub-workflows (design note for Phase 5b)

The project schema binds member repositories by logical id, every step
declares per-repository access, and repository resources have their own path
scope under `.kxm/repo/`. What is missing is a step that delegates.

- **Definition lives in the member repo** at `.kxm/repo/workflows/<id>.yaml`,
  reviewed in that repo's pull requests. Identity is `<repositoryId>/<id>`.
- **Parent step `kind: workflow`** names a repository and a workflow id,
  declares the access it grants, and maps the child's terminal status onto its
  own outcome keys. `on: passed | failed` is unchanged.
- **The child is a real run**, not inline expansion: own run id, same home
  Runtime, own pinned revisions and event log. The parent waits until the
  child reaches a terminal state. Inlining would break crash recovery,
  cancellation, and evidence attribution.
- **Ceilings only narrow.** The parent step's repository, tool, secret, time,
  and cost limits are the child's hard ceiling. The permission-diff lattice
  already classifies the comparison. A member repo of lower classification
  cannot add tools or secrets through its own workflow file; `kxm trust diff`
  must include member workflow files; unreviewed member workflows fail closed.
- **Pinning is free.** Runs already pin member base commits and dirty snapshot
  hashes, so the child definition is pinned by construction.
- **Bounds.** Depth two, no cycles, child transitions count against the
  parent's global limits, one active child per step. Fan-out across every
  repo that defines a given sub-workflow is a Phase 7 bounded-parallel feature.

Avoid: one KXM project per repo composed through run requests (needs Phase 8
cross-project leases), and control-root-only sub-workflows (defeats repos
owning their own). Depends on Phase 5. Reserve the step kind now (P9).

## 11. Refinement cycle: ordered slices

Each finding above maps to exactly one slice. Slices A, B, and C are small and
land before Phase 3a starts; A and C can be one PR because the plan edit is
justified by the code change in the same commit.

### Slice A: truth before npm (one PR, about a day)

- First-run docs rewritten around `kxm init`, `kxm hub start` (foreground
  note), `kxm session brief`, `/kxm hub`. Remove `kxm mesh init` and
  `/mesh-status` from README, getting-started, handbook. Bash and PowerShell
  forms. (I2, I3, I8, H2, H4)
- `brakedCommand` helper; `kxm mesh` and `/mesh-status` braked; test asserts
  exit 2. (C1, accuracy row 1)
- `hostMode` value, `--project` description, bin script messages, admin
  caller id, wire header names renamed. Metric names renamed with a
  CHANGELOG note. (C7, accuracy row 2)
- `kxm` skill rewritten to `kxm_*`. (I6)
- `kxm --version`; schema field on JSON; `ok:false` to stderr; `runs` labels;
  `run` Phase 3 caveat plus `phase` field. (C3, C4, C5, C8)
- `kxm init --hub existing` made real; `--hub new` braked. Probe wired. (H1)
- `kxm hub start`: cached update notice, background refresh, bad config warns,
  `auth=` on the startup line, friendly second-start error. (H3, H5, H6)
- `update.yaml` `auto` read from user state. (I5)
- Doc fixes: MCP server name, dash keys, env.example, `KXM_SESSION_BRIEF`
  row, schema and version strings, update.yaml section, Claude prompt label.
  (H7, H8, H10 to H13, I7)
- Commit the `kxm-update-config.ts` split. Close the GitHub identity item.
  Fix `agents.json` project id. (accuracy rows 8, 10, 11)

### Slice B: gates (one PR)

- Coverage include inverted to all source plus an exclude list. (W1)
- `check:generated` in `verify`; all CI legs. (W2, W3)
- Three failing tests: harness/model pair rejection, quota failover next-best
  and fail-closed on empty, verify-before-pass on this repo's gate. (W6)
- Import-boundary test for the five layers; fix the extension import. (section 8)
- `peerDependenciesMeta` optional for the Pi peers; `exports` subpaths.
- Release workflow: tag, pack, rename, upload; asset-name test. Digest check
  and install-kind detection in `kxm update --kxm`. (I1, I4)
- Command table generated from `createProgram` in a test. (H9)
- CODEOWNERS and the `gh pr merge --auto` wrapper, or delete the sentence.
  PR-template line for plan aging. (W4, W5)
- Drop `kxm-hub` and `kxm-worker` from `bin`; add `provenance-quorum.json`
  to `files` or delete it. (W8, W9)

### Slice C: plan patch (rides with A)

Verbatim edits in section 12. (P1 to P9, P10 wording, accuracy rows 3 to 7)

### Slice D: Phase 3a engine

The next feature PR after A, B, and C. Nothing else in front of it.

### Slice E: Phase 4 completions, then 0.6.0

Pi RPC dispatch; `kxm dash` reads the vNext registry; routing records require
`harness`, `provider`, and latency; auth probes for every catalog harness;
help sections and hides from section 7; the first live workflow is this repo's
own verify gate. Public npm 0.6.0 at the gate.

### Slice F: after 0.6.0

Phase 4b one-shot adapters; `.agents/skills` generator and Codex install; MCP
registry manifest; then Phase 5 and the Phase 5b sub-workflow step; Phase 3b
before Phase 7.

## 12. Proposed plan edits (verbatim)

Apply to `docs/vnext/implementation-plan.md`. Grok applies; tests verify.

**Decided, add after "Hub local is MVP":**

> - **MVP is the Phase 4 gate plus the first public npm release (0.6.0).**
>   Anything marked *required* in this section that is not in Phase 4 or
>   earlier carries its phase tag. Hub local means the current v0.5 hub
>   process on loopback, read by session brief and `kxm dash`; the vNext hub
>   (Phase 8) replaces its store, not its role.
> - **Critical path:** 3a → 4 → 0.6.0 → 5 → 7 → 8. Phase 3b and Phase 6 are
>   off the critical path and may land whenever a writer is free.
> - **Routing and cost contract** lives in [`routing.md`](routing.md) with
>   phase tags. Routing records gain required `harness`, `provider`, and
>   latency fields in Phase 4. Native-harness preference and quota failover
>   become enforceable with the Phase 4b one-shot adapters.

**Decided, replace the "Fix leftovers with brakes" sentence's tail with:**

> A brake is a registered command or slash that prints a pointer to the new
> name on stderr and exits 2, with a test that asserts it. Silent deletion is
> not a brake.

**Landed, add:**

> - `kxm-update-config.ts` split so the Pi extension import graph carries no
>   `yaml` dependency.

**Still open, replace the "Next PR" bullet with:**

> - **Next PR:** Slice A of the 2026-09-04 review (first-run docs, brakes,
>   honest `kxm run` and `kxm init --hub`, hub start hygiene). Then Slice B
>   (coverage, dist, three failing tests, release workflow). Then Phase 3a.

**Still open, delete:** the second `kxm mesh` bullet, the second internal type
names bullet, the "Rebuild generated dist" bullet, and "Confirm GitHub
repository identity".

**Still open, add:**

> - **Sub-workflow step kind (Phase 5b, design decided):** `kind: workflow`
>   delegating to a member-repository workflow at
>   `.kxm/repo/workflows/<id>.yaml` as a child run whose ceilings can only
>   narrow. Reserved in the schema now; validation rejects it until Phase 5b.
> - **Portable packages (after 0.6.0):** emit `.agents/skills`, a Codex MCP
>   and AGENTS.md block, an MCP registry manifest, then a generated Gemini
>   extension, all from one `.kxm/harness.yaml`. Enablement stays in Git YAML.

**Phase 3, replace with:**

> ## Phase 3a: ordered workflow engine (MVP path)
>
> Compile `default.yaml`: agent and gate steps, typed bounded transitions,
> `$terminal`, `step.maxAttempts`, per-edge and global budgets, run states
> through `completed` and `failed`, cancellation, crash recovery mid-step.
>
> **Gate:** a model-free test driver completes and recovers
> `examples/vnext/.kxm/workflows/default.yaml` without illegal transitions or
> evidence reuse. Producers are driver-simulated. Caller-authored replies are
> rejected. Pi/CLI executions do not satisfy this gate.
>
> ## Phase 3b: approvals, joins, and uncertain effects (before Phase 7)
>
> Approval and wait steps, `moa` two-producer join, evidence reuse rules,
> `planHash` and `reproOracle`, `blocked_uncertain` handling.
>
> **Gate:** the same driver completes and recovers `fix.yaml`. Out of gate:
> live models, provider-distinctness, all-settled degradation.

**Phase 4, add to "Still this phase":**

> `kxm dash` reads the vNext Runtime registry so a created run is visible.
> Routing records require `harness`, `provider`, and latency. Every catalog
> harness has an auth probe or reports `unknown`, which is not eligible.
> The first live workflow is this repository's own verify gate.

**Phase 4b (new, after Phase 4):**

> ## Phase 4b: one-shot CLI adapters
>
> Spawn `claude -p` and `codex exec` for a single assignment, capture stdout
> as an artifact, and record harness, model, tokens if reported, latency, and
> cost or `unknown`. No RPC, no supervision, no isolation. Native-harness
> preference and quota failover become testable here.
>
> **Gate:** an assignment routed to an authenticated native harness produces
> a routing record with every required field; a logged-out harness fails
> closed at assignment.

**Phase 5, retitle and edit the gate:**

> ## Phase 5: multi-repository release
>
> **Gate:** the release runs a dirty two-repository workflow through a
> Runtime crash without a hub or secret leakage. Includes the `workflow`
> step kind delegating to a member-repository sub-workflow as a child run.

**Cross-cutting test gates, add:**

> - every source file is inside the coverage include unless explicitly
>   excluded with a reason;
> - an import-boundary test holds the core / runtime / hub / cli / surfaces
>   layering.

**Plan hygiene, add:**

> A plan edit ships in the commit of the code or docs change that justified
> it. A plan-only commit needs a retrospective or a gate result as its reason.
