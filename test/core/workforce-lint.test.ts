import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lintWorkforce, lookupById, resetDeprecatedIdWarnings } from "../../plugins/kxm/src/workforce-names.mjs";

test("this checkout's workforce ids match the convention and the admitted list", () => {
  const report = lintWorkforce(process.cwd());
  assert.deepEqual(report.errors, [], report.errors.map((item) => `${item.file}: ${item.message}`).join("\n"));
  assert.deepEqual(report.warnings, [], report.warnings.map((item) => `${item.file}: ${item.message}`).join("\n"));
});

test("workforce lint reports admission, roster, unused route, and id failures", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workforce-lint-"));
  try {
    mkdirSync(join(root, ".kxm", "models"), { recursive: true });
    mkdirSync(join(root, ".kxm", "roles"), { recursive: true });
    mkdirSync(join(root, ".kxm", "agents"), { recursive: true });
    mkdirSync(join(root, ".kxm", "workflows"), { recursive: true });
    writeFileSync(join(root, ".kxm", "routes.yaml"), "schema: kxm.routes.v2\nadmitted:\n  - xai/grok-4.7\n  - anthropic/fable\n");
    writeFileSync(join(root, ".kxm", "models", "grok-native.yaml"), "schema: kxm.model.v2\nid: grok-native\nharness: grok\nmodel: grok-4.7\nvendor: xai\nstatus: admitted\npermissions:\n  - edit\n");
    writeFileSync(join(root, ".kxm", "models", "claude-opus.yaml"), "schema: kxm.model.v2\nid: claude-opus\nharness: claude\nmodel: opus\nvendor: anthropic\nstatus: admitted\npermissions:\n  - read-only\n");
    writeFileSync(join(root, ".kxm", "roles", "writer.yaml"), "schema: kxm.role.v2\nid: writer\npurpose: writer\npermission: edit\nroster:\n  - route: missing-route\n");
    writeFileSync(join(root, ".kxm", "agents", "implementer.yaml"), "schema: kxm.agent.v1\npurpose: write\nrole: writer\n");
    writeFileSync(join(root, ".kxm", "workflows", "custom.yaml"), "schema: kxm.workflow.v1\ncoordinator: implementer\nsteps:\n  - id: implement\n    kind: agent\n    agent: implementer\n");
    const report = lintWorkforce(root);
    const codes = report.errors.map((item) => item.code);
    assert.ok(codes.includes("route_id_convention"), codes.join(","));
    assert.ok(codes.includes("route_not_admitted"), codes.join(","));
    assert.ok(codes.includes("route_unknown"), codes.join(","));
    assert.ok(codes.includes("route_unused"), codes.join(","));
    assert.ok(codes.includes("agent_id_convention"), codes.join(","));
    assert.ok(codes.includes("workflow_id_convention"), codes.join(","));
    assert.ok(codes.includes("step_id_convention"), codes.join(","));
    assert.ok(report.warnings.some((item) => item.code === "admitted_unrouted" && item.message.includes("anthropic/fable")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old route id resolves only when the canonical file is the one present", () => {
  resetDeprecatedIdWarnings();
  const previous = process.env.KXM_QUIET_ALIASES;
  process.env.KXM_QUIET_ALIASES = "1";
  try {
    const canonical = [{ id: "grok-grok-4-7", aliases: ["grok-native"] }];
    const hit = lookupById(canonical, "grok-native", "route");
    assert.equal(hit?.record.id, "grok-grok-4-7");
    assert.equal(hit?.viaAlias, true);
    const oldOnly = [{ id: "grok-native", aliases: [] }];
    const kept = lookupById(oldOnly, "grok-native", "route");
    assert.equal(kept?.record.id, "grok-native");
    assert.equal(kept?.viaAlias, false);
    assert.equal(lookupById(canonical, "opus-claude", "route"), undefined);
  } finally {
    if (previous === undefined) delete process.env.KXM_QUIET_ALIASES;
    else process.env.KXM_QUIET_ALIASES = previous;
  }
});
