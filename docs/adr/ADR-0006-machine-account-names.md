---
schema: "kxm.doc.v1"
id: "ADR-0006"
type: "adr"
title: "Machine account names"
project: "kxm"
status: "accepted"
owner: "@operator"
created: "2026-09-27"
updated: "2026-09-27"
authority: "decision"
confidence: "verified"
summary: "New machine accounts use svc-<system>-<purpose>, or svc-<tenant>-<system>-<purpose> when they belong to one tenant. Test accounts add a test- prefix and stay out of production groups."
tags: ["architecture", "decision", "authentik", "accounts"]
related: ["docs/adr/ADR-0004-edge-identity-authentik.md", "docs/operations/deploy.md", "docs/contributing/operating-rules.md"]
details:
  decision_drivers:
    - "One readable pattern for platform and tenant machine accounts"
    - "Test and witness accounts must be unable to enter production groups"
    - "Existing names stay until an approved inventory authorizes a rename"
  supersedes: null
  superseded_by: null
---

# ADR-0006: Machine account names

## Status

Accepted on 2026-09-27.

## Context

Authentik machine accounts were created with local names such as `kxm-agent`, `kxm-witness-*`, `witness9`, `kxmdproof`, `kxm-provisioner`, and `agent-ilo-asus`. Those names do not say whether the account is platform-wide, tenant-scoped, or a test identity. Renaming them without an inventory would drop grants that still point at the old name.

## Decision drivers

1. A reader can tell the scope of an account from its name.
2. Test, witness, and proof accounts must not sit in production groups.
3. Authentik's own accounts keep the names Authentik assigns.
4. A rename of an account that already exists waits for an approved inventory.

## Considered options

1. **`svc-` names, with a `test-` prefix for non-production accounts.**
2. **Keep creating ad hoc names.**
3. **Put every machine account under Authentik's `ak-*` prefix.**

### Option 1: `svc-` names (chosen)

- Good, because platform and tenant scope are visible in the name.
- Good, because a `test-` prefix can be excluded from production groups.
- Bad, because accounts that already exist keep their old names until an inventory is approved.

### Option 2: ad hoc names (rejected)

- Good, because nothing already issued has to change.
- Bad, because the next account repeats the same ambiguity.

### Option 3: `ak-*` for every machine account (rejected)

- Good, because one prefix would match Authentik-managed users.
- Bad, because `ak-*` is Authentik's own namespace for outposts and internal users.

## Decision

Create machine accounts with these shapes. `<tenant>` is the tenant slug.

| Scope | Name |
|---|---|
| Platform-wide | `svc-<system>-<purpose>` |
| Tenant-scoped | `svc-<tenant>-<system>-<purpose>` |
| Test, witness, or proof | The same shapes with a `test-` prefix |

A `test-` account is never a member of a production group.

Authentik-managed accounts are exempt. That includes outposts and any account whose name starts with `ak-`.

The `svc-steel` credential that reaches the Steel server is the account operators use today. This record does not rename it. Names already recorded in plans and handoffs, including `kxm-agent`, `kxm-witness-*`, `witness9`, `kxmdproof`, `kxm-provisioner`, and `agent-ilo-asus`, stay as written until an approved inventory lists each rename. Do not invent a replacement for a specific account.

## Consequences

- New accounts follow the table above.
- This repository does not assign new names to the recorded accounts.
- Group names such as `kxmd-owners` are groups, not machine accounts, and this record does not rename them.

## Related

- [Edge identity](ADR-0004-edge-identity-authentik.md)
- [Deploy KXM](../operations/deploy.md#name-machine-accounts)
- [Operating rules](../contributing/operating-rules.md)
