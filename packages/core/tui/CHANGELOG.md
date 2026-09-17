# Changelog

All notable changes to `@kontextmind/tui` are documented here. The repository
keeps one version across every package, checked by `npm run check:versions`.

## 0.7.1

### Added

- Surface contract `kxm.tui-contract.v1`: sections, fields, selectable choices
  with `ready|available|blocked` status, owner actions, steps, progress, an
  output tail, and bounded validation that refuses an oversized or malformed
  published surface.
- Pure panel reducer that emits effects without writing, plus a plain-text
  renderer, a Pi `Component` adapter, a standalone terminal adapter, and a
  `ctx.ui.custom` adapter.
- Contribution registry: owners publish sections and handle their own writes; a
  failed write returns as the old value plus the owner's reason.
- CLI palette shared with `kxm dash`, so one colour cannot mean two things.
