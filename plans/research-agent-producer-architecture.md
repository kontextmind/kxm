# Research: Agent, Producer, Writer, and Pi Architecture

Task: `task_f2d22a9993e4`

## Objective

Document and simplify the relationship between Hub agents, workflow producers,
roles, writers, harnesses, and gates. Determine whether Pi's current producer
restrictions remain necessary and define an evidence-based optimization path.

## Questions

- What is the minimum useful distinction between an agent identity and a
  producer execution mechanism?
- Which responsibilities belong to the Hub, Runtime supervisor, worker, native
  one-shot producer, and deterministic gate?
- Can the current role/producer/harness/model configuration be represented with
  fewer concepts without weakening fail-closed authorization?
- Why is Pi restricted to the admitted Qwen writer route?
- Should Pi remain restricted, or can it support additional roles/routes under
  the same controls as native harnesses?
- How do these boundaries behave on one host, multiple hosts, and SSH-connected
  agents?

## Required evidence

- Current source and configuration map for agents, roles, producers,
  harnesses, models, writers, and gates.
- Single-host and multi-host topology diagrams.
- Authentication, permission, cancellation, recovery, and provenance checks
  for each producer type.
- Side-by-side efficiency measurements using identical tasks, including
  context size, input/output/cache tokens, latency, billed or unknown cost,
  verification success, and rework.
- Explicit list of restrictions that are policy requirements versus accidental
  implementation coupling.

## Acceptance criteria

- Documentation uses one consistent glossary and includes diagrams.
- No producer route is broadened based solely on catalog presence or smoke
  success.
- A recommendation explains whether Pi restrictions should remain, change, or
  be removed, with required gates/tests for the chosen design.
- Any simplification preserves native-harness authentication, role/tool
  permissions, cancellation, recovery, provenance, and independent gates.
- Proposed changes identify migration risks and do not add legacy aliases.

## Release relationship

This is research and documentation work. It does not establish npm release
readiness. Release remains blocked until the repository passes `npm run verify`,
generated artifacts match source, required reviews pass, and the candidate is
accepted against the actual commit.
