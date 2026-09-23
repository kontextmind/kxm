# KXM terminal components

Audience: maintainers and integrators who draw a KXM surface — the live screens,
a configuration panel, or a host adapter for another harness.

The kit is the workspace package
[`packages/core/tui`](../../packages/core/tui) (`@kontextmind/tui`),
also published on the product as `@kontextmind/kxm/tui`. It is one declarative
surface model, one renderer, one input decoder, one contribution registry, and
thin host adapters, so every surface keys, colours, and fails the same way. See
[Packages and workspaces](packages.md) for the layout convention it follows.

## Package layout

`types/`, `tui/`, `services/`, `adapters/`, `exports/`, with `tests/unit/` and
`tests/helpers/`. The layer rules, why each one exists, and the gate that
enforces them live in [Packages and workspaces](packages.md); the short version
is that a control which reads the filesystem cannot be rendered in a test, and
every control in `tui/` is rendered in a test.

## The surface contract

A surface is **published, not centralised**. An owner (configuration, roster,
routes, gates, roles, workflow) contributes sections and fields; one renderer
draws them all; the owner still performs every write. The panel never becomes a
second source of truth for configuration.

```ts
interface KxmTuiField {
  id: string;
  label: string;
  kind: "text" | "enum" | "choice" | "info";
  value?: string;        // absent means unset; `placeholder` is shown
  keyPath?: string;      // the configuration key this writes
  choices?: KxmTuiChoice[]; // selectable values, with status and per-entry action
  status?: "ready" | "available" | "blocked";
  statusText?: string;   // doubles as the error line for a refused edit
  actions?: KxmTuiAction[]; // owner keys, e.g. a confirm step
  busy?: boolean;
  progress?: { label: string; ratio?: number };
  steps?: KxmTuiStep[];  // multi-step work, listed not summarised
  output?: string[];     // tail of a running command
  updatedAt?: string;    // ISO timestamp, drawn as an age
}
```

`choice` vs `enum` is the model-selector rule: a short closed set cycles in
place, a long one gets its own screen with groups, per-entry status, and a
per-entry action. That is what lets one list hold an installed model that only
needs selecting and an absent one that needs fetching, without the renderer
knowing the difference.

Bounds are protocol limits, not suggestions
([`KXM_TUI_LIMITS`](../../packages/core/tui/src/types/surface.ts)). An oversized
or malformed published surface is refused with structured issues and drawn with
an error notice, so a broken file is still repairable from the panel.

## Fail-closed behaviour

| Situation | What happens |
|---|---|
| Owner throws while publishing | The section still draws, with the failure as its notice |
| Owner throws on a write | The old value stays, the reason lands on `statusText`, and the section carries the notice |
| Value the operator typed is invalid | It is never written and never echoed; the field keeps the on-disk value |
| A choice is `blocked` | Enter reports `statusText` and sends nothing (an unauthenticated route stays unauthenticated) |
| Handler for an unknown action or unknown owner | Refused with a message; never guessed |
| A write resolves after the registry was disposed or re-opened | Discarded as stale |
| No TTY, or `NO_COLOR` | One plain frame, exit `0`, no escape codes at all |
| Contract violation in a published surface | Refused with issues; the panel draws the reason instead of hiding it |

There is deliberately **no local echo**. A field is pending until its owner
republishes, so anything on screen is a value that exists on disk.

## Keyboard model

| Key | Action |
|---|---|
| `↑` `↓` / `k` `j` | move within the focused pane |
| `←` `→` / `Tab` / `h` `l` | switch sections and fields |
| `PgUp` `PgDn` | jump sections |
| `enter` | edit a text field, cycle an enum, open a choice list |
| type | filter a choice list, or edit a text value |
| `x` | clear the focused value (writes "unset", not a default) |
| owner keys | any `actions[].key` on the focused field |
| `esc` | back out of a pane, list, or draft, then quit |
| `Ctrl+C` | abort a busy field, else quit |
| `h` / `?` | help |

The reducer is pure
([`reduceKxmTuiInput`](../../packages/core/tui/src/tui/panel.ts)) and returns
effects; the component layer runs them. That is the same contract that keeps
`kxm dash` navigation testable, and it is why no key handling needs a terminal.

## Adding a surface

1. Write the descriptor table. Each row is one setting: id, key path, label,
   kind, choices, scope, and how to read the current value. Adding a setting
   means adding a row, not a case.
2. Publish sections from a `listSections()` that reads live state — files, the
   route policy, harness auth — never a snapshot taken at open time. A panel
   that goes stale is worse than no panel.
3. Implement `set` / `clear` handlers that validate, then write through the
   existing CLI helper. A surface edit must be exactly the CLI edit.
4. Register the contribution and run it. `invoke()` calls the handler, re-reads
   the owner, and repaints; a throw becomes a notice.

Selectable values come from reference sources, not from a model's memory: the
harness catalog in
[`harness.ts`](../../plugins/kxm/src/harness.ts), admitted routes in
`.kxm/routes.yaml`, the model inventory and price catalog, gate ids in
`.kxm/gates.yaml`, role ids in `.kxm/roles/`, and workflow ids in
`.kxm/workflows/`.

## What this kit does not do

- It is not an admission path. Listing a model, or editing a roster, grants
  nothing; writer admission is the trusted Git policy plus a live witness.
- It does not write trusted Git YAML. Roster, routes, gates, roles, and workflow
  definitions stay Git-reviewed changes with a diff and a PR.
- It is not a third verification gate. `npm run verify` and CI still decide
  whether work is green.
- It does not replace `kxm dash`. The dashboard keeps its hub and SSE loop and
  shares this kit's palette and layout maths.

## Related

- [Packages and workspaces](packages.md) — the layout convention and its gate
- [Configuration](../reference/configuration.md) — the settings a config surface edits
- [Architecture](../concepts/architecture.md) — component boundaries
- [Test matrix](test-matrix.md) — where a behaviour is proven
- [KXM contracts](../contracts/README.md) — schemas behind the reference files
