# Repository Work Delivery

## Purpose

Use this skill to turn a repository work request into a safe, evidence-based delivery prompt and execution plan. It discovers repository constraints, resolves material gaps, selects the repository-recommended workflow, assigns roles, researches affected APIs/packages from official current documentation, and drives a change through implementation, validation, pull request review, policy-gated merge, and safe cleanup.

## Core principles

- Repository instructions and workflow policy are authoritative.
- Ask focused questions only when missing information materially changes scope, risk, implementation, validation, ownership, deployment, or merge behavior.
- Prefer verified repository evidence and official primary documentation over assumptions.
- Do not let a prompt claim implementation details, APIs, package behavior, or workflow policy that have not been verified.
- Keep work independently buildable, testable, reviewable, and revertible.
- Never bypass protection rules, required approvals, required checks, security gates, or organization policy.
- Never discard uncommitted work during cleanup.

## Required inputs

Collect or determine:

- The work request and desired outcome
- Target repository, owner, default branch, and intended target branch
- Explicit constraints, target environments, rollout requirements, deadlines, and acceptance criteria
- Whether the user authorizes execution or only wants a generated prompt/plan

If a needed input is unknown, inspect repository materials first. Ask the user only if a safe answer cannot be derived.

## Phase 0: gap-resolution gate

Before generating a delivery prompt or changing code, identify material gaps. Inspect repository instructions, workflow guides, issue/PR context, code, package manifests, CI, and docs before asking questions.

Ask concise questions when any unresolved item would materially change the outcome:

- Desired user-visible or API behavior
- In-scope and out-of-scope boundaries
- Source of truth, ownership, data retention, migration, compatibility, security, privacy, or compliance decisions
- Target environments, rollout, rollback, observability, performance, or reliability constraints
- Required acceptance criteria and test expectations
- External dependencies, vendors, API versions, credentials, or permission constraints
- Merge authority, review requirements, and whether automatic merge is authorized by repository policy

Do not ask for facts that the repository or official documentation can establish. State verified defaults and assumptions. If an assumption is reversible and low-risk, record it; if it is material or irreversible, pause for a user decision.

## Phase 1: repository discovery

Read, in priority order when present:

- AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md, SECURITY.md, CODE_OF_CONDUCT.md
- Local instruction files in affected directories
- Workflow guides, runbooks, architecture docs, ADRs, plan conventions, release documentation, and existing similar work
- package manifests, lock files, tool versions, build scripts, test configuration, lint/typecheck configuration, CI workflows, branch protection guidance, and PR templates

For KXM repositories, inspect and apply `.agents/skills/kxm-workflow/SKILL.md` and relevant KXM skills. Treat the workflow guide as the first source for workflow selection and role vocabulary.

Produce an evidence-backed discovery summary:

- Repository architecture and affected boundaries
- Existing patterns to reuse
- Constraints and prohibited changes
- Build, test, lint, typecheck, security, and release commands
- Existing change/plan conventions
- Relevant workflow guide recommendation
- Existing PR and merge policy evidence

## Phase 2: workflow selection

Choose the workflow recommended by the repository workflow guide. If the guide offers multiple options, select the least complex workflow that safely satisfies the request and explain the selection.

### One-shot eligibility

Use a one-shot workflow only when all conditions are true:

- The change has a narrow, unambiguous scope
- It affects a small, coherent area
- It has no schema/data migration, public API contract, authorization/security, payment, irreversible external action, or production rollout complexity
- It does not need cross-service coordination
- It can be implemented, tested, reviewed, committed, and pushed as one independently valid change
- Required official documentation research is limited and complete
- Repository policy does not require a multi-stage plan

A one-shot workflow still requires discovery, targeted official documentation research, implementation, validation, a meaningful commit, push, and a PR when repository policy requires one.

Use a phased workflow for all other work. Do not choose one-shot merely to reduce documentation or validation effort.

## Phase 3: assign roles

The generated prompt must include explicit roles. Reuse repository-defined roles where available. Otherwise select only roles relevant to the change:

- Delivery lead: owns scope, workflow selection, gap resolution, plan status, and final report
- Repository analyst: maps architecture, instructions, existing patterns, and affected paths
- Documentation researcher: verifies current official API/package/framework documentation and versions
- Implementer: makes minimal compatible code and configuration changes
- Test engineer: defines and executes targeted, regression, integration, and acceptance tests
- Security reviewer: reviews secrets, authz/authn, inputs, dependencies, data handling, and unsafe side effects when relevant
- Release/CI owner: runs required validation, monitors checks, and handles safe CI remediation
- Reviewer/merge steward: prepares the PR, addresses review feedback, and merges only when policy gates allow

For one-shot work, roles can be performed by one agent but must remain explicitly listed. For phased work, assign roles by phase and identify handoffs.

## Phase 4: fresh documentation research

Identify all affected external APIs, SDKs, packages, frameworks, services, protocols, deployment platforms, and tool versions.

For each material dependency:

1. Read the version actually pinned or used by the repository.
2. Obtain fresh documentation from the official maintainer or authoritative primary source.
3. Capture the exact behaviors, deprecations, migration guidance, API contracts, security requirements, configuration rules, and testing guidance relevant to the request.
4. Record source title, URL, version/date when available, retrieval date, and the decision it supports.
5. Prefer existing repository abstractions when official documentation confirms they remain appropriate.

Do not rely on search snippets, stale memory, unofficial tutorials, generated summaries, or unverified examples for material implementation decisions.

## Phase 5: plan generation

For phased work, create a living Markdown plan in the repository’s established planning location and naming convention. In KXM, use `plans/` unless a more specific convention applies.

The plan must contain:

- Title, status, owner, branch, issue/PR links when known
- User request and measurable acceptance criteria
- Scope, non-goals, assumptions, open questions, and decisions
- Discovery findings and relevant repository paths
- Workflow selected and why
- Assigned roles and responsibilities
- Official documentation research log with citations/links
- Architecture/design decisions and compatibility strategy
- Dependency, migration, security, rollout, rollback, observability, and risk analysis when relevant
- Test matrix and commands
- Independently buildable/testable phases
- Completion checklists, commit SHAs, CI outcomes, review feedback, and change log
- Final validation and cleanup checklist

Every phase must have:

- Objective and expected changed files
- Role owner
- Preconditions and dependencies
- Implementation steps
- Acceptance criteria
- Targeted test commands
- Regression/security checks appropriate to risk
- Commit boundary and proposed commit message
- Push requirement
- Rollback or failure handling when applicable

## Phase 6: incremental implementation

For phased work:

1. Create a feature branch from the approved base branch.
2. Commit the initial plan first.
3. Implement one independently buildable/testable phase at a time.
4. Run the phase’s targeted tests before committing when practical.
5. Keep commits small, coherent, descriptive, and free of unrelated cleanup.
6. Update the living plan with progress, decisions, test outcomes, blockers, and commit SHA.
7. Push after every meaningful completed phase.
8. Never mark a phase complete until its stated acceptance criteria and required validation are satisfied.

For one-shot work, create one coherent implementation commit after targeted validation, then push it. Add a concise implementation note if repository convention requires it.

## Phase 7: validation

Run validation in increasing scope:

1. Formatting and static checks for changed files
2. Focused unit/component tests
3. Integration, contract, migration, or end-to-end tests when affected
4. Required lint, typecheck, build, security/dependency, and repository-wide checks
5. Manual or automated acceptance checks for user-visible behavior

Record every command and outcome. Do not report tests as passed unless actually run. Distinguish pre-existing failures from regressions introduced by the change.

Before a PR, inspect the diff for accidental files, generated artifacts, credentials, tokens, personal data, unrelated changes, or broken documentation. Run relevant secret scanning and follow repository security guidance.

## Phase 8: pull request and monitoring

Create a PR only after the branch is pushed and required pre-PR validation is complete. The PR body must include:

- Problem and intended outcome
- Workflow selected and whether one-shot or phased
- Architecture/design summary
- User-visible/API/data/security impact
- Plan path for phased work
- Official documentation consulted where material
- Tests and command outcomes
- Migration/rollback/rollout notes where applicable
- Known limitations, follow-ups, and review focus areas

Request automated review when available and appropriate. Monitor:

- Required CI/check runs
- Branch up-to-date requirements
- Review decisions and review comments
- Security/dependency alerts
- Merge conflicts

## Phase 9: bounded remediation

Automatically fix only issues that are directly attributable to the current change, clearly understood, low-risk, and within the approved scope.

For each remediation:

- Reproduce or understand the failure/review finding
- Make the smallest compatible fix
- Add or update a regression test when applicable
- Run focused validation and any affected broader checks
- Update the plan/change log for phased work
- Commit and push the fix

Pause and ask the user before expanding scope, changing architecture materially, modifying a public contract, altering security/permissions, changing migrations/data semantics, adding new external dependencies, overriding a review decision, or handling failures that appear unrelated or ambiguous.

## Phase 10: merge gate

Auto-merge is allowed only if all conditions are true:

- The user explicitly authorized automatic merge for this work, or repository automation policy independently authorizes it
- Branch protection and repository policy permit the selected merge method
- All required checks are successful
- Required reviews and approvals are present
- No unresolved review comments or change requests remain
- The branch is current with the base branch when required
- No unresolved security, dependency, or merge-conflict issue remains
- The PR scope still matches the approved request

Never bypass protection rules, force-push to evade checks, self-approve where prohibited, or merge after a material unresolved concern. If auto-merge is not authorized or permitted, report that the PR is ready and identify the remaining human action.

## Phase 11: post-merge cleanup

Run cleanup only after confirming the PR merged successfully and the merge commit/base branch reflects the intended changes.

Before cleanup:

- Confirm the local workspace has no uncommitted changes that would be lost
- Confirm the feature branch is fully merged
- Preserve any untracked or user-owned artifacts; do not delete them automatically
- Report any dirty state and pause for user direction

When safe and permitted:

1. Fetch/prune remotes
2. Switch/update the default branch
3. Remove the merged local feature branch
4. Remove only the corresponding worktree if it is clean and not in use
5. Prune stale remote-tracking references
6. Verify the workspace is on the updated default branch and clean

Do not delete remote branches unless repository policy, PR settings, or explicit authorization permits it. Report exactly what was cleaned and what was intentionally retained.

## Output contract: generated delivery prompt

When asked to create a prompt for repository work, generate a single self-contained prompt containing:

1. Request and desired outcome
2. Gap-resolution instructions
3. Repository discovery instructions
4. Selected workflow and rationale
5. Explicit assigned roles
6. Official documentation research requirements
7. Scope, non-goals, acceptance criteria, and constraints
8. Architecture/integration expectations
9. One-shot or phased delivery instructions
10. Living plan requirements for phased work
11. Test and validation matrix
12. Commit/push requirements
13. PR, CI/review monitoring, bounded remediation, and merge rules
14. Safe post-merge cleanup rules
15. Completion-report requirements

The prompt must tell the executor to state verified findings before implementation, distinguish facts from assumptions, ask material missing-information questions, and stop for user direction where required.

## Completion report

Report:

- Selected workflow and rationale
- Roles performed and handoffs
- Questions asked and decisions made
- Repository findings and official documentation consulted
- Plan path and status, when applicable
- Branch, commits, pushes, and PR link/status
- Changed files and rationale
- Validation commands and outcomes
- CI/review findings and remediations
- Merge status and policy gates
- Cleanup actions and any retained workspace state
- Remaining risks, limitations, or follow-ups
