# Repository Work Delivery Skill

## Purpose

`repo-work-delivery` is a reusable skill for converting an engineering request into an evidence-based, executable delivery prompt. It is designed for repository work that may need discovery, official documentation research, phased delivery, validation, pull requests, CI/review follow-through, policy-gated merge, and safe cleanup.

The canonical skill is located at:

```text
.agents/skills/repo-work-delivery/SKILL.md
```

## What it does

The skill requires the executor to:

- Inspect repository instructions, architecture, workflow guidance, CI, package manifests, and existing patterns.
- Identify material ambiguity and ask focused questions only when repository evidence cannot safely resolve it.
- Select the workflow recommended by the repository’s workflow guide.
- Assign explicit delivery roles, even when one agent performs several roles.
- Use a one-shot workflow only for genuinely small, low-risk, self-contained changes.
- Research fresh official documentation for every materially affected package, framework, SDK, platform, or API.
- Create and maintain a living Markdown plan for multi-phase work.
- Deliver buildable and testable phases with coherent commits and incremental pushes.
- Run targeted and broader validation, record commands and outcomes, and inspect the final diff for security issues.
- Create a pull request, monitor checks/reviews, apply only bounded low-risk fixes, and stop for user direction when scope or risk materially changes.
- Auto-merge only where explicit authorization and repository policy allow it.
- Clean up the workspace only after merge is verified and no local work can be lost.

## Workflow selection

The skill first reads the repository workflow guide. For KXM, that includes:

```text
.agents/skills/kxm-workflow/SKILL.md
```

It chooses the least complex safe workflow prescribed by that guidance.

### One-shot work

One-shot is suitable only when all of the following are true:

- Scope is narrow and unambiguous.
- The change is self-contained and can be validated as a single coherent unit.
- No migration, public contract, authorization/security, irreversible side effect, or production-rollout complexity is involved.
- No cross-service coordination is needed.
- Repository policy does not require a phased plan.

One-shot work still performs discovery, documentation research, focused validation, commit, push, and required PR work.

### Phased work

All other work uses a living plan. Each phase has an objective, owner role, dependencies, expected files, acceptance criteria, test commands, rollback notes when appropriate, commit boundary, and push requirement.

## Required role coverage

The generated prompt assigns relevant roles from this set:

| Role | Primary responsibility |
|---|---|
| Delivery lead | Scope, decisions, workflow, plan, and final reporting |
| Repository analyst | Architecture, instructions, existing patterns, affected paths |
| Documentation researcher | Fresh official package/API/framework evidence |
| Implementer | Minimal compatible code and configuration changes |
| Test engineer | Focused, regression, integration, and acceptance validation |
| Security reviewer | Secrets, dependencies, input handling, auth, and data-risk review |
| Release/CI owner | Required checks, CI monitoring, and safe remediation |
| Reviewer/merge steward | PR, review resolution, policy gates, merge, and cleanup |

## Gap questions

The skill asks the user only when unanswered details would materially affect behavior, scope, data/migration choices, permissions, external integrations, rollout, acceptance criteria, or merge authority. It does not ask for facts that can be established from the repository or official docs.

## Documentation standard

For material dependencies, research uses official maintainer or other authoritative primary documentation for the repository’s actual version. The plan or PR records the source, version/date where available, retrieval date, and decision supported.

## Merge and cleanup safety

Auto-merge happens only after explicit authorization or policy authorization, passing required checks, required approvals, resolved comments, clean security status, and compliance with branch protection.

After verified merge, cleanup is guarded by checks for a clean workspace and fully merged branch. It updates the default branch, removes only safe merged local branches/worktrees, prunes stale references, and never discards uncommitted or user-owned artifacts.

## Expected generated prompt sections

A prompt produced with this skill includes:

1. Desired outcome and acceptance criteria
2. Gap-resolution gate
3. Repository discovery
4. Workflow selection and rationale
5. Assigned roles
6. Fresh official documentation research
7. Scope, non-goals, assumptions, and constraints
8. Design and integration expectations
9. One-shot or phase plan
10. Tests and validation
11. Commit/push discipline
12. PR, CI/review monitoring, bounded remediation, and merge gate
13. Verified post-merge cleanup
14. Completion report
