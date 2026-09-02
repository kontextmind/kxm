import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  VnextConfigError,
  discoverGitRoot,
  discoverVnextProjectRoot,
  loadVnextProject,
  parseRestrictedYaml,
  planVnextInitialization,
} from "../plugins/kxm-mesh/src/vnext-config.ts";
import { initializeVnextProject } from "../plugins/kxm-mesh/src/vnext-init.ts";

const fixture = resolve("examples/vnext");

function makeGitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8", windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function temporaryFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cpSync(fixture, root, { recursive: true });
  makeGitRoot(root);
  makeGitRoot(join(root, "repositories", "api"));
  makeGitRoot(join(root, "repositories", "web"));
  return root;
}

function issueCodes(error: unknown): string[] {
  assert(error instanceof VnextConfigError, `expected VnextConfigError, received ${String(error)}`);
  return error.issues.map((candidate) => candidate.code);
}

test("production vNext loader discovers and resolves the complete fixture deterministically", () => {
  assert.equal(discoverVnextProjectRoot(join(fixture, "repositories", "api")), undefined, "a nested fixture is not the enclosing worktree's project root");
  const root = temporaryFixture("kxm-vnext-discovery-");
  try {
    assert.equal(discoverVnextProjectRoot(join(root, "repositories", "api")), undefined, "member worktrees cannot inherit the control project root");
    const first = loadVnextProject(root);
    const second = loadVnextProject(root);
    assert.match(first.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.configRevision, second.configRevision);
    assert.equal(first.project.value.id, "prj_01JPROJECT00000000000000000");
    assert.deepEqual([...first.repositories.keys()].sort(), ["api", "control", "web"]);
    assert.deepEqual([...first.workflows.keys()].sort(), ["default", "fix"]);
    assert.equal(first.resources.length, 21);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production restricted YAML parser rejects non-JSON and resource-exhaustion inputs", () => {
  assert.throws(() => parseRestrictedYaml("a: 1\na: 2\n", "duplicate"), (error) => issueCodes(error).includes("invalid_yaml"));
  assert.throws(() => parseRestrictedYaml("root: &root {value: 1}\ncopy: *root\n", "alias"), (error) => issueCodes(error).some((code) => code === "anchor_forbidden" || code === "alias_forbidden"));
  assert.throws(() => parseRestrictedYaml("value: !execute command\n", "tag"), (error) => issueCodes(error).some((code) => code === "invalid_yaml" || code === "yaml_warning" || code === "tag_forbidden"));
  assert.throws(() => parseRestrictedYaml("1: value\n", "key"), (error) => issueCodes(error).includes("non_string_key"));
  assert.throws(() => parseRestrictedYaml(new Uint8Array([0xff, 0xfe]), "utf8"), (error) => issueCodes(error).includes("invalid_utf8"));
  assert.throws(() => parseRestrictedYaml(`value: ${"x".repeat(70_000)}\n`, "scalar"), (error) => issueCodes(error).includes("scalar_limit"));
  assert.throws(() => parseRestrictedYaml("---\na: 1\n---\nb: 2\n", "documents"), (error) => issueCodes(error).includes("invalid_yaml"));
});

test("vNext loader fails closed on schema, path, reference, and semantic errors", () => {
  const root = temporaryFixture("kxm-vnext-invalid-");
  try {
    const projectFile = join(root, ".kxm", "project.yaml");
    const originalProject = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, originalProject.replace("    pathHint: repositories/api", "    pathHint: repositories\\api"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).some((code) => code === "portable_path_invalid" || code === "schema_pattern"));
    writeFileSync(projectFile, originalProject);

    const agentFile = join(root, ".kxm", "agents", "planner.yaml");
    const originalAgent = readFileSync(agentFile, "utf8");
    writeFileSync(agentFile, `${originalAgent}unexpected: true\n`);
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("schema_additionalProperties"));
    writeFileSync(agentFile, originalAgent);

    const workflowFile = join(root, ".kxm", "workflows", "default.yaml");
    const originalWorkflow = readFileSync(workflowFile, "utf8");
    writeFileSync(workflowFile, originalWorkflow.replace("agent: planner", "agent: missing-agent"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("agent_unknown"));
    writeFileSync(workflowFile, originalWorkflow);

    const environmentFile = join(root, ".kxm", "project", "env.yaml");
    const originalEnvironment = readFileSync(environmentFile, "utf8");
    writeFileSync(environmentFile, originalEnvironment.replace("values:\n", "values:\n  LEAK: ghp_abcdefghijklmnopqrstuvwxyz123456\n"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("probable_secret_value"));
    writeFileSync(environmentFile, originalEnvironment);

    const critic2 = join(root, ".kxm", "agents", "critic-2.yaml");
    const critic3 = join(root, ".kxm", "agents", "critic-3.yaml");
    writeFileSync(critic2, readFileSync(critic2, "utf8").replace("profile: critic-grok", "profile: critic-claude"));
    writeFileSync(critic3, readFileSync(critic3, "utf8").replace("profile: critic-gemini", "profile: critic-claude"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("model_diversity_impossible"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vNext loader requires exact repository bindings and supports explicit host-local paths", () => {
  const root = temporaryFixture("kxm-vnext-repository-");
  const external = mkdtempSync(join(tmpdir(), "kxm-vnext-external-repository-"));
  try {
    const repositoryFile = join(root, "repositories", "api", ".kxm", "repo", "repo.yaml");
    const originalRepository = readFileSync(repositoryFile, "utf8");
    rmSync(repositoryFile);
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("repository_definition_missing"));
    writeFileSync(repositoryFile, originalRepository.replace("repositoryId: api", "repositoryId: web"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("repository_binding_identity_mismatch"));
    writeFileSync(repositoryFile, originalRepository);
    assert.throws(() => loadVnextProject(root, { repositoryBindings: { control: external } }), (error) => issueCodes(error).includes("control_repository_binding_invalid"));

    const projectFile = join(root, ".kxm", "project.yaml");
    const project = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, project.replace("    pathHint: repositories/api\n", ""));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("repository_binding_missing"));

    cpSync(join(root, "repositories", "api"), external, { recursive: true });
    rmSync(join(external, ".git"), { recursive: true, force: true });
    assert.throws(
      () => loadVnextProject(root, { repositoryBindings: { api: external } }),
      (error) => issueCodes(error).includes("repository_git_root_invalid"),
    );
    makeGitRoot(external);
    const bound = loadVnextProject(root, { repositoryBindings: { api: external } });
    assert.equal(bound.repositories.get("api")?.value.repositoryId, "api");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("vNext loader rejects portable member bindings through linked path components", () => {
  const root = temporaryFixture("kxm-vnext-linked-binding-");
  const external = mkdtempSync(join(tmpdir(), "kxm-vnext-linked-target-"));
  try {
    cpSync(join(root, "repositories", "api"), join(external, "api"), { recursive: true });
    symlinkSync(external, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("pathHint: repositories/api", "pathHint: linked/api"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("repository_binding_path_link"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("vNext workflow validation preserves model/tool ceilings and completed-path gates", () => {
  const root = temporaryFixture("kxm-vnext-ceilings-");
  try {
    const workflowFile = join(root, ".kxm", "workflows", "default.yaml");
    const originalWorkflow = readFileSync(workflowFile, "utf8");
    writeFileSync(workflowFile, originalWorkflow.replace("terminalStatus: failed", "terminalStatus: completed"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("required_step_bypass"));
    writeFileSync(workflowFile, originalWorkflow);

    writeFileSync(workflowFile, originalWorkflow.replace("    agent: planner\n", "    agent: planner\n    tools:\n      preset: read-only\n"));
    const plannerFile = join(root, ".kxm", "agents", "planner.yaml");
    const originalPlanner = readFileSync(plannerFile, "utf8");
    writeFileSync(plannerFile, originalPlanner.replace("  preset: read-only", "  preset: read-only\n  deny:\n    - bash"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("tool_scope_expansion"));
    writeFileSync(plannerFile, originalPlanner);

    writeFileSync(workflowFile, originalWorkflow.replace("    agent: planner\n", "    agent: planner\n    model:\n      provider: google\n      model: gemini-incompatible\n    assignments: {}\n"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("model_selector_incompatible"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vNext loader rejects workflow cycles without an effective per-edge bound", () => {
  const root = temporaryFixture("kxm-vnext-cycle-");
  try {
    const workflowFile = join(root, ".kxm", "workflows", "default.yaml");
    const workflow = readFileSync(workflowFile, "utf8");
    writeFileSync(workflowFile, workflow.replace("        target: implement\n        maxTransitions: 3", "        target: implement"));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("back_edge_unbounded"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vNext init atomically creates a minimal project and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-vnext-init-"));
  const dryRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-init-dry-"));
  try {
    makeGitRoot(root);
    makeGitRoot(dryRoot);
    const nested = join(dryRoot, "packages", "service");
    mkdirSync(nested, { recursive: true });
    const dry = initializeVnextProject(nested, { dryRun: true, projectName: "Ignored until apply" });
    assert.equal(dry.action, "planned");
    assert.equal(dry.plan.projectRoot, realpathSync.native(dryRoot));
    assert.equal(discoverVnextProjectRoot(dryRoot), undefined);

    const created = initializeVnextProject(root, {
      projectId: "prj_01JINITIALIZED0000000000000",
      projectName: "Initialized Project",
    });
    assert.equal(created.action, "created");
    assert.equal(created.files.length, 5);
    assert.match(created.configRevision ?? "", /^sha256:[a-f0-9]{64}$/);
    const before = created.files.map((file) => readFileSync(join(root, ...file.split("/")), "utf8"));

    const repeated = initializeVnextProject(root);
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, created.configRevision);
    assert.deepEqual(created.files.map((file) => readFileSync(join(root, ...file.split("/")), "utf8")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dryRoot, { recursive: true, force: true });
  }
});

test("vNext initialization planning is read-only and classifies create, migrate, ready, and repair", () => {
  const createRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-create-"));
  const legacyRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-legacy-"));
  const readyRoot = temporaryFixture("kxm-vnext-ready-");
  const repairRoot = temporaryFixture("kxm-vnext-repair-");
  const nonGitRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-non-git-"));
  const invalidGitRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-invalid-git-"));
  cpSync(fixture, nonGitRoot, { recursive: true });
  mkdirSync(join(invalidGitRoot, ".git"));
  try {
    assert.equal(planVnextInitialization(createRoot).mode, "create");
    assert.equal(planVnextInitialization(nonGitRoot).mode, "repair", "valid YAML outside a Git root cannot become ready");
    assert.equal(discoverGitRoot(invalidGitRoot), undefined, "an empty .git marker is not a worktree");
    assert.throws(() => initializeVnextProject(invalidGitRoot, { dryRun: true }), (error) => issueCodes(error).includes("git_root_required"));

    mkdirSync(join(legacyRoot, ".kxm", "config"), { recursive: true });
    writeFileSync(join(legacyRoot, ".kxm", "config", "agents.json"), "[]\n");
    const migration = planVnextInitialization(legacyRoot);
    assert.equal(migration.mode, "migrate");
    assert.deepEqual(migration.legacyInputs, [".kxm/config/agents.json"]);

    const nestedControlPath = join(readyRoot, "packages", "nested");
    mkdirSync(nestedControlPath, { recursive: true });
    const ready = planVnextInitialization(nestedControlPath);
    assert.equal(ready.mode, "ready");
    assert.equal(ready.changesRequired, false);
    assert.match(ready.configRevision ?? "", /^sha256:/);

    writeFileSync(join(repairRoot, ".kxm", "project.yaml"), "schema: kxm.project.v1\n");
    const repair = planVnextInitialization(repairRoot);
    assert.equal(repair.mode, "repair");
    assert.equal(repair.changesRequired, true);
    assert(repair.issues.length > 0);

    const nestedRepository = join(readyRoot, "nested-independent-repository");
    makeGitRoot(nestedRepository);
    assert.equal(discoverVnextProjectRoot(nestedRepository), undefined, "discovery must stop at the nested Git boundary");
    assert.equal(planVnextInitialization(nestedRepository).projectRoot, realpathSync.native(nestedRepository));

    mkdirSync(join(readyRoot, ".kxm", "config"), { recursive: true });
    writeFileSync(join(readyRoot, ".kxm", "config", "agents.json"), "[]\n");
    assert.throws(() => loadVnextProject(readyRoot), (error) => issueCodes(error).includes("legacy_vnext_conflict"));
    assert.equal(planVnextInitialization(readyRoot).mode, "migrate");
  } finally {
    for (const root of [createRoot, legacyRoot, readyRoot, repairRoot, nonGitRoot, invalidGitRoot]) rmSync(root, { recursive: true, force: true });
  }
});
