# Security policy

## Supported versions

Security fixes are applied to the latest `0.3.x` release and the default branch. Older snapshots are not supported.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/kontextmind/pi-extensions/security/advisories/new) and include:

- affected version or commit;
- impact and realistic attack scenario;
- minimal reproduction steps;
- any proposed mitigation;
- whether the issue is already public.

Do not include real credentials, private prompts, personal data, or unrelated repository contents. You should receive an acknowledgement through GitHub's advisory workflow. Public disclosure should wait until a fix and release plan are agreed.

## Security model

The current hub provides:

- an administrative bearer token and optional per-project bearer tokens;
- ephemeral per-agent keys for agent-specific operations;
- project-scoped discovery and message visibility;
- loopback binding by default;
- refusal to bind beyond localhost without a token;
- bounded request bodies, message content, and hop counts;
- per-agent request rate limiting and stable request IDs;
- security response headers and generic public responses for internal errors;
- SHA-256 HMAC verification and stable-delivery deduplication for webhook workflows;
- structured logs that omit prompt and reply bodies.

It does not currently provide:

- per-user roles or external identity-provider integration;
- durable encrypted storage;
- end-to-end message encryption;
- public-internet hardening;
- distributed denial-of-service protection;
- guarantees that peer-provided content is safe or correct.

Authentication does not make a mesh message trustworthy. Agents must retain their normal permission, tool, filesystem, and secret-handling controls.

## Operator responsibilities

- Keep the hub on loopback whenever possible.
- Use a long random token and load it from a secret manager or protected environment.
- Use distinct project tokens when different teams share one hub.
- Protect and back up the SQLite database because it contains messages and agent credentials.
- Store webhook secrets in dedicated environment variables through `secretEnv`; do not commit them in workflow JSON.
- Restrict webhook ingress by TLS, network policy, and provider configuration even when signatures are enabled.
- Put TLS and network access controls in front of any non-loopback deployment.
- Rotate the token after suspected disclosure.
- Never expose the hub directly to the public internet.
- Keep Node.js, Pi, Claude Code, and this package updated.
