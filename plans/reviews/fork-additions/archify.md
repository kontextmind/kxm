# archify → KXM audit

**Category:** architecture/workflow diagrams, artifact validation and portable skills.
**Relevance:** high for M7 operator/document features; medium for packaging lessons.
**Decision:** adapt the typed diagram/render/receipt pipeline into a KXM capability.
**Priority:** P2, after the existing M0 truthful-result and M1 package contracts.

Reviewed `kontextmind/archify` at `851b279f3710c3ed6f152f4b044a504ca4eb207c`
against KXM `5ff9f642e82d7a1e52aeab9245282d89560bb535`, rechecked as current
GitHub main. This is source analysis; no fork code, installation, browser or
renderer was executed. The fork's SKILL.md was inspected as product content,
not invoked as instructions for this audit.

## What is implemented and what KXM already has

Archify supplies JSON-based architecture, workflow, sequence, dataflow and
lifecycle diagrams, an HTML/SVG viewer, validation, delivery receipts, comparison
artifacts and optional browser capture. Its core skill package is private and
versioned `2.17.0-dev.1`; a separate DSH bundle is `@tt-a1i/archify-dsh` 0.2.0.
These are different distribution identities; the private core manifest is not
proof that a public `npm install archify` will install the reviewed source.
[Core package](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/package.json#L1-L39),
[DSH package](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/integrations/deepseek-harness/package.json#L1-L44).

KXM already creates workflow DAG nodes and edges from its plan and runtime
state, and already publishes shared CLI/Runtime/extension/MCP entry points.
Its skill promotion has author/reviewer separation, evaluation requirements
and pinned content. Archify should enhance this model with readable artifacts,
not become the workflow engine or evidence authority.
[KXM DAG projection](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/studio-layout.ts#L145-L223),
[KXM skill promotion](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/skills.ts#L386-L451),
[KXM exports](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/package.json#L62-L79).

## Four improvements to take

### 1. Generate diagrams from typed KXM state — M7

Add an adapter from KXM's workflow/step/transition data into a diagram
specification. Use the existing command API to deliver a standalone artifact
through CLI, MCP, Pi or web. Keep stable node IDs so source links, comments and
diffs survive rerendering. Support sequence diagrams for harness handoff and
lifecycle diagrams for queued/running/waiting/failed/cancelled attempts.

Archify's CLI routes those diagram types and exposes structured validation;
KXM already owns the plan-to-DAG transformation. This makes a bounded adapter
more appropriate than asking each harness to redraw an unstructured diagram.
[Diagram CLI surface](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/bin/archify.mjs#L14-L29),
[KXM node/transition mapping](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/studio-layout.ts#L161-L223).

**Acceptance:** the same event snapshot yields the same semantic nodes and
transitions through every KXM surface; failed or cancelled steps never appear
successful; missing source/runtime evidence is visible. In particular, current
KXM DAG code labels a non-current step with a recorded attempt as `passed`.
Rendering more attractively must not entrench that shortcut: derive displayed
terminal states from actual terminal evidence, with a regression fixture.

### 2. Bind delivered diagrams to input and source revisions — M6/M7

Adapt Archify's source-reference checks and artifact receipt. Architecture
references require a full commit SHA, repository-relative paths, matching
repository context and existing blobs/line ranges. Delivery records hashes and
byte sizes for both specification and output. This provides useful provenance
for architecture reviews and proposal-versus-current comparisons.
[Repository evidence verification](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/renderers/shared/repository-evidence.mjs#L67-L146),
[Blob/line validation](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/renderers/shared/repository-evidence.mjs#L185-L231),
[Delivery receipt](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/bin/archify.mjs#L1076-L1119).

**Boundary:** these checks show that references exist at the specified revision;
they do not prove that an authored architecture claim is correct. Source-evidence
handling is currently architecture-specific. Do not advertise equivalent source
verification for all diagram types without adding it. KXM review and approval
remain separate from renderer validation.

**Acceptance:** a changed input/revision invalidates prior artifact evidence;
invalid paths/line ranges fail; source-linked and proposed-only diagrams have
distinct labels; internal repositories can retain local verification without
publishing sensitive source links. Use KXM's current SCM convention rather than
hard-coding the fork's public GitHub/Gitee link support as universal.

### 3. Preserve last-good output and distinguish automated visual checks — M7/M9

Archify renders a candidate, checks it, parses a receipt, and only then renames
the candidate to the requested output. Its browser check uses multiple sizes
and themes and has distinct pass/fail/skipped exit states. Adapt this flow for
KXM's diagram and document exports so a failed render cannot replace good
output or cause stale output to be reported as the new result.
[Candidate checking and receipt failure](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/bin/archify.mjs#L985-L1068),
[Validated delivery commit](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/bin/archify.mjs#L1121-L1162),
[Visual-check dimensions and statuses](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/archify/bin/visual-check.mjs#L11-L25).

**Acceptance:** failed validation preserves previous bytes, but the current
request reports failure; output and sidecar hashes agree; missing browser
runtime yields an explicit skipped/unavailable result; desktop/theme checks and
human visual review remain distinct. Treat interactive HTML as active content,
apply KXM artifact isolation/resource policy, and keep browser sandbox disabling
out of defaults. Reuse KXM's bounded process supervision for renderer/browser
invocations instead of copying synchronous helper calls into the hub hot path.
[KXM process limits](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/vnext-oneshot-process.ts#L25-L50).

### 4. Package complete skills with minimal host adapters — M1/M6/M9

Archify's staging script enumerates tracked files, requires generated validators
and notices, and rejects symlinks/non-regular source entries. Its DSH integration
resolves the installed skill root relative to the native profile. Those are
useful packaging patterns: a skill is its schemas, renderers, fonts, references
and checks, not only SKILL.md.
[Tracked staging requirements](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/scripts/stage-clean-skill.mjs#L9-L30),
[Staging path checks](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/scripts/stage-clean-skill.mjs#L94-L116),
[Profile-relative DSH skill lookup](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/integrations/deepseek-harness/lib/index.js#L1-L21).

KXM's current promotion writes SKILL.md and metadata into a patch. Extend the
existing M6 complete-bundle work and generator rather than creating an unrelated
installer for Archify. Do not inherit its independent update-notification flow
as an automatic KXM runtime action.
[Current promotion output](https://github.com/kontextmind/kxm/blob/5ff9f642e82d7a1e52aeab9245282d89560bb535/plugins/kxm/src/skills.ts#L427-L451).

**Acceptance:** the actual KXM tarball contains all selected companion assets;
host registration resolves them without a second extension install; checksum
changes invalidate the bundle; generated validators are current; native/Pi
activation runs against the packed artifact, not a development checkout.

## Runtime, setup and license implications

The inspected renderer is JavaScript and browser-based. It is a concrete example
of an advanced diagram feature fitting KXM's current runtime without requiring
Python or Rust. Optional browser capture/export still needs an appropriate
browser runtime and platform tests. No comparative performance claim follows
from this source audit.

Archify's own code is MIT, with notices for tt-a1i and Cocoon AI. Its
THIRD_PARTY_NOTICES separately identifies fonts and brand assets, including
individual share-alike/non-commercial terms; the root MIT license does not
relicense those assets. Preserve applicable notices and initially use neutral
shapes or a deliberately selected asset set for KXM redistribution.
[License](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/LICENSE#L1-L21),
[Asset-specific notices](https://github.com/kontextmind/archify/blob/851b279f3710c3ed6f152f4b044a504ca4eb207c/THIRD_PARTY_NOTICES.md#L1-L64).

**Verdict:** add source-bound diagram generation and verified artifact delivery
to M7, supported by M1/M6 packaging and M9 installed-host tests. It should be
one KXM diagram capability, with renderer receipts treated as scoped evidence
and existing workflow authority retained.
