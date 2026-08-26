# Contributing

Thank you for improving KontextMind Pi Extensions. This project favors small, testable changes with clear user impact.

## Development setup

Requirements:

- Node.js 22.13 or newer on the 22.x line, or Node.js 24 or newer;
- npm;
- Git;
- Pi for extension smoke testing;
- Claude Code for strict plugin-manifest validation.

Install the locked dependencies:

```powershell
npm ci
```

Run the main checks:

```powershell
npm run test:coverage
npm run check
npm run check:generated
npm run validate:claude
npm pack --dry-run
```

`npm run validate` runs the complete local release gate.

## Making a change

1. Open an issue for behavior changes that affect the protocol, security model, or packaging.
2. Create a focused branch from the current default branch.
3. Keep one clear concern per commit.
4. Add or update tests and `docs/test-matrix.md` for behavior changes.
5. Update the relevant user guide and `CHANGELOG.md` for user-visible changes.
6. Run `npm run validate` before requesting review.

## Source and generated files

When changing the CLI, hub, MCP server, or one of their shared modules, run:

```powershell
npm run build
```

Commit the corresponding files under `plugins/pi-mesh-comms/dist/` with the source change. npm and Claude marketplace installations use these self-contained artifacts and must not require development dependencies or runtime TypeScript stripping.

After committing the generated files, run `npm run check:generated`. It rebuilds
the runtimes and fails if any required artifact is missing, untracked, or
changed by the build.

Do not edit generated runtime files by hand.

Repository-local runtime conventions belong under `.kxm`: reviewable configuration in `config`, intentional workflow artifacts in `assets`, ignored logs in `logs`, and ignored recovery state in `state`. Never commit live logs, SQLite files, generated assets, or secret values.

## Protocol changes

Changes to routes, request fields, status transitions, delivery modes, limits, or authentication require:

- integration tests;
- an update to `plugins/pi-mesh-comms/skills/pi-mesh-comms/references/protocol.md`;
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
