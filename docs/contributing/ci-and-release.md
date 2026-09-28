# CI and release

Pull requests run lint, typecheck, and the unit suite on Linux Node 24.
Pushes to `main` also run that suite and the full OS × Node matrix.
The complete suite with coverage floors runs nightly, every merge to `main`
cuts a patch release, and every release is verified before it reaches npm.
This page explains which checks run where, how a merge becomes a published
version, and which smoke tests stay manual. It is for contributors and
maintainers.

## The pipeline at a glance

A merged pull request flows through CI, an automatic tag, a verified GitHub
release and an npm publish; the nightly job adds the slower suites.

```mermaid
flowchart LR
  PR[Pull request] -->|"unit shards, docs lint, plugin validation"| REQ["CI / required"]
  REQ --> MERGE{Merged?}
  MERGE -->|yes| MAIN[main]
  MAIN -->|"unit shards plus validate:pr matrix"| PUSH[Push CI]
  MAIN -->|"Auto-Release: next patch tag"| TAG[Tag vX.Y.Z]
  TAG -->|dispatch| REL[Release workflow]
  REL -->|"verify, stamp version, pack"| GH[GitHub release<br/>kxm-X.Y.Z.tgz]
  GH -->|"sha256 verified"| NPM[npm publish]
  MAIN -->|"daily 04:00 UTC"| NIGHT[Nightly<br/>complete suite]
```

All workflows live in `.github/workflows/`. Linux jobs run on the organization's
ARC runner scale set. Validate also runs two Windows legs on GitHub-hosted
`windows-latest`. `test/core/ci-contract.test.ts` pins the runner selectors, job
names, coverage floors and release triggers. Change a workflow and that test
together.

## What runs where

| Trigger | Workflow (job) | What it runs |
|---|---|---|
| Before you push | Local | `npm run verify` |
| Pull request, push to `main`, or manual | `ci.yml` (`required`) | Aggregates the lanes below into one pass/fail check named `CI / required` |
| Pull request and push | `ci.yml` (Docs lint) | `lint:docs` and `check:versions`, always |
| Code pull request and code push | `ci.yml` (Unit engine and Unit, Linux Node 24) | `engine.test.ts` split by test name; `permission.test.ts`, `runtime.test.ts`, and `package-install.test.ts` one file at a time; every other unit file in two light shards. Typecheck and `check-generated` run on `light-1` |
| Platform-sensitive pull request | `ci.yml` (Unit, Windows Node 24) | The same unit lanes on `windows-latest` |
| Push to `main`, or manual | `ci.yml` (Validate matrix) | `validate:pr` on Linux and Windows for Node 22.19.0 and Node 24; not on a pull request |
| Code pull request and code push | `ci.yml` (Plugin validation) | `claude plugin validate --strict` on the marketplace and the plugin |
| Daily at 04:00 UTC, or manual | `nightly.yml` | `test:coverage:complete`, `check`, `check:generated`, `npm pack --dry-run` |
| Merged pull request | `auto-release.yml` | Tags the merge commit and dispatches `release.yml` |
| Tag push or dispatch | `release.yml` | Verifies, packs and publishes (see [Release flow](#release-flow)) |
| Manual only | `smoke.yml` | Real Pi smoke, currently disabled (see [Smoke tests](#smoke-tests)) |
| Pull request, or manual | `e2e.yml` | `npm run e2e` on `ubuntu-latest`: Obscura v0.2.3 plus the Playwright smoke test. Separate from `ci.yml` |

The npm scripts behind those rows:

| Script | Composition |
|---|---|
| `verify` | `npm test` (core and package unit tests), `check`, `check:generated` |
| `test:ci-shard` | One unit lane: build, then `engine <index> <total>`, `serial`, `light`, or `light-<index>` over `test/core/*.test.ts` and `packages/core/*/tests/unit/*.test.ts` |
| `validate:pr` | `build`, `typecheck`, a compact contract and smoke set of nine `test/core` files, `check:versions`, and the generated-`dist` check |
| `validate:ci` | `test:coverage` (core and package tests, 91/80/92 floors), `check`, `npm pack --dry-run`; the Release workflow runs it, and it stays available locally |
| `test:coverage:complete` | Core, simulation and package tests with 93/80/93 floors |
| `check` | `typecheck`, `lint:docs`, `check:versions` |

What moved off the pull-request lane, and what did not:

- The four `validate:pr` cells — Linux and Windows, Node 22.19.0 and Node 24 —
  run on a push to `main` and on `workflow_dispatch`. They do not run on a
  pull request. The nine files inside `validate:pr` still run on a code pull
  request, because they are part of the Linux Node 24 unit suite.
- Node 22.19.0 does not run the unit suite on a pull request. It runs
  `validate:pr` on `main`.
- Windows runs the unit suite on a pull request only when the classifier marks
  the change platform-sensitive. Every push to `main` that changes code still
  runs `validate:pr` on Windows.
- Coverage, `test/simulations`, and `npm pack --dry-run` stay in the nightly
  complete suite. They were not part of pull-request CI before this split.
- Plugin validation still runs on code pull requests and code pushes.

Run `npm run verify` locally before every push. A nightly failure is a release
blocker: it is the only place the simulation suite and coverage floors run.

### Lanes and the required check

Code pull requests run Docs lint, two Linux Node 24 engine shards, a serial
lane (`permission.test.ts`, then `runtime.test.ts`, then
`package-install.test.ts`), two light shards for every other unit file, and
Plugin validation. `light-1` typechecks and checks generated bundles.
`engine.test.ts` is split by test name because that file alone was 174
seconds; the serial lane keeps the next longest files off the light pool,
which was 268 seconds when every non-engine file shared one job.
`package-install.test.ts` is serial because on Windows it took 171 seconds
and the light job stopped reporting tests after that file finished (cancelled
at 20 minutes on pull requests #361, #362, and #363). The other light files
are round-robin split so each Windows job is about half of that pool. Linux
jobs use the npm cache from `actions/setup-node`. Restoring a
`node_modules` tarball was slower than `npm ci` on the Linux runners (about
24s versus 17s on 2026-09-24), so that cache stays on the Windows jobs,
where `npm ci` is the slow step.

The job `required` always runs. Its check name is `CI / required`. It fails
when a lane fails or is cancelled, and it passes when a lane was skipped
because the change did not need it. Add `CI / required` as a required status
check in the `protect-main` ruleset. Skipped matrix legs are not required
names, so they do not block auto-merge. This repository change does not edit
that ruleset.

A newer push cancels an older pull request run. Runs on `main` are never
cancelled. Unit and Validate matrices use `fail-fast`.

The Validate matrix still runs on Node 22.19.0 and Node 24, on Linux and
Windows, for pushes to `main` and for `workflow_dispatch`. Linux uses the ARC
scale set `kontextmind-doks` with a three-minute job timeout. Windows uses
GitHub-hosted `windows-latest` with a fifteen-minute timeout so `npm ci` can
finish. Those four job names are not the required check anymore.

### CI jobs stay queued while a runner is online

Every Linux workflow targets the ARC runner scale set `kontextmind-doks`. That
name is the scale set, not a custom label on a repository runner. The scale set
belongs to the selected-repository runner group `KontextMind DOKS ARC`, which
must allow this public repository. The legacy repository runner `km-gh-rn01`
must not carry the `kontextmind-doks` label; adding it bypasses ARC and
serializes the build queue.

Check GitHub routing first:

```bash
gh api repos/kontextmind/kxm/actions/runners \
  --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}'
gh api orgs/kontextmind/actions/runner-groups \
  --jq '.runner_groups[] | select(.name == "KontextMind DOKS ARC") |
    {name, visibility, allows_public_repositories}'
```

Then check ARC in the cluster:

```bash
kubectl -n arc-runners get autoscalingrunnerset kontextmind-doks
kubectl -n arc-runners get ephemeralrunners,pods
```

The capacity policy keeps one warm runner, bursts to four, and requests three
CPUs per runner so the node-pool autoscaler adds capacity instead of packing
CPU-bound jobs onto busy nodes. If jobs stay queued while the listener is
assigned zero jobs, check the runner group's selected repository and public
repository access. If ARC has pending pods, check node capacity and the cluster
autoscaler. Do not relabel `km-gh-rn01` or push an empty commit as a routing
workaround.

> [!NOTE]
> Windows jobs use GitHub-hosted `windows-latest`, not a self-hosted homelab
> runner and not the ARC scale set. Do not add a `kontextmind-doks` label to a
> Windows runner. Nightly complete coverage and release stay on Linux.
> Platform-sensitive pull requests run the unit suite on Windows, which
> includes `test/core/worker.test.ts`. The main Validate legs run the compact
> `validate:pr` gate.

### The docs-only classifier

The first job, Classify changes, lists the changed paths and sets `code=false`
when every path matches `*.md` (including `plans/**/*.md`), `docs/**`,
`.kxm/assets/**`, `LICENSE`, the issue and PR templates, or `dependabot.yml`.
A non-markdown file under `plans/` is code. Unit lanes, Plugin validation,
and the Validate matrix are skipped. Docs lint runs, and `CI / required`
passes. `scripts/ci-classify.mjs` and `ci-contract.test.ts` pin this behavior.

`platform=true` when a path is a package manifest, the lockfile, a file under
`scripts/` or `.github/workflows/`, or a filename that names path, process,
shell, spawn, worker, supervisor, repo-root, or ssh-remote behavior. A
platform-sensitive pull request also runs the Windows Node 24 unit lanes.

> [!WARNING]
> Several tests and code paths read documentation files by path. A pull request
> that only moves or renames a pinned doc is classified documentation-only, so
> CI does not run the tests that would catch the broken path; the next code
> change fails instead. For any docs move, update the pinned readers in the same
> pull request (see [Pinned paths](writing-docs.md#pinned-paths)) and run
> `npm run verify` locally before you push.

## Release flow

KXM releases a patch version for every merged pull request. No one bumps
versions by hand.

1. **Auto-Release** (`auto-release.yml`) runs when a pull request to `main` is
   merged. It finds the newest `vX.Y.Z` tag, adds one to the patch number, tags
   the merge commit, and dispatches the Release workflow for that tag.
2. **Release** (`release.yml`) checks out the tag, and takes its release helper
   scripts from `main`. It runs `npm run check:generated` against the tagged
   tree, stamps the tag's version into every version surface, runs
   `npm run validate:ci`, and packs `kxm-<version>.tgz`. The step summary records
   the tarball's sha256.
3. `scripts/kxm-release-github.mjs` creates a draft GitHub release, uploads the
   tarball, and checks the digest GitHub reports against the local one. The
   workflow then publishes the draft.
4. **Publish npm** runs in the protected `npm-publish` environment. It skips a
   version already on npm. Otherwise `scripts/kxm-publish-npm.mjs` confirms the
   GitHub release is published, downloads the asset, verifies its sha256
   against the release digest, and runs `npm publish` on that exact file.

Every step is idempotent. Rerunning the Release workflow for a tag that is
already published or already on npm reports it and changes nothing.

### Skip a release

Auto-Release skips a merge when the pull request has the `no-release` label, or
when its head branch starts with `chore/release-`.

### Versions

The version in the repository's `package.json` stays at its base value. The
release job stamps the tag's version into the package, the lockfile, the plugin
package and manifest, the marketplace entry, the MCP server constant, and every
workspace package, in the runner's workspace only. The stamp is never committed
back.

- Do not edit version fields in a pull request. `npm run check:versions` fails
  when any surface differs from the root `package.json`.
- Auto-Release only increments the patch number. For a minor or major release,
  push a `vX.Y.0` tag yourself; `release.yml` also runs on tag pushes, and
  later merges continue from that tag.
- `scripts/kxm-bump-version.mjs` and `scripts/check-versions.mjs` read the same
  package list from `scripts/package-surfaces.mjs`, so the gate and the writer
  cannot disagree.

### Changelog

Add user-visible changes to `CHANGELOG.md` under `## Unreleased`, in the same
pull request. Keep an entry to a few lines and link the doc page that explains
the behavior. Add an `### Upgrade note` when an operator must act.

No release step moves those entries into a dated section. Auto-Release tags a
patch for each merged pull request, but nothing cuts the changelog, so
everything released since its newest dated section is still listed under
`## Unreleased`.

## Smoke tests

Smoke tests prove what unit tests cannot: that the packed artifact installs,
and that real harnesses complete a turn.

| Smoke | How to run | What it proves |
|---|---|---|
| Packed install | Part of the core suite: `test/core/package-install.test.ts` | The packed CLI and hub run from a clean local and global install |
| Real Pi smoke | `KXM_SMOKE=1 KXM_SMOKE_MODELS=<model-a>,<model-b> node scripts/smoke-multi-pi.mjs` | Two supervised Pi workers discover each other, exchange requests and replies, and recover across a restart |
| Container install | `just docker-install-smoke` | The tarball installs into a fresh container with a fresh Pi, and two providers complete a live turn |

The real Pi smoke calls paid models, so it never runs by default. Its workflow,
`smoke.yml`, is manual and stays skipped until the repository variable
`KXM_SMOKE_RUNNER` names a runner with Pi credentials. Both smoke models run as
long-lived Pi workers, so each must pass the Pi native-vendor brake: pick two
non-native routes such as
`openrouter/qwen/qwen3-coder-plus,openrouter/z-ai/glm-5.3-flash`, never `xai/…`
or `anthropic/…`. The container smoke needs
Docker, a `pass-cli` session and a local Pi model store. It keeps secrets in a
mode-600 file inside a temporary directory; set `KXM_SMOKE_VAULT` to read keys
from your own vault.

### Manual checks before announcing a release

Automation cannot prove that a harness UI renders correctly. Before you
announce a release:

1. Install the published version:
   `npm install --global --omit=peer @kontextmind/kxm@<version>`.
2. Connect two current Pi sessions, run `/kxm hub`, and complete one inbound
   round trip.
3. Install the marketplace plugin in a clean Claude Code profile and confirm
   that `kxm_list` answers.
4. Check pushed channel delivery only when the target Claude Code version
   supports channels.

If a behavior can only be checked by hand, add it to this list rather than
implying automated coverage.

## Related

- [Develop KXM](development.md): the local gate and generated artifacts
- [Test matrix](test-matrix.md): which test proves which behavior
- [Write KXM documentation](writing-docs.md): doc gates and pinned paths
- [Upgrade KXM](../operations/upgrade.md): the operator side of a new version
