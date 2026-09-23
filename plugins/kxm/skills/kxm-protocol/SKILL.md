---
name: kxm-protocol
description: KontextMind knowledge plane only, the separate kontext CLI and km_ tools, not KXM or this plugin's kxm_* tools. Explains KontextMind km_ tool contracts, KM-Session trailers, trust modes, and secret gates. Use only when the user names KontextMind, the kontext CLI, or a km_ tool.
license: Apache-2.0
compatibility: Any agent that can run a shell or MCP client. No vendor-only tools.
metadata:
  workflow: protocol
  version: "0.1.1"
  argument-hint: "[trailers|trust|gates|authz|webhooks]"
  complete: "trailers, trust, gates, authz, webhooks"
  suite: kxm
---

# kxm-protocol

Canonical docs live in `kontextmind/mind` — `docs/protocol.md`, `docs/session-spine.md`, `docs/consistency-contract.md`, `docs/webhooks.md`, `docs/hosted-auth.md`, `docs/trust-modes.md`, `docs/secret-gates.md`, `docs/authz-matrix.md`, `docs/threat-model.md`.

Protocol status — v0.1 pre-freeze. Additive changes only within a major.

## Transports

One dispatch, two doors.

- MCP Streamable HTTP `/mcp` — OAuth 2.1 (PKCE, DCR, RFC 8707 audience, consent, device grant).
- Native `POST /v1/call` body `{tool, args}` → `{ok, result}` (tool errors in `result.error`).

## Knowledge conventions

- Every knowledge response includes `commit_sha` + `indexed_at`.
- Git is canonical by commit SHA. The index is disposable.
- Drafts commit to inbox; promotion is a review-queue decision, not a PR barrage.

## Evidence spine

- Trailer name `KM-Session`. Spec in `docs/session-spine.md`.
- Join path is GitHub webhooks → `git_evidence`. Never accept self-reported evidence as proof.
- Agents can omit trailers. Forging trailers is a protocol break.

## Secret gates

Two deterministic server-side scans on append/checkpoint content. LLM redaction is extra, not sufficient. On a trip, resolve as `suspicious` and cite the rule, not the secret.

## Trust and authz

- Trust mode from `km_status` binds what search may return.
- Strict — verified only.
- Roles — member / steward / owner. `km_project_add` and `km_invite` are steward/owner.
- Isolation — RLS + claims. Never suggest bypassing tenant checks.

## Tool catalog (complete)

Knowledge — `km_search` `km_read` `km_list` `km_graph` `km_append` `km_review` `km_status` `km_chat`

Projects — `km_projects` `km_project_add` `km_reindex` `km_invite`

Work — `km_work_current` `km_work_update` `km_handoff_save` `km_handoff_load`

Intelligence — `km_insights`

## Autocomplete

Slash hint — `[trailers|trust|gates|authz|webhooks]`

Complete — `trailers, trust, gates, authz, webhooks`

Works on any harness. Catalog — `plugins/kxm/skills/hints.json`.
