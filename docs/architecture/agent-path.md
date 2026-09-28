# Agent path

Read from `plugins/kxm/src/cli/project.ts`, `plugins/kxm/src/engine.ts`,
`plugins/kxm/src/worktree-witness.ts`, and `plugins/kxm/src/oneshot-producer.ts`.

`kxm run` resolves the project from the current directory and posts
`POST /v1/runs` to the Runtime supervisor (`cmdKxmRun`). The response names
`kxm runs drive <runId> --wait` as the next step. Drive posts
`POST /v1/runs/<runId>/drive` and later reads the drive receipt. The
supervisor's producer is the one-shot producer registered from
`plugins/kxm/src/oneshot-producer.ts`. Around a live spawn, the engine takes
a checkout fingerprint, invokes the producer, then fingerprints again
(`captureWorktreeWitness` and `applyAuthoringWitness`). A write step that
does not change the tree cannot stay `passed`. A read-only step that changes
the tree cannot stay `passed`.

When the step's role lists the failure on `policy.fallback.onError`, a
walkable producer error is redispatched on the next admitted route before the
attempt settles. The engine records `routing.route_switched` and logs
`route_switch`. An empty or absent list does not take this path.

```mermaid
sequenceDiagram
  participant CLI as kxm CLI
  participant Sup as Runtime supervisor
  participant Eng as engine
  participant Har as harness process
  CLI->>Sup: "POST /v1/runs"
  CLI->>Sup: "kxm runs drive"
  Sup->>Eng: "producer dispatch"
  Eng->>Eng: "fingerprint before spawn"
  Eng->>Har: "one-shot harness"
  Har-->>Eng: "producer result"
  Eng->>Eng: "fingerprint after spawn"
  Eng-->>CLI: "drive receipt"
```

## Related

- [Platform](platform.md)
- [First workflow](../start/first-workflow.md)
