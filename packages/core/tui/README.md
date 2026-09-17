# @kontextmind/tui

Reusable KXM terminal components: one declarative surface model, one renderer,
one input decoder, one contribution registry, and thin host adapters.

`kxm dash` and every configuration surface draw from here so a field looks,
keys, and fails the same way across the product. Guide:
[`docs/tui-components.md`](../../../docs/tui-components.md).

## Layout

```text
src/
  types/      surface contract and its validation; imports nothing outside itself
  tui/        pure controls: keys, layout, theme, panel reducer, renderer, component
  services/   the contribution registry that routes every write to its owner
  adapters/   host bindings: a standalone terminal session and the Pi TUI
  exports/    the public surface; anything unexported may be reshaped
tests/
  unit/       one file per layer
  helpers/    the reference surface fixture
```

`src/` may import `@earendil-works/pi-tui` and nothing else external. No
`node:fs`, no hub, no SQLite: a control that reads disk cannot be rendered in a
test, and every control here is. The layer rules are enforced by
`test/core/package-layers.test.ts`, not by memory.

## Tasks

| Command | What it does |
|---|---|
| `bun run build` | Bundle `src/exports/index.ts` to `dist/index.js` |
| `bun run test` | Run the unit tests under Node |
| `bun run test:coverage` | Same, with the coverage floor |
| `bun run typecheck` | `tsc --noEmit` for this package |

From the repository root: `npx nx run tui:<target>` or
`npx nx run-many -t build,test`.

## Boundary

This package renders and routes. It does not own configuration, admit a writer,
or decide that work is green. Owners publish sections and perform their own
writes, so the panel can never become a second source of truth.
