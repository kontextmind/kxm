# Contributing to KXM

Thank you for improving KXM. The project favors small, tested changes with a
clear effect for users. This page is the short version; the
[contributor guides](#contributor-guides) have the detail.

## Quick start

You need Node.js 22.19 or newer on the 22 line, or Node.js 24 or newer, plus npm
and Git.

```bash
git clone https://github.com/kontextmind/kxm.git
cd kxm
npm ci
npm run verify
```

`npm run verify` is the commit gate. It builds, runs the core and package unit
tests, type-checks, lints the docs, checks version surfaces, and confirms the
generated files are current. Run it before every push.

## Make a change

1. Open an issue first for changes to the protocol, the security model, or
   packaging.
2. Branch from `main`. Keep one concern per branch and one clear concern per
   commit.
3. Add or update a focused test for every behavior change, and add its row to
   the [test matrix](docs/contributing/test-matrix.md).
4. Run `npm run build` after changing bundled source, and commit the regenerated
   files with the source change. Never edit generated files by hand.
5. Update the user docs, and `CHANGELOG.md` under `## Unreleased`, for
   user-visible changes.
6. Run `npm run verify`, then push and open a pull request.

Changes to routes, request fields, status transitions, delivery modes, limits or
authentication are protocol changes. They also need integration tests, an update
to `plugins/kxm/skills/kxm/references/protocol.md`, and a compatibility note.
See [Develop KXM](docs/contributing/development.md#change-the-protocol).

## What CI checks

Every pull request and every push to `main` runs these checks:

- **Validate** on Node 22.19.0 and Node 24: `npm run validate:pr`, a
  three-minute merge-safety gate (build, typecheck, a compact contract and
  smoke set, version parity, generated `dist`). Skipped for
  documentation-only changes.
- **Docs lint**: `npm run lint:docs` and `npm run check:versions`, always.
- **Plugin validation**: `claude plugin validate --strict` on the marketplace
  and the plugin. Skipped for documentation-only changes.

CI does not run the full core suite, so run `npm run verify` locally before
every push. The complete suite with coverage floors runs nightly. Every merged pull request is released as a new patch version
automatically, so do not bump versions yourself. See
[CI and release](docs/contributing/ci-and-release.md).

## Contributor guides

| Guide | Covers |
|---|---|
| [Develop KXM](docs/contributing/development.md) | Checkout, repository layout, packaging, generated files, the commit gate, test conventions |
| [CI and release](docs/contributing/ci-and-release.md) | CI jobs, the release flow, versions, smoke tests |
| [Write KXM documentation](docs/contributing/writing-docs.md) | Page types, the page template, style rules, doc gates |
| [Test matrix](docs/contributing/test-matrix.md) | Which test proves which behavior |
| [Packages and workspaces](docs/contributing/packages.md) | Workspace packages and their layer rules |
| [Terminal components](docs/contributing/tui-components.md) | The `@kontextmind/tui` kit |
| [Assignment runner](docs/contributing/assignment-runner.md) | Delegating and accepting work from coding agents |
| [Repository work delivery skill](docs/contributing/repo-work-delivery.md) | The repository-local delivery prompt skill |

Coding agents working in this repository also read [`AGENTS.md`](AGENTS.md).

## Pull requests

A reviewable pull request includes:

- the problem and the solution, and the issue it addresses;
- scope and explicit non-goals;
- tests and the `npm run verify` result;
- user-facing documentation changes, or a note that none are needed;
- security and compatibility effects;
- screenshots or logs only when they help, and never with secrets in them.

Never put live tokens, credentials, or private prompts in code, tests, docs or
examples. Report security problems privately, as [SECURITY.md](SECURITY.md)
describes, not in a public issue.

By contributing, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md)
and to license your contribution under the repository's
[MIT License](LICENSE).
