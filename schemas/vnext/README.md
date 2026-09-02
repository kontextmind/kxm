# KXM vNext schemas

These draft 2020-12 JSON Schemas validate parsed YAML configuration, bounded
Runtime-local records, and JSON events/results for the planned vNext contract.

| Schema | Identity |
|---|---|
| `project.schema.json` | `kxm.project.v1` |
| `repository.schema.json` | `kxm.repository.v1` |
| `agent.schema.json` | `kxm.agent.v1` |
| `model.schema.json` | `kxm.model.v1` |
| `environment.schema.json` | `kxm.environment.v1` |
| `workflow.schema.json` | `kxm.workflow.v1` |
| `template-provenance.schema.json` | `kxm.template-provenance.v1` |
| `local-repository-bindings.schema.json` | `kxm.local-repository-bindings.v1` |
| `init-operation.schema.json` | `kxm.init-operation.v1` |
| `run-event.schema.json` | `kxm.run-event.v1` |
| `sync-event.schema.json` | `kxm.sync-event.v1` |
| `assignment-result.schema.json` | `kxm.assignment-result.v1` |
| `delivery-manifest.schema.json` | `kxm.delivery-manifest.v1` |
| `context-candidate.schema.json` | `kxm.context-candidate.v1` |

`common.schema.json` supplies bounded shared definitions. JSON Schema is only
one validation layer; cross-file references, state-machine semantics,
permission diffs, model diversity, path portability, and snapshot reproduction
are deterministic semantic checks described in
[`docs/vnext/validation.md`](../../docs/vnext/validation.md).

Unknown fields fail closed. A new field requires a reviewed schema revision;
do not add generic metadata escape hatches to event or synchronization payloads.
