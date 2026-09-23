import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { runCli } from "../../plugins/kxm/src/cli.ts";
import { WORKFLOW_TEMPLATES } from "../../plugins/kxm/src/workflow-manager.ts";

async function validate(root: string, file: string, env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["gate", "validate", "--json", "--file", file], {
    KXM_LOGS_DIR: join(root, "logs"), KXM_STATE_HOME: join(root, "state"), ...env,
  }, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  }, root);
  return { code, payload: JSON.parse(code === 0 ? stdout : stderr), output: stdout + stderr };
}

test("gate validate accepts installed workflow YAML and rejects obsolete roles and broken transitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-validate-local-"));
  try {
    const file = join(root, "implement-and-verify.yaml");
    const template = WORKFLOW_TEMPLATES["implement-and-verify"]!;
    writeFileSync(file, stringify(template));
    const valid = await validate(root, file);
    assert.equal(valid.code, 0, valid.output);
    assert.deepEqual(valid.payload.workflows, [{ id: "implement-and-verify", schema: "kxm.workflow.v1" }]);

    const obsolete = structuredClone(template) as { steps: Array<Record<string, unknown>> };
    delete obsolete.steps[0]!.agent;
    obsolete.steps[0]!.role = "writer";
    writeFileSync(file, stringify(obsolete));
    const invalidSchema = await validate(root, file);
    assert.equal(invalidSchema.code, 1);
    assert.equal(invalidSchema.payload.ok, false);
    assert.match(invalidSchema.payload.error, /agent|role/);

    const broken = structuredClone(template) as { steps: Array<Record<string, unknown>> };
    broken.steps[0]!.on = { passed: "missing-step" };
    writeFileSync(file, stringify(broken));
    const invalidTransition = await validate(root, file);
    assert.equal(invalidTransition.code, 1);
    assert.equal(invalidTransition.payload.ok, false);
    assert.match(invalidTransition.payload.error, /missing-step/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate validate applies the runner restricted YAML profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-validate-alias-"));
  try {
    const file = join(root, "aliased.yaml");
    writeFileSync(file, "schema: kxm.workflow.v1\ncoordinator: &agent coordinator\ncopy: *agent\n");
    const result = await validate(root, file);
    assert.equal(result.code, 1);
    assert.match(result.payload.error, /anchor|alias/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate validate preserves webhook JSON secret validation without disclosing secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-validate-webhook-"));
  try {
    const file = join(root, "webhooks.json");
    writeFileSync(file, readFileSync(resolve("examples/provenance-workflow.json")));
    const secret = "validation-test-secret-never-print";
    const valid = await validate(root, file, { KXM_WORKFLOW_SECRET: secret });
    assert.equal(valid.code, 0, valid.output);
    assert.equal(valid.payload.workflows[0].secretConfigured, true);
    assert.equal(valid.output.includes(secret), false);
    const missing = await validate(root, file);
    assert.equal(missing.code, 1);
    assert.match(missing.payload.error, /secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
