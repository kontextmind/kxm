# Surfaces

Read from `plugins/kxm/src/cli.ts`, `scripts/kxm-hub.mjs`, `plugins/kxm/src/hub.ts`,
`plugins/kxm/src/runtime-supervisor.ts`, `plugins/kxm/src/runtime-paths.ts`,
`plugins/kxm/src/mcp-server.ts`, `plugins/kxm/src/oneshot-producer.ts`,
`plugins/kxm/src/studio-layout.ts`, `plugins/kxm/src/cli/types.ts`
(`workspaceDirs`), `plugins/kxm/src/local-snapshot.ts`, and
`scripts/kxm-worker.mjs`.

| Surface | Started by | Listener or path | Store it owns | Defining file |
| --- | --- | --- | --- | --- |
| `kxm` CLI | `node scripts/kxm.mjs` or the installed bin | no listener | none | `plugins/kxm/src/cli.ts` |
| Hub | `kxm hub start` via `scripts/kxm-hub.mjs` | `127.0.0.1:7331` | `.kxm/state/kxm.db` under the workspace state dir | `plugins/kxm/src/hub.ts` |
| Hub credentials | written when the hub starts | `hub-env.json` under the user state root | that JSON file, not SQLite | `plugins/kxm/src/hub-env.ts` |
| Runtime supervisor | `kxm runtime` / `scripts/kxm-runtime-supervisor.mjs` | `127.0.0.1` and the requested port, or ephemeral | registry and event stores below | `plugins/kxm/src/runtime-supervisor.ts` |
| Runtime registry | opened by the supervisor | `runtime/registry.db` under the user state root | `registry.db` | `plugins/kxm/src/runtime-paths.ts` |
| Runtime event store | opened by the supervisor | `runtime/projects/<key>/run-events.db` | `run-events.db` | `plugins/kxm/src/runtime-paths.ts` |
| MCP server | Claude plugin or stdio launch | stdio | none | `plugins/kxm/src/mcp-server.ts` |
| One-shot harness | supervisor producer | child process, no listener | none | `plugins/kxm/src/oneshot-producer.ts` |
| Pi worker | `kxm agent worker` | no HTTP listener in `scripts/kxm-worker.mjs` | none of its own | `scripts/kxm-worker.mjs` |
| Studio | `kxm studio serve` | `127.0.0.1:4242` | none | `plugins/kxm/src/studio-layout.ts` |
| Workspace config | `workspaceDirs` | `.kxm/config`, or `KXM_CONFIG_DIR` | files in that directory | `plugins/kxm/src/cli/types.ts` |
| Workspace logs | `workspaceDirs` | `.kxm/logs`, or `KXM_LOGS_DIR` | log files | `plugins/kxm/src/cli/types.ts` |
| Workspace assets | `workspaceDirs` | `.kxm/assets`, or `KXM_ASSETS_DIR` | asset files | `plugins/kxm/src/cli/types.ts` |
| Workspace state | `workspaceDirs` | `.kxm/state`, or `KXM_STATE_DIR` | `kxm.db` when the hub uses this directory | `plugins/kxm/src/cli/types.ts` |

On macOS the user state root is `Library/Application Support/KXM` under the
home directory (`kxmUserStateRoot` in `plugins/kxm/src/bindings.ts`). Windows
uses `AppData/Local/KXM`. Other platforms use `$XDG_STATE_HOME/kxm` or
`.local/state/kxm`. `KXM_STATE_HOME` overrides that root when it is absolute.
The tracker mentions `docs/operations.md` for the six backup roots. That file
is not in this checkout. The six roots are described in
[Backup and restore](../operations/backup-and-restore.md).

## Related

- [Platform](platform.md)
- [Backup and restore](../operations/backup-and-restore.md)
