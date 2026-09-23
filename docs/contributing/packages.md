# Packages and workspaces

KXM ships one installable product, `@kontextmind/kxm`, which Pi, the Claude Code
plugin and the MCP server all load. It is developed as an npm workspace so that a
reusable component can be built, tested and cached on its own. This page is for
maintainers who add or move code between packages.

## Layout

```text
.
├── package.json            # root product + "workspaces"
├── nx.json                 # task graph, caching, inputs/outputs
├── bunfig.toml             # Bun task-runner settings
├── project.json            # (per package, not at the root)
├── plugins/kxm/            # the product: CLI, hub, runtime, extension, MCP
├── packages/
│   └── core/<name>/        # reusable libraries
│       ├── src/
│       │   ├── types/      contract and validation; imports nothing external
│       │   ├── tui/        pure controls; may import only the Pi renderer
│       │   ├── services/   I/O and policy; never renders
│       │   ├── adapters/   host bindings (terminal session, Pi TUI)
│       │   └── exports/    the public surface; anything else may be reshaped
│       ├── tests/
│       │   ├── unit/       one file per layer
│       │   └── helpers/    shared fixtures
│       ├── package.json  tsconfig.json  project.json
│       └── README.md  CHANGELOG.md  LICENSE
└── test/core/              # product tests, plus the package-layout gate
```

Current packages:

| Package | Role | Consumers |
|---|---|---|
| `@kontextmind/tui` (`packages/core/tui`) | Reusable terminal components | `kxm dash` (its ANSI theme); integrators through `@kontextmind/kxm/tui` |

## Commands

| Command | What it does |
|---|---|
| `npm ci` / `bun install` | Install and link workspace packages into `node_modules` |
| `npm run build` | Bundles the product, then `npx nx run-many -t build` |
| `npx nx show projects` | List workspace projects Nx knows |
| `npx nx run tui:test` | One package's tests, from its cacheable target |
| `npx nx run-many -t build,test` | Every package |
| `npm run verify` | The commit gate: tests, checks, and generated-artifact parity |

Bun can run tasks locally (`bun run build`, `bun x nx ...`). Installation and CI
still resolve through `npm ci` on Node 22.19.0 and 24, because the hub, the CLI
and Pi's extension host are Node runtimes. Moving the installer itself to Bun is
a separate change that needs its own CI evidence.

## Rules that keep the shape

These are gates, not preferences:

- `test/core/package-layers.test.ts` refuses an import that crosses layers the
  wrong way, a package source that is not parsed, a missing `README.md`,
  `CHANGELOG.md`, `LICENSE`, `tsconfig.json`, or `project.json`, and a consumer
  that reaches into a package by path instead of by name.
- `npm run check:versions` requires every package and its lock entry to carry the
  repository version.
- `scripts/check-generated.mjs` requires each package's built `dist` to be
  tracked and current, the same rule the product bundles already follow.
- `test/core/import-boundary.test.ts` keeps `@kontextmind/kxm/core` free of Pi
  and commander, so a Pi-bound package can never leak into the host-neutral
  library seam.

## Adding a package

1. Create `packages/<tier>/<name>/` with the layer directories above, and a
   `package.json` whose `exports["."]` points at `src/exports/index.ts`.
2. Add `tsconfig.json` (same strict options as the root), `project.json` targets
   that delegate to package scripts, `README.md`, `CHANGELOG.md`, and `LICENSE`.
3. Run the installer once so the package links into `node_modules`, then import
   it by name — never by relative path.
4. If it builds a `dist`, add that path to `STATIC_GENERATED_ARTIFACTS` in
   `scripts/check-generated.mjs` and to root `files`.
5. Run `npm run verify`. A new package that nothing imports is a liability:
   land it with its first consumer, or keep it internal until then.

## Related

- [Terminal components](tui-components.md): the kit and its surface contract
- [Develop KXM](development.md): the commit gate and generated artifacts
- [Architecture](../concepts/architecture.md): component boundaries
- [Configuration](../reference/configuration.md): what is settings versus shipped code
