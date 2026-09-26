# Develop KXM

Set up a source checkout, learn where each part of KXM lives, and run the same
gate CI runs before you push. This page is for contributors who change the CLI,
the [hub](../glossary.md#hub), the [Runtime](../glossary.md#runtime), the Pi
extension, the Claude Code plugin, or the bundled skills.

## Before you begin

- Node.js 22.19 or newer on the 22 line, or Node.js 24 or newer. The
  `engines` field in `package.json` is the authority.
- npm and Git.
- Optional tools, needed only for the matching task:
  - [Pi](https://pi.dev) to load the extension from source.
  - The Claude Code CLI to validate the plugin manifests locally.
  - [`just`](https://github.com/casey/just) for the remaining
    [assignment runner](assignment-runner.md) recipes only:
    `assign`, `witness`, `accept`, `observe-cost`, `attribute`,
    `change-report`, and `plan-current`. Those recipes are harness
    transport for the issue 127 runner. They are not how a unit is
    dispatched. Do not rename or delete them.
  - `kxm lane run` to dispatch a unit. A writer unit uses
    `kxm lane run <unit> --brief <file> --workflow implement-only`.
    The read-only critic workflows on the same command are
    `review-arch-only` and `review-cli-only`.
  - Docker for the clean-container install smoke.

## Set up a checkout

```bash
git clone https://github.com/kontextmind/kxm.git
cd kxm
npm ci
node scripts/kxm.mjs --help
```

`node scripts/kxm.mjs` is the `kxm` binary from `package.json` `bin`. It runs the
committed bundle `plugins/kxm/dist/cli.js`, not the TypeScript source. A source
change is invisible until you rebuild:

```bash
npm run build
```

Use `node scripts/kxm.mjs` wherever the user docs show `kxm`.

### Keep experiments away from real state

A source build uses the same default hub (`http://127.0.0.1:7331`), user state
root, configuration and telemetry directories as an installed `kxm`. Point every
experiment at throwaway directories and a hub you start yourself on another
port:

```bash
# Run in a scratch Git repository, not in your KXM checkout.
export KXM_STATE_HOME="$(mktemp -d)"
export KXM_USER_CONFIG_DIR="$(mktemp -d)"
export KXM_USER_TELEMETRY_DIR="$(mktemp -d)"
export KXM_PORT=47331
export KXM_SERVER_URL="http://127.0.0.1:$KXM_PORT"
node /path/to/kxm/scripts/kxm.mjs hub start
```

In a second terminal with the same variables:

```bash
node /path/to/kxm/scripts/kxm.mjs hub view
node /path/to/kxm/scripts/kxm.mjs hub stop
```

Expected output of `hub view`:

```text
hub health=true ready=true · loopback hub
```

`KXM_STATE_HOME` must be an absolute path. The hub writes its database and logs
under `.kxm/` in the directory where you start it.

### Load the Pi extension from source

Pi loads the TypeScript extension directly, so it needs no build step:

```bash
pi --no-extensions -e ./plugins/kxm/src/extension.ts
```

`--no-extensions` turns off Pi's package discovery, so only the listed extensions
load. Add another `-e` for each provider extension your models need.

### Validate the Claude Code plugin

With the Claude Code CLI installed, run the same strict manifest validation as
CI. Validation reads the manifests only; the plugin itself runs the committed
`plugins/kxm/dist/mcp-server.js`, so rebuild before you try it in Claude Code.

```bash
npm run validate:claude
```

## Repository layout

The tree below lists what is tracked in Git. Directories marked "not shipped" are
excluded from the npm package.

```text
.
├── plugins/kxm/            The product: CLI, hub, Runtime, Pi extension, MCP server
│   ├── src/                TypeScript source (cli/, context/, providers/ inside)
│   ├── dist/               Generated, committed bundles (see Generated artifacts)
│   ├── skills/             Bundled Agent Skills, one <name>/SKILL.md each
│   ├── skill-suite.json    Skill manifest: names, paths, owned commands
│   ├── .claude-plugin/     Claude Code plugin manifest (plugin.json)
│   └── .mcp.json           MCP server launch for the plugin
├── .claude-plugin/         Claude marketplace catalog (marketplace.json)
├── packages/core/tui/      @kontextmind/tui workspace package
├── scripts/                kxm.mjs, hub and worker wrappers, build, release, runners
├── schemas/                JSON Schemas for YAML resources, events and records
├── docs/                   User, operator and contributor documentation
├── examples/               Runnable transport examples and project fixtures
├── test/                   core/, simulations/, fixtures/, helpers/ (not shipped)
├── .kxm/                   This repository's own KXM project definition
├── .agents/skills/         Generated mirror of the bundled skills (not shipped)
├── .github/                CI, release, issue and PR templates (not shipped)
├── .claude/                Developer harness notes and commands (not shipped)
├── plans/                  Internal planning and tracking (not shipped)
├── justfile                Remaining issue 127 recipes (assign, witness, accept, observe-cost, attribute, change-report, plan-current)
└── AGENTS.md, CLAUDE.md, GEMINI.md   Agent instructions with generated blocks
```

The workspace layout for `packages/` is described in
[Packages and workspaces](packages.md). The `.kxm/` layout is described in
[`.kxm/README.md`](../../.kxm/README.md).

## Packaging standards

KXM ships one product through four native package formats. Each format reads
its own manifest, and `npm run check:versions` keeps every version field equal.

### npm package

`@kontextmind/kxm` is published publicly.

| Field | What it declares |
|---|---|
| `bin` | `kxm` → `scripts/kxm.mjs` |
| `exports` | `./core`, `./runtime`, `./client`, `./extension`, `./mcp` from `plugins/kxm/dist`, and `./tui` |
| `files` | `plugins/kxm/{dist,src,skills}`, `scripts`, `docs`, `examples`, `schemas`, the plugin manifests, and selected `.kxm` files |
| `engines` | Node `^22.19.0 \|\| >=24.0.0` |
| `peerDependencies` | Pi and `typebox`, both optional |

Everything under `docs/` ships in the tarball, so a link from `docs/` into
`plans/` is dead for npm readers. `.npmignore` drops logs, state and generated
assets even inside listed directories. Inspect the result with
`npm pack --dry-run`.

### Claude Code plugin and marketplace

| File | Role |
|---|---|
| `.claude-plugin/marketplace.json` | Marketplace catalog; its `kxm` entry points at `./plugins/kxm` |
| `plugins/kxm/.claude-plugin/plugin.json` | Plugin manifest: `userConfig`, the `SessionStart` hook, the channel, and `mcpServers` |
| `plugins/kxm/.mcp.json` | Launches `dist/mcp-server.js` over stdio and maps `userConfig` to `KXM_*` variables |
| `plugins/kxm/dist/claude-hook.js` | The bundled, read-only `SessionStart` hook script |

A marketplace install clones the repository, so the plugin can use only committed
files. That is why the bundles in `dist/` are tracked. For what the plugin does,
see the [plugin README](../../plugins/kxm/README.md).

### Pi package

The root `package.json` carries the `pi-package` keyword and a `pi` block:
`pi.extensions` lists `./plugins/kxm/src/extension.ts` and `pi.skills` lists
`./plugins/kxm/skills`. Pi loads the TypeScript source itself.

### Agent Skills

Each bundled skill is a directory `plugins/kxm/skills/<name>/` with a `SKILL.md`.
`plugins/kxm/skill-suite.json` declares every skill and the top-level `kxm`
commands it owns. `test/core/skill-suite.test.ts` enforces the rules:

- The directory name equals the frontmatter `name` and the manifest `name`.
- The frontmatter parses as strict YAML. Quote any value that contains a colon followed by a space.
- The `description` is at most 1,024 characters.
- Every top-level `kxm` command is owned by exactly one skill.
- `.agents/skills/` matches the authored skills byte for byte.

For what each skill covers, see [Agent skills](../guides/agent-skills.md).

## The development loop

1. Branch from `main`. Keep one concern per branch and one clear concern per
   commit.
2. Change the source and the test that proves the change. Update
   [the test matrix](test-matrix.md) when you add a behavior.
3. Rebuild with `npm run build` when you touched anything that is bundled.
4. Run the focused test file while you iterate (see
   [Test conventions](#test-conventions)).
5. Update the user docs and `CHANGELOG.md` (under `## Unreleased`) for any
   user-visible change.
6. Stage the source change together with the regenerated files. The commit gate
   compares generated files with the staged copy.
7. Run the commit gate, `npm run verify`, fix what it reports, then commit.
8. Push and open a pull request. The template asks for the slice issue and the
   `npm run verify` result.

Maintainers who delegate a unit dispatch it with
`kxm lane run <unit> --brief <file> --workflow implement-only`.
Read-only critics use the same command with `review-arch-only` or
`review-cli-only`. The [assignment runner](assignment-runner.md)
recipes (`assign`, `witness`, `accept`, `observe-cost`, `attribute`,
`change-report`, `plan-current`) stay on `just`. They are harness
transport for the issue 127 runner, not the unit transport, and they
cover steps 2 to 7 after a lane run.

## Generated artifacts

`npm run build` regenerates the files below. They are committed because the
Claude marketplace installs from Git and npm consumers install without dev
dependencies. Neither can run a build or strip TypeScript at install time.

| Artifact | Produced by | Consumers |
|---|---|---|
| `plugins/kxm/dist/cli.js`, `server.js`, `runtime-supervisor.js`, `claude-hook.js` | `scripts/build-runtime.mjs` | `kxm`, the hub, the Runtime supervisor, the plugin hook |
| `plugins/kxm/dist/core.js`, `runtime.js`, `client.js`, `extension.js` | `scripts/build-runtime.mjs` | The package `exports` |
| `plugins/kxm/dist/mcp-server.js` | `npm run build:mcp` | The Claude plugin and `@kontextmind/kxm/mcp` |
| `packages/core/tui/dist/index.js` | `npm run build:packages` | `@kontextmind/kxm/tui` |
| `.agents/skills/<name>/…` | `scripts/emit-codex-artifacts.mjs` | Harnesses that read `.agents/skills` |
| `AGENTS.md` block between the `kxm:codex:commands` markers | `scripts/emit-codex-artifacts.mjs` | Codex and other `AGENTS.md` readers |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` blocks between the `kxm:memory` markers | `syncHarnessMemory` (same as `kxm memory sync`) | Every harness, from `.kxm/memory/*.md` |

Never edit a generated file by hand. Edit its source and rebuild.

`npm run check:generated` rebuilds, then fails if any artifact is missing, not
tracked, or different from the staged copy. Stage the rebuilt files
(`git add plugins/kxm/dist packages/core/tui/dist .agents AGENTS.md CLAUDE.md GEMINI.md`)
before you run it.

## The commit gate

Run `npm run verify` before every commit you push. It is the same gate for
people and for agents.

```bash
npm run verify
```

It runs three scripts in order:

| Step | Script | What it checks |
|---|---|---|
| 1 | `npm test` | Build, then `test/core/*.test.ts` and `packages/core/*/tests/unit/*.test.ts`. The script passes `--test-force-exit` so a finished run leaves the process even if a handle is still open; a failing test is still reported before that exit |
| 2 | `npm run check` | `tsc --noEmit`, `markdownlint-cli2`, and version surfaces |
| 3 | `npm run check:generated` | Generated artifacts are tracked and match the staged copy |

Every suite script passes `--test-force-exit`, and `scripts/run-bounded.mjs` stops the run if the suite is still going after its wall-clock limit (20 minutes, or 40 for the complete and coverage suites). The bound is that wall clock per script. A per-test timeout is not used because under `node --test` each file is itself a test, so a per-test timeout also bounds each file.

Other scripts you will use:

| Script | Use it for |
|---|---|
| `npm run test:core` | The core suite only (CI runs a smaller contract set; see [CI and release](ci-and-release.md)) |
| `npm run test:simulations` | `test/simulations/*.test.ts` |
| `npm run test:coverage` | Core suite with coverage floors |
| `npm run test:coverage:complete` | Core plus simulations with the higher nightly floors |
| `npm run lint:docs` | Markdown lint only |
| `npm run validate:pr` | The three-minute CI gate; see [CI and release](ci-and-release.md) |
| `npm run validate:ci` | Coverage suite, `check` and a package dry run (not run by CI today) |
| `npm run validate:claude` | Strict Claude plugin and marketplace validation |

Plugin validation needs the Claude Code CLI, so it is a CI job rather than part
of `verify`. Do not add a third gate script: `test/core/ci-contract.test.ts`
refuses one.

### Coverage floors

| Run | Lines | Branches | Functions |
|---|---:|---:|---:|
| `test:coverage:core` (pushes to `main`, releases) | 91% | 80% | 92% |
| `test:coverage:complete` (nightly) | 93% | 80% | 93% |

Coverage measures `plugins/kxm/src/**/*.ts` and `packages/core/*/src/**/*.ts`.
The floors only move up. A pull request may raise a floor. No pull request may
lower one: when coverage drops, add tests.

Three files are excluded because they run only as spawned bundles, so coverage
would attribute their lines to `dist`, never to the source. Each is exercised
as a child process instead:

- `plugins/kxm/src/server.ts`, the hub entry;
- `plugins/kxm/src/mcp-server.ts`, the MCP stdio entry;
- `plugins/kxm/src/runtime-supervisor.ts`, the Runtime supervisor entry.

An exclusion needs a reason other than "hard to test".

## Test conventions

Tests use the built-in `node:test` runner and run TypeScript through
`--experimental-strip-types`. There is no Jest or Vitest.

### Write one focused test per behavior

- Name each test after the behavior it proves, as a sentence. For example,
  `"MCP server never registers with the persisted admin token"`.
- Assert the observable contract: an exit code, a JSON field, an error code, a
  file on disk. Do not assert log wording unless the wording is the contract.
- Prove the refusal as well as the success. Fail-closed paths need their own test.
- Put the test next to its peers in `test/core/<area>.test.ts`, and add a row to
  [the test matrix](test-matrix.md).

### Run one file or one test

Build once, then run the file directly:

```bash
npm run build
node --disable-warning=ExperimentalWarning --experimental-strip-types \
  --test test/core/improve.test.ts
# Narrow to tests whose names match a pattern.
node --disable-warning=ExperimentalWarning --experimental-strip-types \
  --test --test-name-pattern="same-ask" test/core/improve.test.ts
```

Several suites spawn the built bundles, so a stale `dist` fails them. Rebuild
before you trust a failure.

### Isolate all state

A test must never read or write the operator's hub, state root, configuration or
credentials. Use the shared helpers:

| Helper | What it isolates |
|---|---|
| `isolateSessionEnvironment()` in `test/helpers/session-env.ts` | Points `KXM_STATE_HOME` and `KXM_USER_CONFIG_DIR` at a temp directory and clears session tokens |
| `createTestMesh(context)` in `test/helpers.ts` | Starts an in-memory hub on port `0` with a test token, closed when the test ends |
| `committedKxmProject(prefix, …)` in `test/helpers/project.ts` | Creates a committed KXM project and a separate state root in temp directories |
| `test/helpers/harness-fake.ts` | Fake spawns and auth fixtures for `scripts/harness-run.mjs`, so no real harness or login is needed |

Other rules:

- Create files only under `mkdtempSync(join(tmpdir(), …))` and remove them when
  the test ends.
- Bind servers to port `0`. Never assume `7331` is free.
- Make no network calls outside loopback, and never call a paid model. Real-model
  checks are opt-in smoke tests (see [CI and release](ci-and-release.md#smoke-tests)).
- Tests must pass on Node 22.19 and Node 24.

## Change the protocol

Routes, request fields, status transitions, delivery modes, limits and
authentication are the protocol. A change to any of them needs:

- integration tests;
- an update to `plugins/kxm/skills/kxm/references/protocol.md`;
- an update to the matching page in `docs/`;
- a `CHANGELOG.md` entry;
- a compatibility note when existing clients could break.

Prefer additive changes. KXM does not keep backward-compatible aliases for
retired names: an old name fails closed instead.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `generated artifacts changed after build` | `dist`, a skill mirror or a generated block differs from the index | Run `npm run build`, stage the listed files, rerun |
| `generated artifacts are not tracked by git` | A new bundle or skill file was never added | `git add` the listed paths |
| `… version … does not match …` from `check:versions` | A version surface was edited by hand | Revert it; releases stamp versions (see [CI and release](ci-and-release.md#versions)) |
| A doc test fails after a docs move | A test or code path reads that doc | See [pinned paths](writing-docs.md#pinned-paths) |
| A CLI change has no effect | `node scripts/kxm.mjs` runs the old bundle | `npm run build` |

## Next steps

- Understand what CI runs on your pull request: [CI and release](ci-and-release.md)
- Write or update a docs page: [Write KXM documentation](writing-docs.md)
- Find the test that proves a behavior: [Test matrix](test-matrix.md)
- Add a workspace package: [Packages and workspaces](packages.md)
- Look up a command: [CLI reference](../reference/cli-reference.md)
