# Security policy

## Supported versions

Security fixes are applied to the latest published release and the default branch. Older snapshots are not supported.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/kontextmind/kxm/security/advisories/new) and include:

- affected version or commit;
- impact and realistic attack scenario;
- minimal reproduction steps;
- any proposed mitigation;
- whether the issue is already public.

Do not include real credentials, private prompts, personal data, or unrelated repository contents. You should receive an acknowledgement through GitHub's advisory workflow. Public disclosure should wait until a fix and release plan are agreed.

## Security model

This section summarizes KXM's security model. The [trust model](docs/concepts/trust-model.md) explains every credential, what it can reach, and where each boundary stops. [Data and storage](docs/concepts/data-and-storage.md) lists what each store keeps and how long.

The current hub and Runtime provide:

- an administrative bearer token and optional per-project bearer tokens;
- per-agent keys, rotated at every registration, for agent-specific operations;
- hub credentials persisted with mode `0600` in the user state root, never in the project;
- project-scoped discovery, message visibility, and context requests;
- loopback binding by default, and refusal to bind beyond localhost without a token;
- a Runtime supervisor that listens only on `127.0.0.1` behind its own token;
- a Claude Code plugin whose MCP server and SessionStart hook never use the admin token;
- bounded request bodies, message content, and hop counts;
- per-agent request rate limiting and stable request IDs;
- security response headers and generic public responses for internal errors;
- SHA-256 HMAC verification and stable-delivery deduplication for webhook workflows;
- attempt-bound peer-message provenance, unique-producer quorum, and explicit admin-only degradation for configured workflow requirements;
- a context authority ceiling per origin, so peer, tool, and external content can never grant instructions or policy;
- structured hub logs that omit prompt and reply bodies, and an allowlisted, redacted Runtime-to-hub sync.

It does not currently provide:

- per-user roles or identity-provider integration inside the hub (hosted deployments authenticate browsers at a proxy; see [ADR-0004](docs/adr/ADR-0004-edge-identity-authentik.md));
- encryption of stored message bodies, prompts, evidence, or credentials;
- end-to-end message encryption;
- signed session tokens: local tool policy is a guardrail, not an authorization boundary;
- isolation between processes that run as the same OS user;
- public-internet hardening;
- distributed denial-of-service protection;
- guarantees that peer-provided content is safe or correct.

Peer quorum proves that the hub observed durable replies from the configured
producer identities for one exact workflow run, stage, requirement, and
attempt. It does not prove truth, response quality, model identity, independent
inference, non-collusion, or human approval. A project-token holder can register
a new agent or reclaim an offline agent name and its durable ID in that project,
so every holder of one shared project credential belongs to the same fully
trusted provenance domain.

Authentication does not make a peer message trustworthy. Agents must retain their normal permission, tool, filesystem, and secret-handling controls.

## Operator responsibilities

- Keep the hub on loopback whenever possible.
- Use a long random token and load it from a secret manager or protected environment.
- Use distinct project tokens when different teams share one hub, and list every project in `KXM_PROJECT_TOKENS` so the admin token stops working on agent routes.
- Reserve a distinct administrative token for admin routes; give agents only their explicit project token. Never give a workflow callback or peer the admin token.
- Set `KXM_AUTH_TOKEN` to the project token for Pi sessions and Pi workers. Without it, the Pi extension falls back to the admin token saved on the hub's machine.
- Protect and back up `.kxm/state/kxm.db` because it contains message bodies and agent keys.
- Protect the user state root: `hub-env.json` holds the raw admin and project tokens, and the Runtime stores hold run prompts and event payloads.
- Protect `.kxm/logs`; raw long-lived Pi process logs can contain model output, tool output, paths, and other sensitive operational data.
- Keep secrets out of tracked `.kxm/*.yaml` configuration and `.kxm/assets`; runtime logs, generated assets, and state must remain uncommitted.
- Store webhook secrets in dedicated environment variables through `secretEnv`; do not commit them in workflow JSON.
- Use a separate `signalSecretEnv` for callbacks and never put credentials, private prompts, or sensitive incident details in a degradation reason.
- Review every quorum degradation as a security-relevant decision. It must be declared by policy, limited to the current attempt, and followed by enough verified replies to meet the approved minimum.
- Enforce read-only reviewer and single-writer coordinator roles with `KXM_WORKER_TOOLS`; prompt instructions do not remove shell, edit, or write capabilities.
- Treat verified evidence snapshots as sensitive metadata. They omit message bodies but retain agent names/IDs, workflow scope, timestamps, and content hashes beyond normal terminal-message retention.
- Restrict webhook ingress by TLS, network policy, and provider configuration even when signatures are enabled.
- Put TLS and network access controls in front of any non-loopback deployment.
- Rotate the token after suspected disclosure.
- Never expose the hub directly to the public internet.
- Keep Node.js, Pi, Claude Code, and this package updated.
