# Architecture decision records

An architecture decision record (ADR) captures one significant decision about KXM: the context, the options considered, what was chosen, and what follows from it. Read these when you want to know why KXM works the way it does, or before you propose to change one of these decisions.

## Index

| ADR | Decision | Status | Date |
|---|---|---|---|
| [ADR-001](../contracts/architecture.md) | Local Runtime, project authority, and aggregate hub | Accepted target | — |
| [ADR-0002](ADR-0002-browser-automation-steel-doks.md) | Self-hosted Steel for reusable browser automation and human takeover | Accepted | 2026-09-14 |
| [ADR-0003](ADR-0003-sqlite-only-store.md) | SQLite as the only store | Accepted | 2026-09-17 |
| [ADR-0004](ADR-0004-edge-identity-authentik.md) | Edge identity with Authentik; the hub owns no browser identity | Accepted | 2026-09-20 |

ADR-001 is the original decision record for the local Runtime. It lives with the contracts in [`docs/contracts/architecture.md`](../contracts/architecture.md) because it is the root of those contracts, and it keeps its original three-digit number. Records in this directory continue the sequence from 0002. There is no ADR-0001.

> [!NOTE]
> ADR-001 is an accepted target. It describes the intended split between the Runtime and the hub, and parts of it are not implemented yet. [Architecture](../concepts/architecture.md) describes what the current build does.

## Write a new ADR

1. Take the next free number and name the file `ADR-<number>-<short-slug>.md`.
2. Start it with the same `kxm.doc.v1` front matter as the existing records, with `type: "adr"` and `authority: "decision"`.
3. Include these sections: Status, Context, Decision drivers, Considered options, Decision, and Consequences, and end with Related.
4. Record rejected options with the reason they were rejected, so the next reader does not reopen them without new information.
5. When a decision replaces an earlier one, set `supersedes` and `superseded_by` in both records instead of editing the old decision.
6. Add a row to the index above.

## Related

- [Architecture](../concepts/architecture.md)
- [Trust model](../concepts/trust-model.md)
- [Data and storage](../concepts/data-and-storage.md)
- [Contracts](../contracts/README.md)
