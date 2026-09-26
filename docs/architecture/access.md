# Access

Read from `.kxm/roles/writer.yaml`, `.kxm/roles/planner.yaml`,
`.kxm/roles/reviewer-arch.yaml`, `.kxm/roles/reviewer-cli.yaml`,
`plugins/kxm/src/role.ts`, `plugins/kxm/src/commands.ts`,
`plugins/kxm/src/harness.ts`, and `plugins/kxm/src/project-config.ts`.

The four principals in this checkout are the v2 role files under `.kxm/roles/`:
`writer.yaml`, `planner.yaml`, `reviewer-arch.yaml`, and `reviewer-cli.yaml`.
None of those files sets `tools`. `listRoles` in `plugins/kxm/src/role.ts`
sets `toolsCount` from `tools.allow.length` and does not apply the list.

`isToolAllowed` in `plugins/kxm/src/commands.ts` enforces `preset: read-only`
by denying mutating `kxm_*` tools. `oneShotReadOnlyArgs` and
`oneShotWriterArgs` in `plugins/kxm/src/harness.ts` are the harness argument
sets. Edit arguments exist for `pi`, `omp`, and `grok`. Other harnesses stay
on the read-only set. A live write step without an edit profile hands off
instead of spawning unconstrained (`unsupportedLiveWrite` in
`plugins/kxm/src/engine.ts`).

`BUILTIN_TOOL_PRESETS` in `plugins/kxm/src/project-config.ts` is
`coordinator`, `read-only`, `workspace-writer`, and `tests-writer`.

```yaml
--8<-- "architecture/access-schema.yaml"
```

## Related

- [Authentication](authentication.md)
- [Agent path](agent-path.md)
