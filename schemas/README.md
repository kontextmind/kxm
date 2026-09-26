# KXM schemas

These draft 2020-12 JSON Schemas validate parsed YAML configuration, bounded
Runtime-local records, and JSON events/results for the planned KXM contract.

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
| `lanes.schema.json` | `kxm.lanes.v1` |
| `init-operation.schema.json` | `kxm.init-operation.v1` |
| `permission-diff.schema.json` | `kxm.permission-diff.v1` |
| `run-event.schema.json` | `kxm.run-event.v1` |
| `coordinator.schema.json` | `kxm.coordinator.v1` |
| `intake-message.schema.json` | `kxm.intake-message.v1` |
| `sync-event.schema.json` | `kxm.sync-event.v1` |
| `assignment-result.schema.json` | `kxm.assignment-result.v1` |
| `delivery-manifest.schema.json` | `kxm.delivery-manifest.v1` |
| `context-candidate.schema.json` | `kxm.context-candidate.v1` |
| `candidate.schema.json` | `kxm.candidate.v1` |

`common.schema.json` supplies bounded shared definitions. JSON Schema is only
one validation layer; cross-file references, state-machine semantics,
permission diffs, model diversity, path portability, and snapshot reproduction
are deterministic semantic checks described in
[`docs/contracts/validation.md`](../docs/contracts/validation.md).

Unknown fields fail closed. A new field requires a reviewed schema revision;
do not add generic metadata escape hatches to event or synchronization payloads.

`kxm.run-event.v1` `run.created` records declared inventory as `repositoryIds`
and `executorIds` (empty executor inventory is valid). `repositories` /
`executors` object arrays remain optional prepared snapshots/resolutions and
are not emitted by the D2 engine. `memoryRevision` is required;
`ctxrev_absent` is the explicit none value until E5. D2 event types have
closed payload contracts for the identity, status, and result fields the
engine emits. `assignment.result_recorded` requires `assignmentId` and
`resultClass`; class `outcome` requires `outcome`, and the non-outcome
classes forbid it. Shared future event types stay in the enum; this slice
does not emit `waiting` or `blocked_uncertain` run transitions.
