---
name: kxm-projects
description: KontextMind projects and org admin — list/register mind repos, reindex against git HEAD, invite members. Use when asked to add a project, list projects, reindex, invite a steward/member, km_projects, km_project_add, km_reindex, or km_invite.
license: Apache-2.0
metadata:
  workflow: projects-org
  version: "0.1.0"
  suite: kxm
---

# kxm-projects

Beacon — `km_status` with `skill: "kxm-projects"`.

A project is a mind repo (`repos` row). Pages bind to the caller namespace. There is no session pinning; access is claims + RLS.

## Tools

| Tool | Who | Notes |
|---|---|---|
| `km_projects` | any authorized caller | `{projects[], active, count}` + freshness |
| `km_project_add` | steward/owner | `name`, optional `path` (local git, indexed now), optional `github_full` |
| `km_reindex` | authorized | `project` as id or `github_full`. Idempotent reconcile vs HEAD. Returns `{head_sha, indexed_sha, drifted, repaired}` |
| `km_invite` | steward/owner | `email`, `role` member/steward/owner. Link-only delivery (`accept_url`, expiry). No SMTP in v0.1 |

If the tool returns a role error, stop and tell the user they need steward/owner. Do not retry as a different identity.

## Rules

- Git is canonical. Reindex repairs the disposable index; it does not rewrite history.
- Report drift plainly (`head_sha` vs `indexed_sha`).
- Invites are links. Hand the URL to the human; do not invent email send.
