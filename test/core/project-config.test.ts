import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  KxmConfigError,
  discoverGitRoot,
  discoverKxmProjectRoot,
  loadKxmProject,
  parseRestrictedYaml,
  planKxmInitialization,
} from "../../plugins/kxm/src/project-config.ts";
import { readKxmLocalBindings, kxmLocalBindingFile, withKxmLocalBindingLock } from "../../plugins/kxm/src/bindings.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";
import { kxmInitTransactionPath } from "../../plugins/kxm/src/repair.ts";
import { renderKxmTemplate, kxmContentSha256 } from "../../plugins/kxm/src/template.ts";

const fixture = resolve("examples/project");

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

// Historical repair fixtures retain the exact v1 renderer/provenance. The
// explicit registry is a separately reviewed project resource, not a fallback
// or a rewrite of the historical template's baseline.
function historicalRepairProject(root: string, options: { projectId: string; projectName: string; localStateRoot?: string }): void {
  for (const [path, bytes] of renderKxmTemplate(options.projectId, options.projectName, "v1").files) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  writeFileSync(join(root, ".kxm/gates.yaml"), "schema: kxm.gate-registry.v1\ngates:\n  test:\n    kind: command\n    argv: [npm, test]\n    timeoutMs: 3600000\n");
  loadKxmProject(root);
}

function issueCodes(error: unknown): string[] {
  assert(error instanceof KxmConfigError, `expected KxmConfigError, received ${String(error)}`);
  return error.issues.map((candidate) => candidate.code);
}

function issueFiles(error: unknown): string[] {
  assert(error instanceof KxmConfigError, `expected KxmConfigError, received ${String(error)}`);
  return error.issues.map((candidate) => candidate.file);
}

function snapshotFiles(root: string): Readonly<Record<string, string>> {
  if (!existsSync(root)) return {};
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, path);
      else result[path] = readFileSync(absolute).toString("base64");
    }
  };
  visit(root, "");
  return result;
}

test("production KXM loader discovers and resolves the complete fixture deterministically", () => {
  const root = temporaryFixture("kxm-discovery-");
  try {
    assert.equal(discoverKxmProjectRoot(join(root, "repositories", "api")), undefined, "member worktrees cannot inherit the control project root");
    const first = loadKxmProject(root);
    const second = loadKxmProject(root);
    assert.match(first.configRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.configRevision, second.configRevision);
    assert.equal(first.project.value.id, "prj_01JPROJECT00000000000000000");
    assert.deepEqual([...first.repositories.keys()].sort(), ["api", "control", "web"]);
    assert.deepEqual([...first.workflows.keys()].sort(), ["default", "fix", "improve"]);
    assert.equal(first.resources.length, 27);
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

test("KXM loader fails closed on schema, path, reference, and semantic errors", () => {
  const root = temporaryFixture("kxm-invalid-");
  try {
    const projectFile = join(root, ".kxm", "project.yaml");
    const originalProject = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, originalProject.replace("    pathHint: repositories/api", "    pathHint: repositories\\api"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).some((code) => code === "portable_path_invalid" || code === "schema_pattern"));
    writeFileSync(projectFile, originalProject);

    const agentFile = join(root, ".kxm", "agents", "planner.yaml");
    const originalAgent = readFileSync(agentFile, "utf8");
    writeFileSync(agentFile, `${originalAgent}unexpected: true\n`);
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("schema_additionalProperties"));
    writeFileSync(agentFile, originalAgent);

    const workflowFile = join(root, ".kxm", "workflows", "default.yaml");
    const originalWorkflow = readFileSync(workflowFile, "utf8");
    writeFileSync(workflowFile, originalWorkflow.replace("agent: planner", "agent: missing-agent"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("agent_unknown"));
    writeFileSync(workflowFile, originalWorkflow);

    const environmentFile = join(root, ".kxm", "project", "env.yaml");
    const originalEnvironment = readFileSync(environmentFile, "utf8");
    writeFileSync(environmentFile, originalEnvironment.replace("values:\n", "values:\n  LEAK: ghp_abcdefghijklmnopqrstuvwxyz123456\n"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("probable_secret_value"));
    writeFileSync(environmentFile, originalEnvironment);

    const critic1 = join(root, ".kxm", "agents", "critic-1.yaml");
    const critic2 = join(root, ".kxm", "agents", "critic-2.yaml");
    const critic3 = join(root, ".kxm", "agents", "critic-3.yaml");
    for (const file of [critic1, critic2, critic3]) {
      writeFileSync(file, `${readFileSync(file, "utf8").trimEnd()}\nmodel:\n  profile: critic-claude\n`);
    }
    const fixFile = join(root, ".kxm", "workflows", "fix.yaml");
    writeFileSync(fixFile, readFileSync(fixFile, "utf8").replace("      maximum: 3\n      maxParallel: 3\n", "      maximum: 3\n      maxParallel: 3\n      distinctBy:\n        - provider\n"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("model_diversity_impossible"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent file with model or harness is refused at load", () => {
  const root = temporaryFixture("kxm-retired-agent-route-");
  try {
    const implementer = join(root, ".kxm", "agents", "implementer.yaml");
    const planner = join(root, ".kxm", "agents", "planner.yaml");
    writeFileSync(implementer, `${readFileSync(implementer, "utf8").trimEnd()}\nharness: codex\n`);
    assert.throws(
      () => loadKxmProject(root),
      (error) => error instanceof KxmConfigError
        && error.issues.some((entry) => entry.code === "retired_agent_routing_fields" && entry.file.endsWith("implementer.yaml") && entry.message === "routing resolves from role; remove model and harness"),
    );
    writeFileSync(implementer, readFileSync(implementer, "utf8").replace("\nharness: codex\n", "\n"));
    writeFileSync(planner, `${readFileSync(planner, "utf8").trimEnd()}\nmodel:\n  provider: anthropic\n  model: fable\n`);
    assert.throws(
      () => loadKxmProject(root),
      (error) => error instanceof KxmConfigError
        && error.issues.some((entry) => entry.code === "retired_agent_routing_fields" && entry.file.endsWith("planner.yaml")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent or moa step that declares model is refused at load", () => {
  const root = temporaryFixture("kxm-step-model-");
  try {
    writeFileSync(join(root, ".kxm", "workflows", "model-step.yaml"), `schema: kxm.workflow.v1
description: Steps that still declare a model.
coordinator: coordinator
limits:
  maxTransitions: 4
steps:
  - id: write
    kind: agent
    agent: implementer
    model:
      provider: xai
      model: grok-4.6
    on:
      passed: panel
      failed:
        target: $terminal
        terminalStatus: failed
  - id: panel
    kind: moa
    agent: implementer
    model:
      provider: xai
      model: grok-4.6
    on:
      passed:
        target: $terminal
        terminalStatus: completed
      failed:
        target: $terminal
        terminalStatus: failed
`);
    assert.throws(
      () => loadKxmProject(root),
      (error) => error instanceof KxmConfigError
        && error.issues.filter((entry) => entry.code === "producer_route_unsupported").map((entry) => entry.message).sort().join("\n")
          === "panel model is not honored; remove model from the step\nwrite model is not honored; remove model from the step",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a roster entry whose model file is missing or unparseable is refused at load", () => {
  const root = temporaryFixture("kxm-roster-model-");
  try {
    writeFileSync(join(root, ".kxm", "roles", "experiment.yaml"), `schema: kxm.role.v2
id: experiment
purpose: experiment
permission: read-only
description: Roster brake.
roster:
  - route: absent
  - route: broken
`);
    writeFileSync(join(root, ".kxm", "models", "broken.yaml"), "a: [\n");
    assert.throws(
      () => loadKxmProject(root),
      (error) => error instanceof KxmConfigError
        && error.issues.filter((entry) => entry.code === "roster_model_unreadable").map((entry) => entry.message).sort().join("\n")
          === "roster route absent does not resolve to a readable .kxm/models/absent.yaml carrying harness\nroster route broken does not resolve to a readable .kxm/models/broken.yaml carrying harness",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an origin hash mismatch is refused by loadKxmProject", () => {
  const root = temporaryFixture("kxm-origin-mismatch-");
  try {
    const model = join(root, ".kxm", "models", "primary.yaml");
    writeFileSync(model, `${readFileSync(model, "utf8").trimEnd()}\norigin:\n  source: .kxm/project.yaml\n  sha256: ${"ab".repeat(32)}\n`);
    assert.throws(
      () => loadKxmProject(root),
      (error) => error instanceof KxmConfigError
        && error.issues.some((entry) => entry.code === "origin_hash_mismatch" && entry.message === "origin evidence hash does not match supplied bytes"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a leftover .kxm/roster.yaml is refused", () => {
  const root = temporaryFixture("kxm-retired-roster-");
  try {
    writeFileSync(join(root, ".kxm", "roster.yaml"), "schema: kxm.developer-roster.v1\nroutes: {}\n");
    assert.throws(
      () => loadKxmProject(root),
      (error) => error instanceof KxmConfigError
        && error.issues.some((entry) => entry.code === "retired_roster_file" && entry.message === "create the role and model files and delete roster.yaml"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy JSON in a bound member repository is refused before its resources are read", () => {
  // The control-root refusal alone was not a blanket refusal: a member worktree holding
  // legacy .kxm/config JSON still contributed authoritative repo.yaml/env.yaml. Covers
  // both ways a member root is resolved — portable pathHint and host-local binding.
  const root = temporaryFixture("kxm-member-legacy-");
  const external = mkdtempSync(join(tmpdir(), "kxm-member-legacy-external-"));
  try {
    const memberDir = join(root, "repositories", "api");
    mkdirSync(join(memberDir, ".kxm", "config"), { recursive: true });
    writeFileSync(join(memberDir, ".kxm", "config", "agents.json"), "[]\n");
    assert.throws(
      () => loadKxmProject(root),
      (error) => issueCodes(error).includes("legacy_state_unsupported")
        && issueFiles(error).some((file) => file.startsWith("api/")),
      "a portable pathHint member must not load with legacy JSON present",
    );

    rmSync(join(memberDir, ".kxm", "config"), { recursive: true, force: true });
    cpSync(memberDir, external, { recursive: true });
    rmSync(join(external, ".git"), { recursive: true, force: true });
    makeGitRoot(external);
    mkdirSync(join(external, ".kxm", "config"), { recursive: true });
    writeFileSync(join(external, ".kxm", "config", "gates.json"), "[]\n");
    assert.throws(
      () => loadKxmProject(root, { repositoryBindings: { api: external } }),
      (error) => issueCodes(error).includes("legacy_state_unsupported"),
      "an explicit host-local member binding must not load with legacy JSON present",
    );

    rmSync(join(external, ".kxm", "config"), { recursive: true, force: true });
    const clean = loadKxmProject(root, { repositoryBindings: { api: external } });
    assert.equal(clean.repositories.get("api")?.value.repositoryId, "api", "a clean member still loads");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("KXM loader requires exact repository bindings and supports explicit host-local paths", () => {
  const root = temporaryFixture("kxm-repository-");
  const external = mkdtempSync(join(tmpdir(), "kxm-external-repository-"));
  try {
    const repositoryFile = join(root, "repositories", "api", ".kxm", "repo", "repo.yaml");
    const originalRepository = readFileSync(repositoryFile, "utf8");
    rmSync(repositoryFile);
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("repository_definition_missing"));
    writeFileSync(repositoryFile, originalRepository.replace("repositoryId: api", "repositoryId: web"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("repository_binding_identity_mismatch"));
    writeFileSync(repositoryFile, originalRepository);
    assert.throws(() => loadKxmProject(root, { repositoryBindings: { control: external } }), (error) => issueCodes(error).includes("control_repository_binding_invalid"));

    const projectFile = join(root, ".kxm", "project.yaml");
    const project = readFileSync(projectFile, "utf8");
    writeFileSync(projectFile, project.replace("    pathHint: repositories/api\n", ""));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("repository_binding_missing"));

    cpSync(join(root, "repositories", "api"), external, { recursive: true });
    rmSync(join(external, ".git"), { recursive: true, force: true });
    assert.throws(
      () => loadKxmProject(root, { repositoryBindings: { api: external } }),
      (error) => issueCodes(error).includes("repository_git_root_invalid"),
    );
    makeGitRoot(external);
    const bound = loadKxmProject(root, { repositoryBindings: { api: external } });
    assert.equal(bound.repositories.get("api")?.value.repositoryId, "api");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("KXM init never persists an unverified explicit optional member binding", () => {
  const root = temporaryFixture("kxm-optional-binding-");
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-optional-state-"));
  const emptyMember = mkdtempSync(join(tmpdir(), "kxm-empty-member-"));
  try {
    const projectFile = join(root, ".kxm", "project.yaml");
    const project = readFileSync(projectFile, "utf8")
      .replace("    pathHint: repositories/api\n", "")
      .replace("  - id: api\n    role: member\n    required: true", "  - id: api\n    role: member\n    required: false");
    writeFileSync(projectFile, project);
    const bindingFile = kxmLocalBindingFile(root, { stateRoot });
    const unavailable = initializeKxmProject(root, {
      repositoryBindings: { api: join(emptyMember, "missing") },
      localStateRoot: stateRoot,
    });
    assert.equal(unavailable.action, "planned");
    assert(unavailable.plan.issues.some((candidate) => candidate.code === "repository_binding_unavailable"));
    assert.equal(existsSync(bindingFile), false);

    makeGitRoot(emptyMember);
    const undefinedRepository = initializeKxmProject(root, {
      repositoryBindings: { api: emptyMember },
      localStateRoot: stateRoot,
    });
    assert.equal(undefinedRepository.action, "planned");
    assert(undefinedRepository.plan.issues.some((candidate) => candidate.code === "repository_definition_missing"));
    assert.equal(existsSync(bindingFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(emptyMember, { recursive: true, force: true });
  }
});

test("KXM loader rejects portable member bindings through linked path components", () => {
  const root = temporaryFixture("kxm-linked-binding-");
  const external = mkdtempSync(join(tmpdir(), "kxm-linked-target-"));
  try {
    cpSync(join(root, "repositories", "api"), join(external, "api"), { recursive: true });
    symlinkSync(external, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("pathHint: repositories/api", "pathHint: linked/api"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("repository_binding_path_link"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("KXM workflow validation preserves model/tool ceilings and completed-path gates", () => {
  const root = temporaryFixture("kxm-ceilings-");
  try {
    const workflowFile = join(root, ".kxm", "workflows", "default.yaml");
    const originalWorkflow = readFileSync(workflowFile, "utf8");
    writeFileSync(workflowFile, originalWorkflow.replace("terminalStatus: failed", "terminalStatus: completed"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("required_step_bypass"));
    writeFileSync(workflowFile, originalWorkflow);

    writeFileSync(workflowFile, originalWorkflow.replace("    agent: planner\n", "    agent: planner\n    tools:\n      preset: read-only\n"));
    const plannerFile = join(root, ".kxm", "agents", "planner.yaml");
    const originalPlanner = readFileSync(plannerFile, "utf8");
    writeFileSync(plannerFile, originalPlanner.replace("  preset: read-only", "  preset: read-only\n  deny:\n    - bash"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("tool_scope_expansion"));
    writeFileSync(plannerFile, originalPlanner);

    writeFileSync(plannerFile, `${originalPlanner.trimEnd()}\nmodel:\n  provider: anthropic\n  model: fable\n`);
    writeFileSync(workflowFile, originalWorkflow.replace("    agent: planner\n", "    agent: planner\n    model:\n      provider: google\n      model: gemini-incompatible\n    assignments: {}\n"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("model_selector_incompatible"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KXM loader rejects workflow cycles without an effective per-edge bound", () => {
  const root = temporaryFixture("kxm-cycle-");
  try {
    const workflowFile = join(root, ".kxm", "workflows", "default.yaml");
    const workflow = readFileSync(workflowFile, "utf8");
    writeFileSync(workflowFile, workflow.replace("        target: implement\n        maxTransitions: 3", "        target: implement"));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("back_edge_unbounded"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("KXM init atomically creates a minimal project and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-init-"));
  const dryRoot = mkdtempSync(join(tmpdir(), "kxm-init-dry-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-init-state-"));
  try {
    makeGitRoot(root);
    makeGitRoot(dryRoot);
    const nested = join(dryRoot, "packages", "service");
    mkdirSync(nested, { recursive: true });
    const dry = initializeKxmProject(nested, { dryRun: true, projectName: "Ignored until apply" });
    assert.equal(dry.action, "planned");
    assert.equal(dry.plan.projectRoot, realpathSync.native(dryRoot));
    assert.equal(discoverKxmProjectRoot(dryRoot), undefined);

    const created = initializeKxmProject(root, {
      projectId: "prj_01JINITIALIZED0000000000000",
      projectName: "Initialized Project",
      localStateRoot: stateRoot,
    });
    assert.equal(created.action, "created");
    assert.equal(created.files.length, 12);
    assert.ok(created.files.includes(".kxm/routes.yaml"));
    assert.match(created.configRevision ?? "", /^sha256:[a-f0-9]{64}$/);
    const before = created.files.map((file) => readFileSync(join(root, ...file.split("/")), "utf8"));

    const repeated = initializeKxmProject(root, { localStateRoot: stateRoot });
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, created.configRevision);
    assert.deepEqual(created.files.map((file) => readFileSync(join(root, ...file.split("/")), "utf8")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dryRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("KXM template provenance supports conflict-free three-way repair and preserves user bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-repair-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-repair-state-"));
  const memberRoot = mkdtempSync(join(tmpdir(), "kxm-repair-member-"));
  try {
    makeGitRoot(root);
    makeGitRoot(memberRoot);
    historicalRepairProject(root, {
      projectId: "prj_01JREPAIRPROJECT00000000000",
      projectName: "Repair Project",
      localStateRoot: stateRoot,
    });
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace(
      "    pathHint: .\nworkspace:",
      "    pathHint: .\n  - id: api\n    role: member\n    required: true\nworkspace:",
    ));
    mkdirSync(join(memberRoot, ".kxm", "repo"), { recursive: true });
    const memberDefinition = [
      "schema: kxm.repository.v1",
      "projectId: prj_01JREPAIRPROJECT00000000000",
      "repositoryId: api",
      "defaultAccess: write",
      "",
    ].join("\n");
    writeFileSync(join(memberRoot, ".kxm", "repo", "repo.yaml"), memberDefinition);
    const provenanceFile = join(root, ".kxm", "template-provenance.yaml");
    assert.equal(loadKxmProject(root, { repositoryBindings: { api: memberRoot } }).templateProvenance?.schema, "kxm.template-provenance.v1");
    assert.match(readFileSync(provenanceFile, "utf8"), /templateRevision: sha256:[a-f0-9]{64}/);

    const implementerFile = join(root, ".kxm", "agents", "implementer.yaml");
    const customized = readFileSync(implementerFile, "utf8").replace(
      "Implement the approved change within the declared repository scope.",
      "Implement changes using the team's reviewed local conventions.",
    );
    writeFileSync(implementerFile, customized);
    const stateBeforeDryRun = snapshotFiles(stateRoot);
    const dry = initializeKxmProject(root, {
      dryRun: true,
      localStateRoot: stateRoot,
      templateVariant: "v2",
      repositoryBindings: { api: memberRoot },
    });
    assert.equal(dry.action, "planned");
    assert.equal(dry.repairPlan?.canApply, true);
    assert.equal(dry.repairPlan?.changes.find((change) => change.path.endsWith("coordinator.yaml"))?.classification, "template-only");
    assert.equal(dry.repairPlan?.changes.find((change) => change.path.endsWith("implementer.yaml"))?.classification, "user-only");
    assert.deepEqual(snapshotFiles(stateRoot), stateBeforeDryRun, "dry-run must not touch Runtime-local state");
    assert.equal(existsSync(kxmInitTransactionPath(root)), false);

    assert.throws(
      () => initializeKxmProject(root, {
        localStateRoot: stateRoot,
        templateVariant: "v2",
        repositoryBindings: { api: memberRoot },
        testFaultAt: "verified",
      }),
      /injected init fault/,
    );
    assert.equal(readKxmLocalBindings(root, { stateRoot })?.repositories.api, realpathSync.native(memberRoot));
    assert.equal(existsSync(kxmInitTransactionPath(root)), true);
    const repaired = initializeKxmProject(root, { localStateRoot: stateRoot });
    assert.equal(repaired.action, "resumed");
    assert.equal(readKxmLocalBindings(root, { stateRoot })?.repositories.api, realpathSync.native(memberRoot));
    assert.equal(readFileSync(implementerFile, "utf8"), customized, "user-only bytes must be preserved exactly");
    assert.match(readFileSync(join(root, ".kxm", "agents", "coordinator.yaml"), "utf8"), /validated, reviewable commands/);
    assert.equal(existsSync(kxmInitTransactionPath(root)), false);
    assert.equal(initializeKxmProject(root, { localStateRoot: stateRoot, templateVariant: "v2" }).action, "validated");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(memberRoot, { recursive: true, force: true });
  }
});

test("KXM template repair blocks overlapping edits and authority expansion without mutation", () => {
  const conflictRoot = mkdtempSync(join(tmpdir(), "kxm-repair-conflict-"));
  const policyRoot = mkdtempSync(join(tmpdir(), "kxm-repair-policy-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-repair-blocked-state-"));
  try {
    for (const root of [conflictRoot, policyRoot]) {
      makeGitRoot(root);
      historicalRepairProject(root, {
        projectId: root === conflictRoot ? "prj_01JREPAIRCONFLICT000000000" : "prj_01JREPAIRPOLICY00000000000",
        projectName: "Blocked Repair",
        localStateRoot: stateRoot,
      });
    }
    const coordinator = join(conflictRoot, ".kxm", "agents", "coordinator.yaml");
    const userBytes = readFileSync(coordinator, "utf8").replace(
      "Coordinate the pinned workflow and emit schema-validated commands.",
      "Coordinate using the user's custom reviewed instructions.",
    );
    writeFileSync(coordinator, userBytes);
    const conflict = initializeKxmProject(conflictRoot, { localStateRoot: stateRoot, templateVariant: "v2" });
    assert.equal(conflict.action, "planned");
    assert(conflict.repairPlan?.issues.some((issue) => issue.code === "template_repair_conflict"));
    assert.equal(readFileSync(coordinator, "utf8"), userBytes);
    assert.equal(existsSync(kxmInitTransactionPath(conflictRoot)), false);

    const policyCoordinator = join(policyRoot, ".kxm", "agents", "coordinator.yaml");
    const beforePolicy = readFileSync(policyCoordinator, "utf8");
    const policy = initializeKxmProject(policyRoot, { localStateRoot: stateRoot, templateVariant: "v3-policy" });
    assert.equal(policy.action, "planned");
    assert(policy.repairPlan?.issues.some((issue) => issue.code === "template_policy_review_required"));
    assert.equal(readFileSync(policyCoordinator, "utf8"), beforePolicy);
    assert.equal(existsSync(kxmInitTransactionPath(policyRoot)), false);
  } finally {
    rmSync(conflictRoot, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

function memberRepairJournal(root: string, stateRoot: string): void {
  // A bound member worktree plus a **real** interrupted repair journal. The template project
  // declares only the control repository, so the member is added the way the full fixture has
  // it — portable pathHint, its own Git root, matching projectId — before the repair is
  // interrupted. This is the intersection that used to be missing: a member's legacy JSON
  // falling through to `repair` is precisely what reaches lock acquisition.
  const projectId = "prj_01JMEMBERREPAIR0000000000";
  for (const [path, bytes] of renderKxmTemplate(projectId, "Member Repair", "v1").files) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  writeFileSync(join(root, ".kxm/gates.yaml"), "schema: kxm.gate-registry.v1\ngates:\n  test:\n    kind: command\n    argv: [npm, test]\n    timeoutMs: 3600000\n");
  cpSync(join(fixture, "repositories", "api", ".kxm"), join(root, "repositories", "api", ".kxm"), { recursive: true });
  makeGitRoot(join(root, "repositories", "api"));
  const projectFile = join(root, ".kxm", "project.yaml");
  writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace(
    "  - id: control\n    role: control\n    required: true\n    pathHint: .\n",
    "  - id: control\n    role: control\n    required: true\n    pathHint: .\n  - id: api\n    role: member\n    required: true\n    pathHint: repositories/api\n",
  ));
  const memberRepoFile = join(root, "repositories", "api", ".kxm", "repo", "repo.yaml");
  writeFileSync(memberRepoFile, readFileSync(memberRepoFile, "utf8").replace(/^projectId: .*$/m, `projectId: ${projectId}`), "utf8");
  assert.throws(
    () => initializeKxmProject(root, { localStateRoot: stateRoot, templateVariant: "v2", testFaultAt: "prepared" }),
    /injected init fault/,
    "an interrupted repair journal must exist before the legacy check",
  );
}

const EXPECTED_LEGACY_INPUT = {
  control: ".kxm/config/agents.json",
  member: "api/.kxm/config/agents.json",
} as const;

type LegacyCase = { kind: "repair" | "empty" | "member-repair"; location: "control" | "member"; dryRun: boolean };

test("legacy init preserves pending transactions and never acquires the mutation lock", () => {
  // Parameterized so no recovery route can quietly keep writing: a legacy tree must be
  // classified terminally — whether the legacy JSON sits in the control root or in a bound
  // member worktree, whether the pending journal is a real interrupted repair or an empty
  // transaction record, and in both dry-run and live. Nothing may change on disk and no
  // resume may be reported: `resumePending` / `transactionKind` are what reaching the
  // mutation lock would look like from here.
  //
  // The repair journal is built from the historical-template fixture, whose project declares
  // only the control repository — so the repair case is control-only and the member case runs
  // against the full fixture with an empty journal. The interrupted-create case (no
  // project.yaml, hence no bindings to resolve) is the next test.
  const cases: LegacyCase[] = [
    { kind: "empty", location: "control", dryRun: false },
    { kind: "empty", location: "control", dryRun: true },
    { kind: "empty", location: "member", dryRun: false },
    { kind: "empty", location: "member", dryRun: true },
    { kind: "repair", location: "control", dryRun: false },
    { kind: "repair", location: "control", dryRun: true },
    { kind: "member-repair", location: "member", dryRun: false },
    { kind: "member-repair", location: "member", dryRun: true },
  ];
  for (const { kind, location, dryRun } of cases) {
    const label = `kind=${kind} legacyIn=${location} dryRun=${dryRun}`;
    const stateRoot = mkdtempSync(join(tmpdir(), "kxm-legacy-matrix-state-"));
    try {
      const root = mkdtempSync(join(tmpdir(), "kxm-legacy-matrix-"));
      makeGitRoot(root);
      if (kind === "member-repair") {
        memberRepairJournal(root, stateRoot);
      } else if (kind === "repair") {
        historicalRepairProject(root, {
          projectId: "prj_01JLEGMATRIXREPAIR00000000",
          projectName: "Legacy Matrix",
          localStateRoot: stateRoot,
        });
        assert.throws(
          () => initializeKxmProject(root, { localStateRoot: stateRoot, templateVariant: "v2", testFaultAt: "prepared" }),
          /injected init fault/,
          `${label}: an interrupted repair journal must exist first`,
        );
      } else {
        cpSync(fixture, root, { recursive: true });
        makeGitRoot(join(root, "repositories", "api"));
        mkdirSync(kxmInitTransactionPath(root), { recursive: true });
      }
      try {
        assert.equal(existsSync(kxmInitTransactionPath(root)), true, `${label}: journal must exist to prove it survives`);
        const legacyDir = location === "control"
          ? join(root, ".kxm", "config")
          : join(root, "repositories", "api", ".kxm", "config");
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, "agents.json"), "[]\n");

        const projectBefore = snapshotFiles(root);
        const stateBefore = snapshotFiles(stateRoot);
        const result = initializeKxmProject(root, { localStateRoot: stateRoot, ...(dryRun ? { dryRun: true } : {}) });

        assert.equal(result.action, "planned", `${label}: legacy state is never applied`);
        assert.equal(result.plan.mode, "legacy", `${label}: any legacy input is terminal, not a repair`);
        assert.equal(result.resumePending, undefined, `${label}: a legacy tree must not be resumed`);
        assert.equal(result.transactionKind, undefined, `${label}: no transaction may be claimed`);
        // Exact identity, not a substring: a member path must stay repository-qualified so a
        // consumer can tell which worktree holds the legacy state, and the control root keeps
        // its project-relative form.
        assert.ok(
          result.plan.legacyInputs.includes(EXPECTED_LEGACY_INPUT[location]),
          `${label}: expected ${EXPECTED_LEGACY_INPUT[location]}, got ${JSON.stringify(result.plan.legacyInputs)}`,
        );
        assert.equal(
          existsSync(kxmInitTransactionPath(root)),
          true,
          `${label}: the pending journal must still be there — an empty directory left behind by cleanup would pass a snapshot check`,
        );
        assert.deepEqual(snapshotFiles(root), projectBefore, `${label}: the project tree must be untouched`);
        assert.deepEqual(snapshotFiles(stateRoot), stateBefore, `${label}: host-local state must be untouched`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }
});

test("KXM init leaves an interrupted create journal untouched in a legacy tree", () => {
  // Ordering guard: classification used to happen after the recovery branch, so a tree with
  // legacy .kxm/config JSON plus an interrupted create made init take the project mutation
  // lock and clean or resume the transaction while reporting mode "legacy" — writing files
  // it had just promised not to. The journal must survive byte-identical, and nothing else
  // may be created.
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-legacy-resume-state-"));
  const root = mkdtempSync(join(tmpdir(), "kxm-legacy-resume-"));
  try {
    makeGitRoot(root);
    assert.throws(
      () => initializeKxmProject(root, {
        projectId: "prj_01JLEGACYRESUME0000000000",
        projectName: "Legacy Resume",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    assert.equal(existsSync(kxmInitTransactionPath(root)), true, "the interrupted create must leave a journal");
    mkdirSync(join(root, ".kxm", "config"), { recursive: true });
    writeFileSync(join(root, ".kxm", "config", "agents.json"), "[]\n");

    const journalBefore = snapshotFiles(kxmInitTransactionPath(root));
    const result = initializeKxmProject(root, { localStateRoot: stateRoot });
    assert.equal(result.action, "planned");
    assert.equal(result.plan.mode, "legacy");
    assert.equal(result.resumePending, undefined, "a legacy tree must not be treated as a resumable transaction");
    assert.equal(result.transactionKind, undefined);
    assert.deepEqual(snapshotFiles(kxmInitTransactionPath(root)), journalBefore, "the journal must be left exactly as found");
    assert.equal(existsSync(join(root, ".kxm", "project.yaml")), false, "no project may be provisioned into a legacy tree");

    const dryRun = initializeKxmProject(root, { localStateRoot: stateRoot, dryRun: true });
    assert.equal(dryRun.action, "planned");
    assert.equal(dryRun.plan.mode, "legacy");
    assert.deepEqual(snapshotFiles(kxmInitTransactionPath(root)), journalBefore, "dry-run must not consume the journal either");
  } finally {
    for (const dir of [root, stateRoot]) rmSync(dir, { recursive: true, force: true });
  }
});

test("KXM init resumes pinned create and repair operations across injected crash points", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-resume-state-"));
  const roots: string[] = [];
  const linkedShadowTarget = mkdtempSync(join(tmpdir(), "kxm-linked-shadow-"));
  try {
    const createRoot = mkdtempSync(join(tmpdir(), "kxm-resume-create-"));
    roots.push(createRoot);
    makeGitRoot(createRoot);
    assert.throws(
      () => initializeKxmProject(createRoot, {
        projectId: "prj_01JRESUMECREATE00000000000",
        projectName: "Resume Create",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    assert.equal(existsSync(join(createRoot, ".kxm")), false);
    assert.equal(existsSync(kxmInitTransactionPath(createRoot)), true);
    const operationFile = join(kxmInitTransactionPath(createRoot), "operation.json");
    const preparing = JSON.parse(readFileSync(operationFile, "utf8")) as Record<string, unknown>;
    preparing.phase = "preparing";
    writeFileSync(operationFile, `${JSON.stringify(preparing, null, 2)}\n`);
    rmSync(join(kxmInitTransactionPath(createRoot), "targets", ".kxm", "agents", "coordinator.yaml"));
    const transactionBeforeDryRun = snapshotFiles(kxmInitTransactionPath(createRoot));
    const dry = initializeKxmProject(createRoot, { localStateRoot: stateRoot, dryRun: true });
    assert.equal(dry.resumePending, true);
    assert.equal(dry.transactionKind, "create");
    assert.deepEqual(snapshotFiles(kxmInitTransactionPath(createRoot)), transactionBeforeDryRun);
    const stagedShadow = join(kxmInitTransactionPath(createRoot), "shadow");
    rmSync(stagedShadow, { recursive: true, force: true });
    mkdirSync(join(linkedShadowTarget, ".kxm"));
    writeFileSync(join(linkedShadowTarget, ".kxm", "must-remain.txt"), "external\n");
    symlinkSync(linkedShadowTarget, stagedShadow, process.platform === "win32" ? "junction" : "dir");
    const resumedCreate = initializeKxmProject(createRoot, { localStateRoot: stateRoot });
    assert.equal(resumedCreate.action, "resumed");
    assert.equal(resumedCreate.transactionKind, "create");
    assert.equal(existsSync(kxmInitTransactionPath(createRoot)), false);
    assert.equal(readFileSync(join(linkedShadowTarget, ".kxm", "must-remain.txt"), "utf8"), "external\n");

    for (const fault of ["prepared", "first-resource", "provenance", "verified"] as const) {
      const root = mkdtempSync(join(tmpdir(), `kxm-resume-${fault}-`));
      roots.push(root);
      makeGitRoot(root);
      historicalRepairProject(root, {
        projectId: `prj_01JRESUME${fault.replace("-", "").toUpperCase()}00000000`,
        projectName: "Resume Repair",
        localStateRoot: stateRoot,
      });
      assert.throws(
        () => initializeKxmProject(root, { localStateRoot: stateRoot, templateVariant: "v2", testFaultAt: fault }),
        /injected init fault/,
      );
      assert.equal(existsSync(kxmInitTransactionPath(root)), true);
      if (fault === "prepared") {
        const pending = JSON.parse(readFileSync(join(kxmInitTransactionPath(root), "operation.json"), "utf8")) as { operationId: string };
        writeFileSync(join(root, ".kxm", "agents", `.kxm-repair-${pending.operationId}-00000000-0000-4000-8000-000000000000.tmp`), "partial");
      }
      const resumed = initializeKxmProject(root, { localStateRoot: stateRoot });
      assert.equal(resumed.action, "resumed");
      assert.equal(resumed.transactionKind, "repair");
      assert.match(readFileSync(join(root, ".kxm", "agents", "coordinator.yaml"), "utf8"), /validated, reviewable commands/);
      assert.equal(existsSync(kxmInitTransactionPath(root)), false);
    }

    const changedRoot = mkdtempSync(join(tmpdir(), "kxm-resume-concurrent-change-"));
    roots.push(changedRoot);
    makeGitRoot(changedRoot);
    historicalRepairProject(changedRoot, {
      projectId: "prj_01JRESUMECHANGED0000000000",
      projectName: "Resume Changed",
      localStateRoot: stateRoot,
    });
    assert.throws(
      () => initializeKxmProject(changedRoot, { localStateRoot: stateRoot, templateVariant: "v2", testFaultAt: "first-resource" }),
      /injected init fault/,
    );
    const changedCoordinator = join(changedRoot, ".kxm", "agents", "coordinator.yaml");
    const concurrentBytes = readFileSync(changedCoordinator, "utf8").replace(
      "Coordinate the pinned workflow and emit validated, reviewable commands.",
      "Concurrent user edit after the interrupted repair.",
    );
    writeFileSync(changedCoordinator, concurrentBytes);
    assert.throws(
      () => initializeKxmProject(changedRoot, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("repair_preimage_changed"),
    );
    assert.equal(readFileSync(changedCoordinator, "utf8"), concurrentBytes);
    assert.equal(existsSync(join(kxmInitTransactionPath(changedRoot), "backups", ".kxm", "agents", "coordinator.yaml")), true);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(linkedShadowTarget, { recursive: true, force: true });
  }
});

test("KXM recovery rejects forged operation targets and safely restarts temp-only preparation", () => {
  const forgedRoot = mkdtempSync(join(tmpdir(), "kxm-forged-operation-"));
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kxm-temp-operation-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-operation-state-"));
  try {
    makeGitRoot(forgedRoot);
    assert.throws(
      () => initializeKxmProject(forgedRoot, {
        projectId: "prj_01JFORGEDOPERATION000000000",
        projectName: "Forged Operation",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    const transaction = kxmInitTransactionPath(forgedRoot);
    const target = join(transaction, "targets", ".kxm", "agents", "coordinator.yaml");
    const expanded = readFileSync(target, "utf8").replace("repositories:\n  control: read", "repositories:\n  control: write");
    writeFileSync(target, expanded);
    const operationFile = join(transaction, "operation.json");
    const operation = JSON.parse(readFileSync(operationFile, "utf8")) as Record<string, unknown> & { files: Array<Record<string, unknown>> };
    const coordinator = operation.files.find((entry) => entry.path === ".kxm/agents/coordinator.yaml");
    assert(coordinator);
    coordinator.targetSha256 = kxmContentSha256(expanded);
    operation.planSha256 = kxmContentSha256(JSON.stringify({
      kind: operation.kind,
      projectRoot: operation.projectRoot,
      projectId: operation.projectId,
      projectName: operation.projectName,
      templateId: operation.templateId,
      sourceTemplateRevision: operation.sourceTemplateRevision,
      targetTemplateRevision: operation.targetTemplateRevision,
      repositoryBindings: operation.repositoryBindings,
      files: operation.files,
    }));
    writeFileSync(operationFile, `${JSON.stringify(operation, null, 2)}\n`);
    assert.throws(
      () => initializeKxmProject(forgedRoot, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("init_transaction_create_file_invalid"),
    );
    assert.equal(existsSync(join(forgedRoot, ".kxm")), false);

    makeGitRoot(temporaryRoot);
    const tempTransaction = kxmInitTransactionPath(temporaryRoot);
    mkdirSync(tempTransaction);
    writeFileSync(join(tempTransaction, ".operation-op_0123456789abcdef0123456789abcdef-00000000-0000-4000-8000-000000000000.tmp"), "partial");
    const dry = initializeKxmProject(temporaryRoot, { localStateRoot: stateRoot, dryRun: true });
    assert.equal(dry.resumePending, true);
    assert.equal(existsSync(tempTransaction), true);
    const restarted = initializeKxmProject(temporaryRoot, {
      projectId: "prj_01JTEMPRESTART000000000000",
      projectName: "Temp Restart",
      localStateRoot: stateRoot,
    });
    assert.equal(restarted.action, "created");
    assert.equal(existsSync(tempTransaction), false);
  } finally {
    rmSync(forgedRoot, { recursive: true, force: true });
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("KXM repair validates the complete shadow before changing project files", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-repair-shadow-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-repair-shadow-state-"));
  try {
    makeGitRoot(root);
    historicalRepairProject(root, {
      projectId: "prj_01JREPAIRSHADOW00000000000",
      projectName: "Shadow Validation",
      localStateRoot: stateRoot,
    });
    const coordinator = join(root, ".kxm", "agents", "coordinator.yaml");
    const coordinatorBefore = readFileSync(coordinator, "utf8");
    rmSync(join(root, ".kxm", "workflows", "default.yaml"));
    assert.throws(
      () => initializeKxmProject(root, { localStateRoot: stateRoot, templateVariant: "v2" }),
      (error) => issueCodes(error).some((code) => code === "workflow_unknown" || code === "default_workflow_unknown"),
    );
    assert.equal(readFileSync(coordinator, "utf8"), coordinatorBefore);
    assert.equal(existsSync(kxmInitTransactionPath(root)), false, "failed pre-application validation must remove its unused transaction");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("KXM loader rejects corrupt template provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-provenance-corrupt-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-provenance-state-"));
  try {
    makeGitRoot(root);
    initializeKxmProject(root, {
      projectId: "prj_01JPROVENANCE0000000000000",
      projectName: "Provenance",
      localStateRoot: stateRoot,
    });
    const file = join(root, ".kxm", "template-provenance.yaml");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, `# operator formatting\n${original}`);
    assert.equal(loadKxmProject(root).templateProvenance?.schema, "kxm.template-provenance.v1");
    const formattingPlan = initializeKxmProject(root, { dryRun: true, localStateRoot: stateRoot, templateVariant: "v2" });
    assert.equal(formattingPlan.repairPlan?.canApply, false);
    assert(formattingPlan.repairPlan?.issues.some((issue) => issue.code === "template_provenance_user_modified"));
    writeFileSync(file, original.replace(/templateRevision: sha256:[a-f0-9]{64}/, `templateRevision: sha256:${"0".repeat(64)}`));
    assert.throws(() => loadKxmProject(root), (error) => issueCodes(error).includes("template_provenance_revision_invalid"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("KXM init joins with atomic Runtime-local member bindings and reuses them idempotently", () => {
  const root = temporaryFixture("kxm-join-");
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-local-state-"));
  const linkedTarget = mkdtempSync(join(tmpdir(), "kxm-linked-state-"));
  const alternateStateRoot = mkdtempSync(join(tmpdir(), "kxm-alternate-state-"));
  try {
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("    pathHint: repositories/api\n", ""));
    const api = join(root, "repositories", "api");
    const bindingFile = kxmLocalBindingFile(root, { stateRoot });

    const unknown = initializeKxmProject(root, {
      repositoryBindings: { unknown: api },
      localStateRoot: stateRoot,
    });
    assert.equal(unknown.action, "planned");
    assert(unknown.plan.issues.some((candidate) => candidate.code === "repository_binding_unknown"));
    assert.equal(existsSync(bindingFile), false);
    assert.throws(
      () => initializeKxmProject(root, { repositoryBindings: { api }, localStateRoot: "relative-state" }),
      (error) => issueCodes(error).includes("local_state_root_not_absolute"),
    );
    withKxmLocalBindingLock(root, { stateRoot }, (lock) => {
      assert.throws(
        () => initializeKxmProject(root, { repositoryBindings: { api }, localStateRoot: alternateStateRoot }),
        (error) => issueCodes(error).includes("local_binding_lock_busy"),
      );
      assert.equal(existsSync(lock.file), true, "a contender must not remove the lock it did not acquire");
      assert.equal(existsSync(bindingFile), false);
    });
    assert.throws(
      () => initializeKxmProject(root, { repositoryBindings: { api, control: root }, localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("local_binding_repository_invalid"),
    );

    const dry = initializeKxmProject(root, {
      repositoryBindings: { api },
      localStateRoot: stateRoot,
      dryRun: true,
    });
    assert.equal(dry.action, "planned");
    assert.equal(dry.bindingsChanged, true);
    assert.equal(dry.localBindingFile, bindingFile);
    assert.equal(existsSync(bindingFile), false);

    const joined = initializeKxmProject(root, {
      repositoryBindings: { api },
      localStateRoot: stateRoot,
    });
    assert.equal(joined.action, "joined");
    assert.equal(joined.bindingsChanged, true);
    assert.equal(joined.localBindingFile, bindingFile);
    assert.equal(existsSync(bindingFile), true);
    assert.equal(readFileSync(projectFile, "utf8").includes(realpathSync.native(api)), false, "absolute bindings must not enter Git configuration");
    const record = readKxmLocalBindings(root, { stateRoot });
    assert.equal(record?.projectId, "prj_01JPROJECT00000000000000000");
    assert.deepEqual(record?.repositories, { api: realpathSync.native(api) });

    const repeated = initializeKxmProject(root, { localStateRoot: stateRoot });
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, joined.configRevision);
    const unchanged = initializeKxmProject(root, { repositoryBindings: { api }, localStateRoot: stateRoot });
    assert.equal(unchanged.action, "validated");
    assert.equal(unchanged.bindingsChanged, false);

    const validRecordText = readFileSync(bindingFile, "utf8");
    const invalidRecord = JSON.parse(validRecordText) as Record<string, unknown>;
    invalidRecord.unexpected = true;
    writeFileSync(bindingFile, `${JSON.stringify(invalidRecord)}\n`);
    assert.throws(
      () => initializeKxmProject(root, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("schema_additionalProperties"),
    );
    delete invalidRecord.unexpected;
    invalidRecord.projectId = "prj_01JOTHERPROJECT000000000000";
    writeFileSync(bindingFile, `${JSON.stringify(invalidRecord)}\n`);
    assert.throws(
      () => initializeKxmProject(root, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("local_binding_project_id_mismatch"),
    );

    writeFileSync(join(linkedTarget, "repository-bindings.json"), validRecordText);
    rmSync(dirname(bindingFile), { recursive: true, force: true });
    symlinkSync(linkedTarget, dirname(bindingFile), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => initializeKxmProject(root, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("local_binding_directory_invalid"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(linkedTarget, { recursive: true, force: true });
    rmSync(alternateStateRoot, { recursive: true, force: true });
  }
});

test("KXM project mutation lock rejects linked Git-metadata parents", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-lock-link-"));
  const linked = mkdtempSync(join(tmpdir(), "kxm-lock-link-target-"));
  try {
    makeGitRoot(root);
    symlinkSync(linked, join(root, ".git", "kxm"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => withKxmLocalBindingLock(root, {}, () => undefined),
      (error) => issueCodes(error).includes("project_operation_lock_parent_invalid"),
    );
    assert.equal(existsSync(join(linked, "project-operation-lock.sqlite")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("KXM initialization planning is read-only and classifies create, legacy, ready, and repair", () => {
  const createRoot = mkdtempSync(join(tmpdir(), "kxm-create-"));
  const legacyRoot = mkdtempSync(join(tmpdir(), "kxm-legacy-"));
  const readyRoot = temporaryFixture("kxm-ready-");
  const repairRoot = temporaryFixture("kxm-repair-");
  const nonGitRoot = mkdtempSync(join(tmpdir(), "kxm-non-git-"));
  const invalidGitRoot = mkdtempSync(join(tmpdir(), "kxm-invalid-git-"));
  cpSync(fixture, nonGitRoot, { recursive: true });
  mkdirSync(join(invalidGitRoot, ".git"));
  try {
    assert.equal(planKxmInitialization(createRoot).mode, "create");
    assert.equal(planKxmInitialization(nonGitRoot).mode, "repair", "valid YAML outside a Git root cannot become ready");
    assert.equal(discoverGitRoot(invalidGitRoot), undefined, "an empty .git marker is not a worktree");
    assert.throws(() => initializeKxmProject(invalidGitRoot, { dryRun: true }), (error) => issueCodes(error).includes("git_root_required"));

    mkdirSync(join(legacyRoot, ".kxm", "config"), { recursive: true });
    writeFileSync(join(legacyRoot, ".kxm", "config", "agents.json"), "[]\n");
    const migration = planKxmInitialization(legacyRoot);
    assert.equal(migration.mode, "legacy");
    assert.ok(
      migration.issues.some((issue) => issue.code === "legacy_state_unsupported"),
      "a legacy-only tree is reported as unsupported, never offered as a migration",
    );
    assert.deepEqual(migration.legacyInputs, [".kxm/config/agents.json"]);

    const nestedControlPath = join(readyRoot, "packages", "nested");
    mkdirSync(nestedControlPath, { recursive: true });
    const ready = planKxmInitialization(nestedControlPath);
    assert.equal(ready.mode, "ready");
    assert.equal(ready.changesRequired, false);
    assert.match(ready.configRevision ?? "", /^sha256:/);

    writeFileSync(join(repairRoot, ".kxm", "project.yaml"), "schema: kxm.project.v1\n");
    const repair = planKxmInitialization(repairRoot);
    assert.equal(repair.mode, "repair");
    assert.equal(repair.changesRequired, true);
    assert(repair.issues.length > 0);

    const nestedRepository = join(readyRoot, "nested-independent-repository");
    makeGitRoot(nestedRepository);
    assert.equal(discoverKxmProjectRoot(nestedRepository), undefined, "discovery must stop at the nested Git boundary");
    assert.equal(planKxmInitialization(nestedRepository).projectRoot, realpathSync.native(nestedRepository));

    mkdirSync(join(readyRoot, ".kxm", "config"), { recursive: true });
    writeFileSync(join(readyRoot, ".kxm", "config", "agents.json"), "[]\n");
    assert.throws(() => loadKxmProject(readyRoot), (error) => issueCodes(error).includes("legacy_state_unsupported"));
    assert.equal(planKxmInitialization(readyRoot).mode, "legacy", "a mixed YAML+legacy tree is unsupported, not migratable");
  } finally {
    for (const root of [createRoot, legacyRoot, readyRoot, repairRoot, nonGitRoot, invalidGitRoot]) rmSync(root, { recursive: true, force: true });
  }
});
