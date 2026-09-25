---
schema: "kxm.doc.v1"
id: "PLAN-1PASSWORD-VAULTS"
type: "architecture"
title: "1Password vaults for the kxmd platform and its tenants"
project: "kxm"
status: "draft"
owner: "kxm"
created: "2026-09-25"
updated: "2026-09-25"
authority: "hypothesis"
confidence: "medium"
summary: "Proposed 1Password vault names, read grants, and same-name override order for the Families account. Delivery authority stays in the active implementation tracker."
tags: ["1password", "secrets", "tenant", "platform"]
related:
  - implementation-plan.md
  - plan-per-tenant-hosting.md
  - plan-greenfield-infra.md
depends_on: []
blocked_by: []
details:
  describes: "proposed"
---

# 1Password vaults

Read [the execution tracker](implementation-plan.md) first. This file is proposed shape only. It does not create a vault, grant a token, or change a phase gate. Accepted names and the override order are recorded in Tracking. A slice starts only after it is selected there.

Operator request, 2026-09-25: one vault layout for the `kxmd` platform and each tenant, with unattended reads, and a narrower scope overriding the same variable name.

## What this account can do

The live account is the Families plan **Our Family** (`eddie@iloves.io`). It already uses a service account token. That is the automation path.

The 1Password SSH agent is not this path. It unlocks keys for a person at the desktop. A guest cannot use it unattended.

A Families service-account token may make 1,000 reads and 100 writes an hour. The whole account may make 1,000 service-account requests a day. A guest reads at start and keeps the value. It does not poll.

A service account cannot be granted Private or the built-in Shared vault. Every vault in this plan is a custom vault.

There is no cross-vault item link. An item lives in one vault. Read-only means the service account is granted `allow_viewing` on that vault and is not granted editing. A vault the caller cannot read does not participate in override. If a vault contains a name the caller must not see, split the vault. Do not copy the item.

Tags are labels. They are not a grant. Anyone who can read the vault can read every item in it.

Families can give machine identities these vaults. It cannot give a second human tenant, who is not in the family, a login. That needs Teams or Business, with one group per tenant. That move is not selected.

## Names

`kxmd` is the platform prefix. `{tid}` is the tenant identifier. This tenant's identifier is `kxmd`, so its tenant vault is `kxmd-kxmd`. `{projectid}` is never `kxm`. `kxm` is the service, not a vault prefix.

| Vault | Holds | Who may read |
|---|---|---|
| `kxmd-system` | System-wide platform secrets | Platform admin only |
| `kxmd-shared-system` | Shared by platform services | Service accounts for guests a user cannot log into |
| `kxmd-svc-{service}` | One platform service | That service's account |
| `kxmd-shared-public` | Published to tenants | Those service accounts, plus a guest a user can log into |
| `kxmd-{tid}` | Tenant-wide product secrets, including workflows and agents | Every guest of that tenant |
| `kxmd-{tid}-p{projectid}` | One project | Guests that run that project |
| `kxmd-{tid}-v{vmid}` | One guest | That guest |

There is no `kxm-{tid}-global` vault. There is no vault per platform guest: a platform guest is a service, so it uses `kxmd-svc-{service}`.

A user-accessible guest may read its own `kxmd-{tid}-v{vmid}`, `kxmd-{tid}`, the project vaults for projects on that guest, and `kxmd-shared-public`. It does not read `kxmd-system` or `kxmd-shared-system`.

Write stays with the operator. A service that must rotate its own credential gets editing on only its own vault.

## Same variable name

The same `VAR_NAME` resolves to the narrowest readable scope. A missing scope is skipped.

1. `kxmd-{tid}-v{vmid}`
2. `kxmd-{tid}-p{projectid}`
3. `kxmd-{tid}`
4. `kxmd-shared-public`
5. `kxmd-svc-{service}`
6. `kxmd-shared-system`
7. `kxmd-system`

## Not selected

Creating the vaults, issuing a token per guest, splitting the existing `kontextmind` vault, and moving a second human tenant to Teams or Business are not selected. The existing `kontextmind` vault does not have to move first.
