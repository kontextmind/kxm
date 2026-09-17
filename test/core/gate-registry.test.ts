import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { loadKxmProject, KxmConfigError, KxmSchemaRegistry, type JsonObject, type KxmResourceKind, type KxmConfigOptions } from "../../plugins/kxm/src/project-config.ts";
import { compileKxmWorkflow, KxmEngineCompileError } from "../../plugins/kxm/src/engine-compile.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";
import { planKxmTemplateRepair } from "../../plugins/kxm/src/repair.ts";
import { computeKxmPermissionDiff, computeKxmResourcePermissionDiff } from "../../plugins/kxm/src/permission.ts";
import { kxmToolPolicyRevision } from "../../plugins/kxm/src/runtime-service.ts";
import { CURRENT_KXM_TEMPLATE_VARIANT, renderKxmTemplate, kxmContentSha256 } from "../../plugins/kxm/src/template.ts";

const command: JsonObject = { kind: "command", argv: ["npm", "test"], timeoutMs: 3_600_000 };
function validate(schemas: KxmSchemaRegistry, kind: KxmResourceKind, value: JsonObject, file: string): void {
  const issues = schemas.validate(kind, value, file);
  if (issues.length) throw new KxmConfigError(issues);
}
function registry(gates: JsonObject = { test: command }): JsonObject { return { schema: "kxm.gate-registry.v1", gates }; }
function workflow(step: JsonObject): JsonObject {
  return { schema: "kxm.workflow.v1", steps: [{ id: "check", on: { passed: { target: "$terminal", terminalStatus: "completed" } }, ...step }] };
}
function write(root: string, path: string, value: JsonObject): void { writeFileSync(join(root, path), stringify(value)); }
function withProject(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "kxm-gate-registry-"));
  try {
    const git = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    for (const [path, bytes] of renderKxmTemplate("prj_01JGATEREGISTRY00000000000", "Gate tests").files) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof KxmConfigError && error.issues.some((issue) => issue.code === code);
}

test("current template declares gates; loader never falls back to builtins or caller allowlists", () => {
  assert.equal(CURRENT_KXM_TEMPLATE_VARIANT, "v4-registry");
  withProject((root) => {
    assert.deepEqual(loadKxmProject(root).gateRegistry?.value, registry());
    const obsolete = { registeredGates: undefined } as unknown as KxmConfigOptions;
    assert.throws(() => loadKxmProject(root, obsolete), hasCode("registered_gates_removed"));
    assert.throws(() => initializeKxmProject(root, obsolete), hasCode("registered_gates_removed"));
    assert.throws(() => planKxmTemplateRepair(root, obsolete), hasCode("registered_gates_removed"));
    write(root, ".kxm/gates.yaml", registry({ reserved: { kind: "reserved" } }));
    assert.throws(() => loadKxmProject(root), hasCode("gate_unknown"));
    write(root, ".kxm/workflows/default.yaml", workflow({ kind: "gate", gate: "reserved" }));
    assert(loadKxmProject(root).gateRegistry, "reserved registration is configuration, not execution support");
    rmSync(join(root, ".kxm/gates.yaml"));
    assert.throws(() => loadKxmProject(root), hasCode("gate_registry_missing"));
    write(root, ".kxm/workflows/default.yaml", workflow({ kind: "agent", agent: "coordinator" }));
    assert.equal(loadKxmProject(root).gateRegistry, undefined, "no-gate projects need no registry");
    write(root, ".kxm/gates.yaml", { schema: "kxm.gates.v1", gates: { test: command } });
    assert.throws(() => loadKxmProject(root), KxmConfigError);
  });
});

test("registry schema closes definitions and bounds argv, timeouts, and artifact paths", () => {
  const schemas = new KxmSchemaRegistry();
  const check = (value: JsonObject) => validate(schemas, "gate-registry", value, ".kxm/gates.yaml");
  for (const definition of [command, { ...command, argv: ["/usr/bin/npm", "test"], timeoutMs: 2_147_483_647, cwd: "control" }, { kind: "artifacts-exist", paths: ["reviews/result.json"] }, { kind: "reserved" }]) {
    assert.doesNotThrow(() => check(registry({ test: definition })));
  }
  const invalid: JsonObject[] = [
    { ...command, argv: [] }, { ...command, argv: [""] }, { ...command, argv: ["npm", "a\0b"] },
    { ...command, argv: ["x".repeat(4097)] }, { ...command, argv: Array(65).fill("x") },
    ...[0, -1, 1.5, 2_147_483_648].map((timeoutMs) => ({ ...command, timeoutMs })),
    { ...command, shell: true }, { ...command, env: {} }, { ...command, cwd: "member" }, { ...command, expect: "fail" },
    { kind: "reserved", argv: ["npm"] }, { kind: "unknown" },
    { kind: "artifacts-exist", paths: [] }, { kind: "artifacts-exist", paths: ["a"], timeoutMs: 1000 },
    ...["/tmp/x", "../x", "a/../x", "a/./x", "a\\x", "C:/x", "a\0x", "a//x", "a/"].map((path) => ({ kind: "artifacts-exist", paths: [path] })),
  ];
  for (const definition of invalid) assert.throws(() => check(registry({ test: definition })), KxmConfigError, JSON.stringify(definition));
  assert.throws(() => check(registry({})), KxmConfigError);
  assert.throws(() => check(registry(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`g${i}`, command])))), KxmConfigError);
  assert.throws(() => check({ ...registry(), surprise: true }), KxmConfigError);
  withProject((root) => {
    for (const executable of ["./npm", "bin/npm", "bin\\npm", ".", ".."]) {
      write(root, ".kxm/gates.yaml", registry({ test: { ...command, argv: [executable] } }));
      assert.throws(() => loadKxmProject(root), hasCode("gate_executable_invalid"));
    }
  });
});

test("expect is gate-only and explicit, with brakes on old gate outcome spellings", () => {
  const compile = (value: JsonObject) => compileKxmWorkflow({ id: "case", value });
  const schemas = new KxmSchemaRegistry();
  const step: JsonObject = { kind: "gate", gate: "test" };
  for (const expect of [undefined, "pass", "fail"]) {
    const value = workflow({ ...step, ...(expect === undefined ? {} : { expect }) });
    validate(schemas, "workflow", value, "workflow.yaml");
    const compiled = compile(value).steps.check;
    assert(compiled?.kind === "gate");
    assert.equal(compiled.expect, expect ?? "pass");
  }
  for (const invalid of [{ ...step, expect: "typo" }, { ...step, expect: null }, { kind: "agent", agent: "coordinator", expect: "pass" }, { kind: "approval", expect: "fail" }]) {
    assert.throws(() => validate(schemas, "workflow", workflow(invalid), "workflow.yaml"), KxmConfigError);
    assert.throws(() => compile(workflow(invalid)), KxmEngineCompileError);
  }
  withProject((root) => {
    for (const outcome of ["implementation_failure", "repro_missing"]) {
      const value = workflow({ ...step, on: { passed: { target: "$terminal", terminalStatus: "completed" }, [outcome]: { target: "$terminal", terminalStatus: "failed" } } });
      write(root, ".kxm/workflows/default.yaml", value);
      assert.throws(() => loadKxmProject(root), hasCode("gate_outcome_renamed"));
      assert.throws(() => compile(value), KxmEngineCompileError);
      const agent = workflow({ ...(value.steps as JsonObject[])[0], kind: "agent", agent: "coordinator" });
      write(root, ".kxm/workflows/default.yaml", agent);
      assert.doesNotThrow(() => loadKxmProject(root));
      assert.doesNotThrow(() => compile(agent));
    }
  });
});

test("timeout narrowing remains fully hashed; gate changes and registry removal require review", () => {
  withProject((root) => {
    const base = loadKxmProject(root);
    write(root, ".kxm/gates.yaml", registry({ test: { ...command, timeoutMs: 1000 } }));
    const narrowed = loadKxmProject(root);
    const diff = computeKxmPermissionDiff(base, narrowed);
    assert.equal(diff.expansions.length, 0);
    assert.equal(diff.narrowings.length, 1);
    assert.notEqual(base.configRevision, narrowed.configRevision);
    assert.notEqual(kxmToolPolicyRevision(base), kxmToolPolicyRevision(narrowed));
    assert.notEqual(base.gateRegistry && kxmContentSha256(JSON.stringify(base.gateRegistry.value)), narrowed.gateRegistry && kxmContentSha256(JSON.stringify(narrowed.gateRegistry.value)));
    for (const gates of [{ test: { ...command, timeoutMs: 3_600_001 } }, { test: { ...command, argv: ["npm", "run", "check"] } }, { test: { ...command, cwd: "control" } }, { test: command, extra: { kind: "reserved" } }]) {
      write(root, ".kxm/gates.yaml", registry(gates));
      assert(computeKxmPermissionDiff(base, loadKxmProject(root)).requiresReview);
    }
    const removedGate = computeKxmResourcePermissionDiff("gate-registry", ".kxm/gates.yaml", registry({ test: command, extra: { kind: "reserved" } }), registry());
    assert(removedGate.some((change) => change.direction === "expansion"));
    write(root, ".kxm/workflows/default.yaml", workflow({ kind: "agent", agent: "coordinator" }));
    const withRegistry = loadKxmProject(root);
    rmSync(join(root, ".kxm/gates.yaml"));
    const removed = computeKxmPermissionDiff(withRegistry, loadKxmProject(root));
    assert(removed.expansions.some((change) => change.resource === ".kxm/gates.yaml"));
  });
  const base = workflow({ kind: "gate", gate: "test" });
  assert.equal(computeKxmResourcePermissionDiff("workflow", "w", base, workflow({ kind: "gate", gate: "test", expect: "pass" })).length, 0);
  assert(computeKxmResourcePermissionDiff("workflow", "w", base, workflow({ kind: "gate", gate: "test", expect: "fail" })).some((change) => change.direction === "expansion"));
});

test("historical template byte hashes and provenance remain unchanged", () => {
  const expected = JSON.parse(readFileSync(new URL("../fixtures/template-history.json", import.meta.url), "utf8")) as Record<string, { revision: string; files: Record<string, string> }>;
  for (const variant of ["v1", "v2", "v3-policy"] as const) {
    const rendered = renderKxmTemplate("prj_01JPROJECT00000000000000000", "Historical baseline", variant);
    assert.equal(rendered.templateRevision, expected[variant]?.revision);
    assert.deepEqual(Object.fromEntries([...rendered.files].map(([path, bytes]) => [path, kxmContentSha256(bytes)])), expected[variant]?.files);
  }
});
