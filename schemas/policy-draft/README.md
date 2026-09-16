# Policy-draft schemas (non-authoritative)

`kxm.model.v2` and `kxm.role.v2` here are **passive scaffolding**. They are not
operator settings, live registry identities, or admission.

- Live project models remain `kxm.model.v1` under `schemas/vnext/`.
- Live CLI roles remain `kxm.role.v1`.
- Runner admission remains `.kxm/roster.yaml` via the trusted control Git loader.
- This directory is not discovered as a vNext project resource.

Pure validation lives in `plugins/kxm/src/policy-draft.mjs`
(`validatePolicyDraft`). Callers must supply draft documents, evidence bytes,
and code-owned ceilings explicitly. The function does not read files, Git,
credentials, or cwd, and it does not dispatch or admit a route.

Roster `route` lists are configured preference order, not a measured ranking.
`status: candidate` is stored as candidate data and is never treated as admitted.
