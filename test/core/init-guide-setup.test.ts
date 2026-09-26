import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GUIDE_WORKFLOWS,
  parseGuideSelection,
  planGuideSetup,
  mergeGuideRouteAdmission,
  renderGuideSetupFiles,
  resolveCandidate,
  writeGuideSetupFiles,
} from "../../plugins/kxm/src/init-guide-setup.ts";
import { validateHarnessModelPair, type HarnessInventory, type HarnessStatus } from "../../plugins/kxm/src/harness.ts";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import { isRouteAdmitted } from "../../plugins/kxm/src/routes.ts";
import { parse } from "yaml";

function harnessStatus(id: string, authenticated: boolean | null, detected = true): HarnessStatus {
  return {
    id,
    label: id,
    default: id === "pi",
    mode: "either",
    detected,
    authenticated,
    canUpdate: { self: false, extensions: false, models: false },
    issues: [],
  };
}

function inventory(authenticated: readonly string[]): HarnessInventory {
  const ids = ["pi", "claude", "codex", "grok", "agy", "kimi", "deepseek"];
  return {
    defaultHarness: "pi",
    harnesses: ids.map((id) => harnessStatus(id, authenticated.includes(id) ? true : null, true)),
  };
}

test("parseGuideSelection accepts numbers, slugs, all, and none", () => {
  assert.deepEqual(parseGuideSelection("all"), GUIDE_WORKFLOWS.map((workflow) => workflow.slug));
  assert.deepEqual(parseGuideSelection("none"), []);
  assert.deepEqual(parseGuideSelection(""), []);
  assert.deepEqual(parseGuideSelection("1,3"), ["build-feature", "stabilize-flaky-tests"]);
  assert.deepEqual(parseGuideSelection("build-feature, design-software-system"), ["build-feature", "design-software-system"]);
  assert.deepEqual(parseGuideSelection("99, nope"), []);
});

test("resolveCandidate prefers an admitted harness in guide order", () => {
  const eligible = new Set(["grok"]);
  const binding = resolveCandidate(
    [{ vendor: "anthropic", model: "claude-fable-5.1" }, { vendor: "x-ai", model: "grok-4.6" }],
    eligible,
  );
  assert.deepEqual(binding, { harness: "grok", provider: "xai", model: "grok-4.6" });
});

test("resolveCandidate routes non-native vendors through pi/openrouter", () => {
  const binding = resolveCandidate([{ vendor: "qwen", model: "qwen3-coder-plus" }], new Set(["pi"]));
  assert.deepEqual(binding, { harness: "pi", provider: "openrouter", model: "qwen/qwen3-coder-plus" });
});

test("resolveCandidate fails closed for unadmitted ids", () => {
  assert.equal(resolveCandidate([{ vendor: "deepseek", model: "deepseek-v4-pro-0813" }], new Set(["pi"])), undefined);
  assert.equal(resolveCandidate([{ vendor: "x-ai", model: "grok-4.6" }], new Set(["pi"])), undefined);
  assert.equal(resolveCandidate([{ vendor: "qwen", model: "qwen3-coder-plus" }], new Set()), undefined);
  assert.equal(resolveCandidate([{ vendor: "anthropic", model: "claude-opus-5" }], new Set(["claude"])), undefined);
});

test("resolveCandidate skips Google: drive cannot reach antigravity and agy is not the decided route", () => {
  const all = new Set(["pi", "claude", "codex", "grok", "agy", "kimi", "deepseek"]);
  for (const model of ["gemini-3.8-flash", "gemini-3.8-flash-high"]) {
    assert.equal(resolveCandidate([{ vendor: "google", model }], all), undefined, model);
  }
  // A Google candidate ahead of an admitted one falls through to it.
  assert.deepEqual(
    resolveCandidate([{ vendor: "google", model: "gemini-3.8-flash" }, { vendor: "qwen", model: "qwen3-coder-plus" }], new Set(["pi"])),
    { harness: "pi", provider: "openrouter", model: "qwen/qwen3-coder-plus" },
  );
});

test("guided setup writes and admits no Google route, and every binding passes the harness/model check", () => {
  const plan = planGuideSetup({
    inventory: inventory(["pi", "claude", "codex", "grok", "agy", "kimi", "deepseek"]),
    selected: GUIDE_WORKFLOWS.map((workflow) => workflow.slug),
  });
  assert.ok(plan.agents.size > 0);
  for (const [role, binding] of plan.agents) {
    assert.notEqual(binding.provider, "antigravity", role);
    assert.notEqual(binding.harness, "agy", role);
    assert.deepEqual(validateHarnessModelPair(binding.harness, { provider: binding.provider, model: binding.model }), { valid: true }, role);
  }
  const root = mkdtempSync(join(tmpdir(), "kxm-guide-routes-"));
  try {
    const added = mergeGuideRouteAdmission(root, plan);
    assert.ok(added.length > 0);
    assert.deepEqual(added.filter((selector) => /^(antigravity|google)\//.test(selector)), []);
    assert.equal(isRouteAdmitted(root, "antigravity/gemini-3.8-flash-high"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planGuideSetup skips workflows with uncovered stages and reports reasons", () => {
  // claude only: build-feature stages without an admitted anthropic candidate
  // stay uncovered. stabilize's detective candidates are research ids that are
  // not admitted, so that workflow is skipped too.
  const plan = planGuideSetup({ inventory: inventory(["claude"]), selected: ["build-feature", "stabilize-flaky-tests"] });
  assert.ok(!plan.workflows.some((workflow) => workflow.slug === "build-feature"));
  assert.ok(!plan.workflows.some((workflow) => workflow.slug === "stabilize-flaky-tests"));
  assert.ok(plan.skipped.some((skip) => skip.workflow === "build-feature" && skip.role === "scaffold-build-specialist"));
  assert.equal(plan.agents.has("concurrency-flakiness-detective"), false);
});

test("rendered files load as a valid KXM project bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-guide-setup-"));
  try {
    const kxm = join(root, ".kxm");
    mkdirSync(join(kxm, "repo"), { recursive: true });
    writeFileSync(join(kxm, "project.yaml"), [
      "schema: kxm.project.v1",
      "id: kxmtest_prj-guide01",
      "name: guide-setup-test",
      "defaultWorkflow: default",
      "defaultExecutor: local",
      "defaultHarness: pi",
      "repositories:",
      "  - id: control",
      "    role: control",
      "    required: true",
      "    pathHint: .",
      "",
    ].join("\n"));
    writeFileSync(join(kxm, "repo", "repo.yaml"), [
      "schema: kxm.repository.v1",
      "projectId: kxmtest_prj-guide01",
      "repositoryId: control",
      "description: test",
      "defaultAccess: write",
      "",
    ].join("\n"));
    mkdirSync(join(kxm, "agents"), { recursive: true });
    writeFileSync(join(kxm, "agents", "coordinator.yaml"), [
      "schema: kxm.agent.v1",
      "purpose: coordinate the pinned workflow",
      "tools:",
      "  preset: coordinator",
      "defaultRepositoryAccess: read",
      "repositories:",
      "  control: read",
      "network: provider-only",
      "resultSchema: kxm.assignment-result.v1",
      "",
    ].join("\n"));
    mkdirSync(join(kxm, "workflows"), { recursive: true });
    writeFileSync(join(kxm, "workflows", "default.yaml"), [
      "schema: kxm.workflow.v1",
      "description: default",
      "coordinator: coordinator",
      "limits:",
      "  maxTransitions: 4",
      "steps:",
      "  - id: implement",
      "    kind: agent",
      "    agent: coordinator",
      "    maxAttempts: 1",
      "    on:",
      "      passed:",
      "        target: $terminal",
      "        terminalStatus: completed",
      "      failed:",
      "        target: $terminal",
      "        terminalStatus: failed",
      "",
    ].join("\n"));

    const plan = planGuideSetup({ inventory: inventory(["claude", "grok", "pi"]), selected: ["build-feature"] });
    const files = renderGuideSetupFiles(root, plan);
    assert.ok(files.some((file) => file.path.endsWith(join("agents", "lead-systems-planner.yaml"))));
    assert.ok(files.some((file) => file.path.endsWith(join("workflows", "build-feature.yaml"))));
    const report = writeGuideSetupFiles(files);
    assert.equal(report.existed.length, 0);
    assert.equal(report.written.length, files.length);

    const bundle = loadKxmProject(root);
    assert.equal(bundle.agents.has("lead-systems-planner"), true);
    const lead = bundle.agents.get("lead-systems-planner")?.value as { model?: { provider?: string; model?: string } };
    assert.equal(lead.model?.provider, "anthropic");
    assert.equal(lead.model?.model, "fable");

    const workflow = bundle.workflows.get("build-feature");
    const workflowValue = workflow?.value as { steps?: unknown[] } | undefined;
    assert.equal(workflowValue?.steps?.length, 6);
    const doc = parse(readFileSync(join(kxm, "workflows", "build-feature.yaml"), "utf8")) as { steps: Array<{ agent: string }> };
    assert.deepEqual(doc.steps.map((step) => step.agent), [
      "lead-systems-planner",
      "spec-contract-generator",
      "scaffold-build-specialist",
      "backend-data-implementer",
      "frontend-fullstack-implementer",
      "sdk-integration-specialist",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeGuideSetupFiles never overwrites existing files", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-guide-setup-"));
  try {
    const plan = planGuideSetup({ inventory: inventory(["claude", "grok"]), selected: ["maintain-documentation"] });
    const files = renderGuideSetupFiles(root, plan);
    assert.ok(files.length > 0);
    const first = writeGuideSetupFiles(files);
    assert.equal(first.written.length, files.length);
    const marker = join(root, ".kxm", "agents", "documentation-writer.yaml");
    writeFileSync(marker, "marker: keep-me\n");
    const second = writeGuideSetupFiles(files);
    assert.ok(second.existed.includes(marker));
    assert.equal(readFileSync(marker, "utf8"), "marker: keep-me\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi guide models hash .kxm/project.yaml and omit origin when that file is absent", () => {
  const plan = planGuideSetup({ inventory: inventory(["claude", "grok", "pi"]), selected: ["build-feature"] });
  const piBindings = [...plan.agents.values()].filter((binding) => binding.harness === "pi");
  assert.ok(piBindings.length > 0);
  const piModels = (root: string) => renderGuideSetupFiles(root, plan).filter((file) => file.path.endsWith(".yaml") && file.path.includes(`${join("models", "")}`) && file.content.includes("harness: pi"));
  const bare = mkdtempSync(join(tmpdir(), "kxm-guide-origin-bare-"));
  try {
    const without = piModels(bare);
    assert.ok(without.length > 0);
    for (const file of without) assert.equal(file.content.includes("origin:"), false, file.path);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  const root = mkdtempSync(join(tmpdir(), "kxm-guide-origin-"));
  try {
    const projectYaml = join(root, ".kxm", "project.yaml");
    mkdirSync(join(root, ".kxm"), { recursive: true });
    writeFileSync(projectYaml, "schema: kxm.project.v1\nid: guide-origin\n");
    const digest = createHash("sha256").update(readFileSync(projectYaml)).digest("hex");
    const withOrigin = piModels(root);
    assert.ok(withOrigin.length > 0);
    for (const file of withOrigin) {
      assert.match(file.content, /source: \.kxm\/project\.yaml/);
      assert.match(file.content, new RegExp(digest));
      for (const binding of piBindings) {
        const invented = createHash("sha256").update(`${binding.provider}/${binding.model}`).digest("hex");
        assert.equal(file.content.includes(invented), false);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guide agents are not written when no harness is authenticated", () => {
  const plan = planGuideSetup({ inventory: inventory([]), selected: ["stabilize-flaky-tests"] });
  assert.equal(plan.agents.size, 0);
  assert.equal(plan.workflows.length, 0);
  assert.ok(plan.skipped.length > 0);
  const files = renderGuideSetupFiles(join("/tmp", "unused"), plan);
  assert.equal(files.length, 0);
});

test("mergeGuideRouteAdmission appends admitted selectors without writing role files", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-guide-routes-"));
  try {
    const plan = planGuideSetup({ inventory: inventory(["grok"]), selected: ["maintain-documentation"] });
    assert.equal(plan.workflows.length, 0, "documentation-write is covered by grok, but the other stages are not");
    const writer = planGuideSetup({ inventory: inventory(["claude", "grok"]), selected: ["maintain-documentation"] });
    const added = mergeGuideRouteAdmission(root, writer);
    assert.ok(added.includes("anthropic/fable"));
    assert.ok(added.includes("xai/grok-4.6"));
    assert.equal(isRouteAdmitted(root, "anthropic/fable"), true);
    assert.equal(isRouteAdmitted(root, "xai/grok-4.6"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
