# Role authority from the v2 policy draft

Status: open. Horizon: soon.

Source: `plans/plan-omp-config-alignment.md`.

Updated: 2026-09-28.

Promote the passive kxm.role.v2 and kxm.model.v2 draft to the single role authority, retire kxm.role.v1, routes.yaml roles, roster.yaml and the code defaults, give agents a role reference, then add the opt-in fallback walk, tool-policy enforcement, provenance, and effort validation.

## Tasks

### P1 promote the draft: schemas live, models and roles rewritten to v2, v1 deleted

`omp-p1`. Status: done. Detail: ready.

Template: [feature](../../templates/feature.md).

Done criterion: just verify green; every .kxm/roles and .kxm/models file validates through validatePolicyDraft with the developer ceilings; role list, get, add, modify, remove read and write v2 only.

Evidence needed: The validator test named in the P1 row and the CHANGELOG entry.

Plan section: plans/plan-omp-config-alignment.md#5-phases.

Evidence: `test/core/policy-draft.test.ts`.

### P2 cut the loader and engine over to the v2 files

`omp-p2`. Status: done. Detail: ready.

Template: [feature](../../templates/feature.md).

Done criterion: roster-policy.mjs and engine.ts read roles and routes from the v2 files at origin/main; roster.yaml and the justfile literals are gone.

Evidence needed: test/core/roster-policy.test.ts rewritten, one engine test per refusal path.

Plan section: plans/plan-omp-config-alignment.md#5-phases.

Evidence: `test/core/roster-policy.test.ts`.

### P3 tool policy enforcement

`omp-p3`. Status: done. Detail: ready.

Template: [feature](../../templates/feature.md).

Done criterion: A step whose tool preset is wider than its role permission is refused at load and again at dispatch, before a producer starts. Landed in #378, published v0.7.169.

Evidence needed: A fixture per preset pair.

Plan section: plans/plan-omp-config-alignment.md#5-phases.

Evidence: `test/core/engine.test.ts`.

### P4 opt-in fallback walk with route_switch events

`omp-p4`. Status: done. Detail: ready.

Template: [feature](../../templates/feature.md).

Done criterion: An attempt continues on the next admitted route when the role opts in, and the reports show the switch.

Evidence needed: Simulated 429 and transport fixtures.

Plan section: plans/plan-omp-config-alignment.md#5-phases.

Evidence: `test/core/route-fallback.test.ts`.

### P5 provenance and extends

Done criterion: Role files carry provenance and resolve extends.

Evidence needed: Unit tests.

### P6 effort catalog

Done criterion: Invalid efforts are rejected at edit time.

Evidence needed: Probe evidence under plans/evidence and a validator test.

### P7 quota-aware walk (optional)

Done criterion: Quota below reserve is an onError class.

Evidence needed: The usage-cost plan's gate.

## Blockers

None.

## Questions

- P2 landed in #343, P4 ships the error classifier with the walk, and P3 tool policy landed in #378 (v0.7.169). Section 7 still asks whether kxm plugin install --omp should write modelRoles from the role files. The engine can settle a real reviewer outcome (#363, #368). Backlog S33 records one truthful critic BLOCK on the vision lane. That settlement is not loop-dispatch.

[Dashboard](../dashboard.md)
