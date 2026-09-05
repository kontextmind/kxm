# Contributing

Thank you for improving KontextMind Pi Extensions. This project favors small, testable changes with clear user impact.

## Development setup

Requirements:

- Node.js 22.19 or newer on the 22.x line, or Node.js 24 or newer;
- npm;
- Git;
- Pi for extension smoke testing;
- Claude Code for strict plugin-manifest validation.

Install the locked dependencies:

```powershell
npm ci
```

Run the commit gate:

```powershell
npm run verify
```

`npm run verify` is `npm test`, `npm run check`, and `check:generated` (staged
`dist` vs the current build). CI PR legs run `validate:ci` (coverage + check +
pack dry-run) and `check:generated` on every matrix cell. Plugin validation is
a hosted CI job (`claude plugin validate`), not a third npm script and not a
pre-push requirement. `npm run validate` still exists for a local machine that
already has the Claude CLI.

### Coverage ratchet

The three `--test-coverage-*` thresholds in `package.json` are the measured whole-tree values at the time they were set. A PR may raise any of them. No PR may lower one. A PR that drops coverage below the gate adds tests; it does not touch the flag. If a later run fails by a fraction with no code change, the answer is a test fix or a raise elsewhere, never a lowered flag. 95/80/90 is a milestone, not the gate.

### Coverage excludes

`--test-coverage-include=plugins/kxm/src/**/*.ts` covers the source tree. An exclude needs a reason that is not "hard to test":

- `plugins/kxm/src/server.ts`: hub process entry. Executed only as the esbuild bundle `dist/server.js` spawned via `scripts/kxm-hub.mjs`. Child execution attributes to `dist`, never to this source file. No test imports it.
- `plugins/kxm/src/mcp-server.ts`: MCP stdio entry, bundled by `build:mcp` and exercised as a spawned process. Same attribution reason. No test imports it.

## Making a change

1. Open an issue for behavior changes that affect the protocol, security model, or packaging.
2. Create a focused branch from the current default branch.
3. Keep one clear concern per commit.
4. Add or update tests and `docs/test-matrix.md` for behavior changes.
5. Update the relevant user guide and `CHANGELOG.md` for user-visible changes.
6. Run `npm run verify` before requesting review. Plugin validation runs in CI.

## Source and generated files

When changing the CLI, hub, MCP server, or one of their shared modules, run:

```powershell
npm run build
```

Commit the corresponding files under `plugins/kxm/dist/` with the source change. npm and Claude marketplace installations use these self-contained artifacts and must not require development dependencies or runtime TypeScript stripping.

After building, `git add plugins/kxm/dist`, then run `npm run verify`. The
generated-artifact check rebuilds the runtimes and compares the built files
to the staged copy; it fails if any required artifact is missing, untracked,
or differs from the index.

Do not edit generated runtime files by hand.

Repository-local runtime conventions belong under `.kxm`: reviewable configuration in `config`, intentional workflow artifacts in `assets`, ignored logs in `logs`, and ignored recovery state in `state`. Never commit live logs, SQLite files, generated assets, or secret values.

## Protocol changes

Changes to routes, request fields, status transitions, delivery modes, limits, or authentication require:

- integration tests;
- an update to `plugins/kxm/skills/kxm/references/protocol.md`;
- an update to the relevant guide under `docs/`;
- a changelog entry;
- a compatibility note when existing clients could break.

Prefer additive changes. Breaking changes require a major version or an explicitly versioned protocol path.

## Documentation style

- Lead with the user outcome.
- Put commands in the order users should run them.
- State prerequisites, defaults, and failure conditions.
- Use **hub**, **agent**, **peer**, **project**, **request**, and **reply** consistently.
- State the single-node production boundary precisely; do not imply clustering or exactly-once execution.
- Never put live tokens, credentials, or private prompts in examples.

## Pull requests

A reviewable pull request includes:

- a concise problem and solution statement;
- scope and explicit non-goals;
- tests and validation results;
- user-facing documentation changes;
- security or compatibility considerations;
- screenshots or logs only when they add diagnostic value and contain no secrets.

By contributing, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md) and license your contribution under the repository's [MIT License](LICENSE).
