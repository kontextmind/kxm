# Studio screens for the shared hub

Status: later. Horizon: later.

Source: `plans/plan-studio-cloud-host.md`.

Updated: 2026-09-28.

Studio shows the seven dash panels, a first-run wizard, and live workflow state for the shared hub. Humans sign in at the edge. Policy edits become pull requests. The browser does not hold a hub token.

## Tasks

### S0 shared sequence gate with the first-run plan

Done criterion: The cloud-bind flag, the naming validator, and omp P3 through P7 are on main.

Evidence needed: The same commit or PR links recorded on the first-run plan.

### S1 read-only dash routes and S2 hub SSE fan-out

Done criterion: Seven routes render from a snapshot. The browser stream is same-origin SSE. A dropped hub stream sets transport to snapshot. Responses contain no admin token.

Evidence needed: studio-layout tests plus one Obscura test for the workflows route.

### S3 through S6 setup, policy PRs, bind, motion, and breakpoints

Done criterion: Wizard and doctor call the first-run CLI. Policy edits open a pull request. Bind never renders a token. Phone, tablet, and desktop widths pass Obscura checks, and reduced motion disables the dash animation.

Evidence needed: test/e2e cases at 390, 800, and 1280, and a secret-absence assertion.

## Blockers

- Shares the first-run sequence gate: the workforce-id naming validator and the hub cloud binding are on main and inventoried; omp-alignment P3, P5, P6, and P7 remain.
- Setup and doctor screens also wait on first-run P1 through P5.

## Questions

- Whether the hosted page stays kxm studio serve, or the portal keeps calling the CLI over guest exec.

[Dashboard](../dashboard.md)
