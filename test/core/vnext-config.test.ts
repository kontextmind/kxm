import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  VnextConfigError,
  discoverGitRoot,
  discoverVnextProjectRoot,
  inspectVnextCreateDestination,
  loadVnextProject,
  parseRestrictedYaml,
  planVnextInitialization,
} from "../../plugins/kxm/src/vnext-config.ts";
import { readVnextLocalBindings, vnextLocalBindingFile, withVnextLocalBindingLock } from "../../plugins/kxm/src/vnext-bindings.ts";
import { initializeVnextProject } from "../../plugins/kxm/src/vnext-init.ts";
import { vnextInitTransactionPath } from "../../plugins/kxm/src/vnext-repair.ts";
import { renderVnextTemplate, vnextContentSha256 } from "../../plugins/kxm/src/vnext-template.ts";

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

// Historical repair fixtures retain the exact v1 renderer/provenance. The
// explicit registry is a separately reviewed project resource, not a fallback
// or a rewrite of the historical template's baseline.
function historicalRepairProject(root: string, options: { projectId: string; projectName: string; localStateRoot?: string }): void {
  for (const [path, bytes] of renderVnextTemplate(options.projectId, options.projectName, "v1").files) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  writeFileSync(join(root, ".kxm/gates.yaml"), "schema: kxm.gate-registry.v1\ngates:\n  test:\n    kind: command\n    argv: [npm, test]\n    timeoutMs: 3600000\n");
  loadVnextProject(root);
}

function issueCodes(error: unknown): string[] {
  assert(error instanceof VnextConfigError, `expected VnextConfigError, received ${String(error)}`);
  return error.issues.map((candidate) => candidate.code);
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
    assert.deepEqual([...first.workflows.keys()].sort(), ["default", "fix", "improve"]);
    assert.equal(first.resources.length, 23);
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

test("vNext init never persists an unverified explicit optional member binding", () => {
  const root = temporaryFixture("kxm-vnext-optional-binding-");
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-optional-state-"));
  const emptyMember = mkdtempSync(join(tmpdir(), "kxm-vnext-empty-member-"));
  try {
    const projectFile = join(root, ".kxm", "project.yaml");
    const project = readFileSync(projectFile, "utf8")
      .replace("    pathHint: repositories/api\n", "")
      .replace("  - id: api\n    role: member\n    required: true", "  - id: api\n    role: member\n    required: false");
    writeFileSync(projectFile, project);
    const bindingFile = vnextLocalBindingFile(root, { stateRoot });
    const unavailable = initializeVnextProject(root, {
      repositoryBindings: { api: join(emptyMember, "missing") },
      localStateRoot: stateRoot,
    });
    assert.equal(unavailable.action, "planned");
    assert(unavailable.plan.issues.some((candidate) => candidate.code === "repository_binding_unavailable"));
    assert.equal(existsSync(bindingFile), false);

    makeGitRoot(emptyMember);
    const undefinedRepository = initializeVnextProject(root, {
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
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-init-state-"));
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
      localStateRoot: stateRoot,
    });
    assert.equal(created.action, "created");
    assert.equal(created.files.length, 7);
    assert.match(created.configRevision ?? "", /^sha256:[a-f0-9]{64}$/);
    const before = created.files.map((file) => readFileSync(join(root, ...file.split("/")), "utf8"));

    const repeated = initializeVnextProject(root, { localStateRoot: stateRoot });
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, created.configRevision);
    assert.deepEqual(created.files.map((file) => readFileSync(join(root, ...file.split("/")), "utf8")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dryRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("vNext template provenance supports conflict-free three-way repair and preserves user bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-state-"));
  const memberRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-member-"));
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
    assert.equal(loadVnextProject(root, { repositoryBindings: { api: memberRoot } }).templateProvenance?.schema, "kxm.template-provenance.v1");
    assert.match(readFileSync(provenanceFile, "utf8"), /templateRevision: sha256:[a-f0-9]{64}/);

    const implementerFile = join(root, ".kxm", "agents", "implementer.yaml");
    const customized = readFileSync(implementerFile, "utf8").replace(
      "Implement the approved change within the declared repository scope.",
      "Implement changes using the team's reviewed local conventions.",
    );
    writeFileSync(implementerFile, customized);
    const stateBeforeDryRun = snapshotFiles(stateRoot);
    const dry = initializeVnextProject(root, {
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
    assert.equal(existsSync(vnextInitTransactionPath(root)), false);

    assert.throws(
      () => initializeVnextProject(root, {
        localStateRoot: stateRoot,
        templateVariant: "v2",
        repositoryBindings: { api: memberRoot },
        testFaultAt: "verified",
      }),
      /injected init fault/,
    );
    assert.equal(readVnextLocalBindings(root, { stateRoot })?.repositories.api, realpathSync.native(memberRoot));
    assert.equal(existsSync(vnextInitTransactionPath(root)), true);
    const repaired = initializeVnextProject(root, { localStateRoot: stateRoot });
    assert.equal(repaired.action, "resumed");
    assert.equal(readVnextLocalBindings(root, { stateRoot })?.repositories.api, realpathSync.native(memberRoot));
    assert.equal(readFileSync(implementerFile, "utf8"), customized, "user-only bytes must be preserved exactly");
    assert.match(readFileSync(join(root, ".kxm", "agents", "coordinator.yaml"), "utf8"), /validated, reviewable commands/);
    assert.equal(existsSync(vnextInitTransactionPath(root)), false);
    assert.equal(initializeVnextProject(root, { localStateRoot: stateRoot, templateVariant: "v2" }).action, "validated");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(memberRoot, { recursive: true, force: true });
  }
});

test("vNext template repair blocks overlapping edits and authority expansion without mutation", () => {
  const conflictRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-conflict-"));
  const policyRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-policy-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-blocked-state-"));
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
    const conflict = initializeVnextProject(conflictRoot, { localStateRoot: stateRoot, templateVariant: "v2" });
    assert.equal(conflict.action, "planned");
    assert(conflict.repairPlan?.issues.some((issue) => issue.code === "template_repair_conflict"));
    assert.equal(readFileSync(coordinator, "utf8"), userBytes);
    assert.equal(existsSync(vnextInitTransactionPath(conflictRoot)), false);

    const policyCoordinator = join(policyRoot, ".kxm", "agents", "coordinator.yaml");
    const beforePolicy = readFileSync(policyCoordinator, "utf8");
    const policy = initializeVnextProject(policyRoot, { localStateRoot: stateRoot, templateVariant: "v3-policy" });
    assert.equal(policy.action, "planned");
    assert(policy.repairPlan?.issues.some((issue) => issue.code === "template_policy_review_required"));
    assert.equal(readFileSync(policyCoordinator, "utf8"), beforePolicy);
    assert.equal(existsSync(vnextInitTransactionPath(policyRoot)), false);
  } finally {
    rmSync(conflictRoot, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("vNext init resumes pinned create and repair operations across injected crash points", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-resume-state-"));
  const roots: string[] = [];
  const linkedShadowTarget = mkdtempSync(join(tmpdir(), "kxm-vnext-linked-shadow-"));
  try {
    const createRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-resume-create-"));
    roots.push(createRoot);
    makeGitRoot(createRoot);
    assert.throws(
      () => initializeVnextProject(createRoot, {
        projectId: "prj_01JRESUMECREATE00000000000",
        projectName: "Resume Create",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    assert.equal(existsSync(join(createRoot, ".kxm")), false);
    assert.equal(existsSync(vnextInitTransactionPath(createRoot)), true);
    const operationFile = join(vnextInitTransactionPath(createRoot), "operation.json");
    const preparing = JSON.parse(readFileSync(operationFile, "utf8")) as Record<string, unknown>;
    preparing.phase = "preparing";
    writeFileSync(operationFile, `${JSON.stringify(preparing, null, 2)}\n`);
    rmSync(join(vnextInitTransactionPath(createRoot), "targets", ".kxm", "agents", "coordinator.yaml"));
    const transactionBeforeDryRun = snapshotFiles(vnextInitTransactionPath(createRoot));
    const dry = initializeVnextProject(createRoot, { localStateRoot: stateRoot, dryRun: true });
    assert.equal(dry.resumePending, true);
    assert.equal(dry.transactionKind, "create");
    assert.deepEqual(snapshotFiles(vnextInitTransactionPath(createRoot)), transactionBeforeDryRun);
    const stagedShadow = join(vnextInitTransactionPath(createRoot), "shadow");
    rmSync(stagedShadow, { recursive: true, force: true });
    mkdirSync(join(linkedShadowTarget, ".kxm"));
    writeFileSync(join(linkedShadowTarget, ".kxm", "must-remain.txt"), "external\n");
    symlinkSync(linkedShadowTarget, stagedShadow, process.platform === "win32" ? "junction" : "dir");
    const resumedCreate = initializeVnextProject(createRoot, { localStateRoot: stateRoot });
    assert.equal(resumedCreate.action, "resumed");
    assert.equal(resumedCreate.transactionKind, "create");
    assert.equal(existsSync(vnextInitTransactionPath(createRoot)), false);
    assert.equal(readFileSync(join(linkedShadowTarget, ".kxm", "must-remain.txt"), "utf8"), "external\n");

    for (const fault of ["prepared", "first-resource", "provenance", "verified"] as const) {
      const root = mkdtempSync(join(tmpdir(), `kxm-vnext-resume-${fault}-`));
      roots.push(root);
      makeGitRoot(root);
      historicalRepairProject(root, {
        projectId: `prj_01JRESUME${fault.replace("-", "").toUpperCase()}00000000`,
        projectName: "Resume Repair",
        localStateRoot: stateRoot,
      });
      assert.throws(
        () => initializeVnextProject(root, { localStateRoot: stateRoot, templateVariant: "v2", testFaultAt: fault }),
        /injected init fault/,
      );
      assert.equal(existsSync(vnextInitTransactionPath(root)), true);
      if (fault === "prepared") {
        const pending = JSON.parse(readFileSync(join(vnextInitTransactionPath(root), "operation.json"), "utf8")) as { operationId: string };
        writeFileSync(join(root, ".kxm", "agents", `.kxm-repair-${pending.operationId}-00000000-0000-4000-8000-000000000000.tmp`), "partial");
      }
      const resumed = initializeVnextProject(root, { localStateRoot: stateRoot });
      assert.equal(resumed.action, "resumed");
      assert.equal(resumed.transactionKind, "repair");
      assert.match(readFileSync(join(root, ".kxm", "agents", "coordinator.yaml"), "utf8"), /validated, reviewable commands/);
      assert.equal(existsSync(vnextInitTransactionPath(root)), false);
    }

    const changedRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-resume-concurrent-change-"));
    roots.push(changedRoot);
    makeGitRoot(changedRoot);
    historicalRepairProject(changedRoot, {
      projectId: "prj_01JRESUMECHANGED0000000000",
      projectName: "Resume Changed",
      localStateRoot: stateRoot,
    });
    assert.throws(
      () => initializeVnextProject(changedRoot, { localStateRoot: stateRoot, templateVariant: "v2", testFaultAt: "first-resource" }),
      /injected init fault/,
    );
    const changedCoordinator = join(changedRoot, ".kxm", "agents", "coordinator.yaml");
    const concurrentBytes = readFileSync(changedCoordinator, "utf8").replace(
      "Coordinate the pinned workflow and emit validated, reviewable commands.",
      "Concurrent user edit after the interrupted repair.",
    );
    writeFileSync(changedCoordinator, concurrentBytes);
    assert.throws(
      () => initializeVnextProject(changedRoot, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("repair_preimage_changed"),
    );
    assert.equal(readFileSync(changedCoordinator, "utf8"), concurrentBytes);
    assert.equal(existsSync(join(vnextInitTransactionPath(changedRoot), "backups", ".kxm", "agents", "coordinator.yaml")), true);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(linkedShadowTarget, { recursive: true, force: true });
  }
});

test("vNext recovery rejects forged operation targets and safely restarts temp-only preparation", () => {
  const forgedRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-forged-operation-"));
  const temporaryRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-temp-operation-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-operation-state-"));
  try {
    makeGitRoot(forgedRoot);
    assert.throws(
      () => initializeVnextProject(forgedRoot, {
        projectId: "prj_01JFORGEDOPERATION000000000",
        projectName: "Forged Operation",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    const transaction = vnextInitTransactionPath(forgedRoot);
    const target = join(transaction, "targets", ".kxm", "agents", "coordinator.yaml");
    const expanded = readFileSync(target, "utf8").replace("repositories:\n  control: read", "repositories:\n  control: write");
    writeFileSync(target, expanded);
    const operationFile = join(transaction, "operation.json");
    const operation = JSON.parse(readFileSync(operationFile, "utf8")) as Record<string, unknown> & { files: Array<Record<string, unknown>> };
    const coordinator = operation.files.find((entry) => entry.path === ".kxm/agents/coordinator.yaml");
    assert(coordinator);
    coordinator.targetSha256 = vnextContentSha256(expanded);
    operation.planSha256 = vnextContentSha256(JSON.stringify({
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
      () => initializeVnextProject(forgedRoot, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("init_transaction_create_file_invalid"),
    );
    assert.equal(existsSync(join(forgedRoot, ".kxm")), false);

    makeGitRoot(temporaryRoot);
    const tempTransaction = vnextInitTransactionPath(temporaryRoot);
    mkdirSync(tempTransaction);
    writeFileSync(join(tempTransaction, ".operation-op_0123456789abcdef0123456789abcdef-00000000-0000-4000-8000-000000000000.tmp"), "partial");
    const dry = initializeVnextProject(temporaryRoot, { localStateRoot: stateRoot, dryRun: true });
    assert.equal(dry.resumePending, true);
    assert.equal(existsSync(tempTransaction), true);
    const restarted = initializeVnextProject(temporaryRoot, {
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

test("vNext repair validates the complete shadow before changing project files", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-shadow-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-repair-shadow-state-"));
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
      () => initializeVnextProject(root, { localStateRoot: stateRoot, templateVariant: "v2" }),
      (error) => issueCodes(error).some((code) => code === "workflow_unknown" || code === "default_workflow_unknown"),
    );
    assert.equal(readFileSync(coordinator, "utf8"), coordinatorBefore);
    assert.equal(existsSync(vnextInitTransactionPath(root)), false, "failed pre-application validation must remove its unused transaction");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("vNext loader rejects corrupt template provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-vnext-provenance-corrupt-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-provenance-state-"));
  try {
    makeGitRoot(root);
    initializeVnextProject(root, {
      projectId: "prj_01JPROVENANCE0000000000000",
      projectName: "Provenance",
      localStateRoot: stateRoot,
    });
    const file = join(root, ".kxm", "template-provenance.yaml");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, `# operator formatting\n${original}`);
    assert.equal(loadVnextProject(root).templateProvenance?.schema, "kxm.template-provenance.v1");
    const formattingPlan = initializeVnextProject(root, { dryRun: true, localStateRoot: stateRoot, templateVariant: "v2" });
    assert.equal(formattingPlan.repairPlan?.canApply, false);
    assert(formattingPlan.repairPlan?.issues.some((issue) => issue.code === "template_provenance_user_modified"));
    writeFileSync(file, original.replace(/templateRevision: sha256:[a-f0-9]{64}/, `templateRevision: sha256:${"0".repeat(64)}`));
    assert.throws(() => loadVnextProject(root), (error) => issueCodes(error).includes("template_provenance_revision_invalid"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("vNext init joins with atomic Runtime-local member bindings and reuses them idempotently", () => {
  const root = temporaryFixture("kxm-vnext-join-");
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-local-state-"));
  const linkedTarget = mkdtempSync(join(tmpdir(), "kxm-vnext-linked-state-"));
  const alternateStateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-alternate-state-"));
  try {
    const projectFile = join(root, ".kxm", "project.yaml");
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace("    pathHint: repositories/api\n", ""));
    const api = join(root, "repositories", "api");
    const bindingFile = vnextLocalBindingFile(root, { stateRoot });

    const unknown = initializeVnextProject(root, {
      repositoryBindings: { unknown: api },
      localStateRoot: stateRoot,
    });
    assert.equal(unknown.action, "planned");
    assert(unknown.plan.issues.some((candidate) => candidate.code === "repository_binding_unknown"));
    assert.equal(existsSync(bindingFile), false);
    assert.throws(
      () => initializeVnextProject(root, { repositoryBindings: { api }, localStateRoot: "relative-state" }),
      (error) => issueCodes(error).includes("local_state_root_not_absolute"),
    );
    withVnextLocalBindingLock(root, { stateRoot }, (lock) => {
      assert.throws(
        () => initializeVnextProject(root, { repositoryBindings: { api }, localStateRoot: alternateStateRoot }),
        (error) => issueCodes(error).includes("local_binding_lock_busy"),
      );
      assert.equal(existsSync(lock.file), true, "a contender must not remove the lock it did not acquire");
      assert.equal(existsSync(bindingFile), false);
    });
    assert.throws(
      () => initializeVnextProject(root, { repositoryBindings: { api, control: root }, localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("local_binding_repository_invalid"),
    );

    const dry = initializeVnextProject(root, {
      repositoryBindings: { api },
      localStateRoot: stateRoot,
      dryRun: true,
    });
    assert.equal(dry.action, "planned");
    assert.equal(dry.bindingsChanged, true);
    assert.equal(dry.localBindingFile, bindingFile);
    assert.equal(existsSync(bindingFile), false);

    const joined = initializeVnextProject(root, {
      repositoryBindings: { api },
      localStateRoot: stateRoot,
    });
    assert.equal(joined.action, "joined");
    assert.equal(joined.bindingsChanged, true);
    assert.equal(joined.localBindingFile, bindingFile);
    assert.equal(existsSync(bindingFile), true);
    assert.equal(readFileSync(projectFile, "utf8").includes(realpathSync.native(api)), false, "absolute bindings must not enter Git configuration");
    const record = readVnextLocalBindings(root, { stateRoot });
    assert.equal(record?.projectId, "prj_01JPROJECT00000000000000000");
    assert.deepEqual(record?.repositories, { api: realpathSync.native(api) });

    const repeated = initializeVnextProject(root, { localStateRoot: stateRoot });
    assert.equal(repeated.action, "validated");
    assert.equal(repeated.configRevision, joined.configRevision);
    const unchanged = initializeVnextProject(root, { repositoryBindings: { api }, localStateRoot: stateRoot });
    assert.equal(unchanged.action, "validated");
    assert.equal(unchanged.bindingsChanged, false);

    const validRecordText = readFileSync(bindingFile, "utf8");
    const invalidRecord = JSON.parse(validRecordText) as Record<string, unknown>;
    invalidRecord.unexpected = true;
    writeFileSync(bindingFile, `${JSON.stringify(invalidRecord)}\n`);
    assert.throws(
      () => initializeVnextProject(root, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("schema_additionalProperties"),
    );
    delete invalidRecord.unexpected;
    invalidRecord.projectId = "prj_01JOTHERPROJECT000000000000";
    writeFileSync(bindingFile, `${JSON.stringify(invalidRecord)}\n`);
    assert.throws(
      () => initializeVnextProject(root, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("local_binding_project_id_mismatch"),
    );

    writeFileSync(join(linkedTarget, "repository-bindings.json"), validRecordText);
    rmSync(dirname(bindingFile), { recursive: true, force: true });
    symlinkSync(linkedTarget, dirname(bindingFile), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => initializeVnextProject(root, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("local_binding_directory_invalid"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
    rmSync(linkedTarget, { recursive: true, force: true });
    rmSync(alternateStateRoot, { recursive: true, force: true });
  }
});

test("vNext project mutation lock rejects linked Git-metadata parents", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-vnext-lock-link-"));
  const linked = mkdtempSync(join(tmpdir(), "kxm-vnext-lock-link-target-"));
  try {
    makeGitRoot(root);
    symlinkSync(linked, join(root, ".git", "kxm"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => withVnextLocalBindingLock(root, {}, () => undefined),
      (error) => issueCodes(error).includes("project_operation_lock_parent_invalid"),
    );
    assert.equal(existsSync(join(linked, "project-operation-lock.sqlite")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("vNext create classifies empty and private-runtime-only .kxm and merges without touching runtime bytes", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-runtime-create-state-"));
  const emptyRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-empty-kxm-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-runtime-only-"));
  const dbRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-runtime-db-"));
  const unknownRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-unknown-kxm-"));
  const linkedRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-linked-kxm-"));
  const linkedStateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-linked-state-"));
  const linkedTarget = mkdtempSync(join(tmpdir(), "kxm-vnext-linked-target-"));
  const collisionRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-managed-collision-"));
  const emptyDirRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-empty-dir-kxm-"));
  const inspectErrorRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-inspect-error-"));
  try {
    for (const root of [emptyRoot, runtimeRoot, dbRoot, unknownRoot, linkedRoot, linkedStateRoot, collisionRoot, emptyDirRoot]) makeGitRoot(root);

    mkdirSync(join(emptyRoot, ".kxm"));
    assert.equal(planVnextInitialization(emptyRoot).mode, "create");
    const emptyBefore = snapshotFiles(emptyRoot);
    const emptyDry = initializeVnextProject(emptyRoot, { dryRun: true, localStateRoot: stateRoot });
    assert.equal(emptyDry.action, "planned");
    assert.deepEqual(snapshotFiles(emptyRoot), emptyBefore, "dry-run must not write into an empty .kxm");
    const emptyCreated = initializeVnextProject(emptyRoot, {
      projectId: "prj_01JEMPTYKXM000000000000000",
      projectName: "Empty Kxm",
      localStateRoot: stateRoot,
    });
    assert.equal(emptyCreated.action, "created");
    assert.equal(existsSync(join(emptyRoot, ".kxm", "project.yaml")), true);

    mkdirSync(join(runtimeRoot, ".kxm", "state"), { recursive: true });
    mkdirSync(join(runtimeRoot, ".kxm", "logs"), { recursive: true });
    mkdirSync(join(runtimeRoot, ".kxm", "runtime"), { recursive: true });
    const cacheBytes = "project-local-cache-must-remain\n";
    const dbBytes = "kxm-db-bytes-must-remain\n";
    const nestedBytes = "nested-runtime-file\n";
    writeFileSync(join(runtimeRoot, ".kxm", "state", "update-check.json"), cacheBytes);
    writeFileSync(join(runtimeRoot, ".kxm", "state", "kxm.db"), dbBytes);
    mkdirSync(join(runtimeRoot, ".kxm", "state", "pi-sessions"), { recursive: true });
    writeFileSync(join(runtimeRoot, ".kxm", "state", "pi-sessions", "keep.txt"), nestedBytes);
    writeFileSync(join(runtimeRoot, ".kxm", "logs", "hub.log"), "log-bytes\n");
    assert.equal(planVnextInitialization(runtimeRoot).mode, "create");
    const runtimeBefore = snapshotFiles(join(runtimeRoot, ".kxm"));
    const runtimeDry = initializeVnextProject(runtimeRoot, { dryRun: true, localStateRoot: stateRoot });
    assert.equal(runtimeDry.action, "planned");
    assert.deepEqual(snapshotFiles(join(runtimeRoot, ".kxm")), runtimeBefore);
    const runtimeCreated = initializeVnextProject(runtimeRoot, {
      projectId: "prj_01JRUNTIMEONLY000000000000",
      projectName: "Runtime Only",
      localStateRoot: stateRoot,
    });
    assert.equal(runtimeCreated.action, "created");
    assert.equal(readFileSync(join(runtimeRoot, ".kxm", "state", "update-check.json"), "utf8"), cacheBytes);
    assert.equal(readFileSync(join(runtimeRoot, ".kxm", "state", "kxm.db"), "utf8"), dbBytes);
    assert.equal(readFileSync(join(runtimeRoot, ".kxm", "state", "pi-sessions", "keep.txt"), "utf8"), nestedBytes);
    assert.equal(readFileSync(join(runtimeRoot, ".kxm", "logs", "hub.log"), "utf8"), "log-bytes\n");
    assert.equal(initializeVnextProject(runtimeRoot, { localStateRoot: stateRoot }).action, "validated");

    mkdirSync(join(dbRoot, ".kxm", "state"), { recursive: true });
    writeFileSync(join(dbRoot, ".kxm", "state", "kxm.db"), "hub-db\n");
    assert.equal(planVnextInitialization(dbRoot).mode, "create", "a hub database is runtime state, not a migration source");

    mkdirSync(join(emptyDirRoot, ".kxm", "orphan"), { recursive: true });
    const emptyDir = planVnextInitialization(emptyDirRoot);
    assert.equal(emptyDir.mode, "repair", "an unknown empty directory is not a create destination");
    assert(emptyDir.issues.some((item) => item.code === "kxm_workspace_unknown_entry"));
    const emptyDirInit = initializeVnextProject(emptyDirRoot, {
      projectId: "prj_01JEMPTYDIRENTRY0000000000",
      projectName: "Empty Dir Entry",
      localStateRoot: stateRoot,
    });
    assert.equal(emptyDirInit.action, "planned");
    assert.equal(emptyDirInit.plan.mode, "repair");
    assert.equal(existsSync(join(emptyDirRoot, ".kxm", "orphan")), true);
    assert.equal(existsSync(join(emptyDirRoot, ".kxm", "project.yaml")), false);

    mkdirSync(join(unknownRoot, ".kxm"), { recursive: true });
    writeFileSync(join(unknownRoot, ".kxm", "notes.txt"), "operator file\n");
    const unknown = planVnextInitialization(unknownRoot);
    assert.equal(unknown.mode, "repair");
    assert(unknown.issues.some((item) => item.code === "kxm_workspace_unknown_entry"));
    const unknownInit = initializeVnextProject(unknownRoot, {
      projectId: "prj_01JUNKNOWNENTRY00000000000",
      projectName: "Unknown Entry",
      localStateRoot: stateRoot,
    });
    assert.equal(unknownInit.action, "planned");
    assert.equal(unknownInit.plan.mode, "repair");
    assert.equal(readFileSync(join(unknownRoot, ".kxm", "notes.txt"), "utf8"), "operator file\n");
    assert.equal(existsSync(join(unknownRoot, ".kxm", "project.yaml")), false);

    mkdirSync(join(collisionRoot, ".kxm", "agents"), { recursive: true });
    writeFileSync(join(collisionRoot, ".kxm", "agents", "coordinator.yaml"), "user-managed\n");
    const collision = planVnextInitialization(collisionRoot);
    assert.equal(collision.mode, "repair");
    const collisionInit = initializeVnextProject(collisionRoot, {
      projectId: "prj_01JMANAGEDCOLLISION00000000",
      projectName: "Managed Collision",
      localStateRoot: stateRoot,
    });
    assert.equal(collisionInit.action, "planned");
    assert.equal(readFileSync(join(collisionRoot, ".kxm", "agents", "coordinator.yaml"), "utf8"), "user-managed\n");

    mkdirSync(join(linkedRoot, ".kxm-elsewhere"));
    symlinkSync(join(linkedRoot, ".kxm-elsewhere"), join(linkedRoot, ".kxm"), process.platform === "win32" ? "junction" : "dir");
    const linked = planVnextInitialization(linkedRoot);
    assert.equal(linked.mode, "repair");
    assert(linked.issues.some((item) => item.code === "kxm_workspace_link"));

    mkdirSync(join(linkedStateRoot, ".kxm"));
    mkdirSync(join(linkedTarget, "state-elsewhere"));
    symlinkSync(join(linkedTarget, "state-elsewhere"), join(linkedStateRoot, ".kxm", "state"), process.platform === "win32" ? "junction" : "dir");
    const linkedState = planVnextInitialization(linkedStateRoot);
    assert.equal(linkedState.mode, "repair");
    assert(linkedState.issues.some((item) => item.code === "kxm_runtime_root_link"));

    const fileRoot = join(inspectErrorRoot, "not-a-directory");
    writeFileSync(fileRoot, "not-a-directory\n");
    assert.throws(
      () => inspectVnextCreateDestination(fileRoot),
      (error) => issueCodes(error).includes("kxm_workspace_unreadable"),
      "non-ENOENT lstat of .kxm must not classify as an absent create destination",
    );

    if (process.platform !== "win32") {
      const blockedParent = join(inspectErrorRoot, "blocked-parent");
      mkdirSync(blockedParent);
      mkdirSync(join(blockedParent, ".kxm"));
      chmodSync(blockedParent, 0o600);
      try {
        assert.throws(
          () => inspectVnextCreateDestination(blockedParent),
          (error) => issueCodes(error).includes("kxm_workspace_unreadable"),
        );
      } finally {
        chmodSync(blockedParent, 0o700);
      }

      const unreadableKxm = join(inspectErrorRoot, "unreadable-kxm");
      makeGitRoot(unreadableKxm);
      mkdirSync(join(unreadableKxm, ".kxm"));
      chmodSync(join(unreadableKxm, ".kxm"), 0o000);
      try {
        assert.throws(
          () => inspectVnextCreateDestination(unreadableKxm),
          (error) => issueCodes(error).includes("kxm_workspace_unreadable"),
        );
        assert.throws(
          () => planVnextInitialization(unreadableKxm),
          (error) => issueCodes(error).includes("kxm_workspace_unreadable"),
        );
      } finally {
        chmodSync(join(unreadableKxm, ".kxm"), 0o700);
      }
    }
  } finally {
    for (const root of [emptyRoot, runtimeRoot, dbRoot, unknownRoot, linkedRoot, linkedStateRoot, collisionRoot, emptyDirRoot, inspectErrorRoot, linkedTarget, stateRoot]) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("vNext create merge resumes across crash points and rejects concurrent unknown files", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-merge-resume-state-"));
  const preparedRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-merge-prepared-"));
  const firstRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-merge-first-"));
  const conflictRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-merge-conflict-"));
  const emptyConflictRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-merge-empty-conflict-"));
  const nestedEmptyRoot = mkdtempSync(join(tmpdir(), "kxm-vnext-merge-nested-empty-"));
  try {
    for (const root of [preparedRoot, firstRoot, conflictRoot, emptyConflictRoot, nestedEmptyRoot]) {
      makeGitRoot(root);
      mkdirSync(join(root, ".kxm", "state"), { recursive: true });
      writeFileSync(join(root, ".kxm", "state", "update-check.json"), `${root}-cache\n`);
    }

    assert.throws(
      () => initializeVnextProject(preparedRoot, {
        projectId: "prj_01JMERGERESUMEPREP00000000",
        projectName: "Merge Prepared",
        localStateRoot: stateRoot,
        testFaultAt: "prepared",
      }),
      /injected init fault/,
    );
    assert.equal(existsSync(join(preparedRoot, ".kxm", "project.yaml")), false);
    assert.equal(readFileSync(join(preparedRoot, ".kxm", "state", "update-check.json"), "utf8"), `${preparedRoot}-cache\n`);
    const resumedPrepared = initializeVnextProject(preparedRoot, { localStateRoot: stateRoot });
    assert.equal(resumedPrepared.action, "resumed");
    assert.equal(resumedPrepared.transactionKind, "create");
    assert.equal(readFileSync(join(preparedRoot, ".kxm", "state", "update-check.json"), "utf8"), `${preparedRoot}-cache\n`);
    assert.equal(existsSync(vnextInitTransactionPath(preparedRoot)), false);

    assert.throws(
      () => initializeVnextProject(firstRoot, {
        projectId: "prj_01JMERGERESUMEFIRST0000000",
        projectName: "Merge First",
        localStateRoot: stateRoot,
        testFaultAt: "first-resource",
      }),
      /injected init fault/,
    );
    assert.equal(existsSync(join(firstRoot, ".kxm", "project.yaml")), false);
    assert.equal(readFileSync(join(firstRoot, ".kxm", "state", "update-check.json"), "utf8"), `${firstRoot}-cache\n`);
    const resumedFirst = initializeVnextProject(firstRoot, { localStateRoot: stateRoot });
    assert.equal(resumedFirst.action, "resumed");
    assert.equal(existsSync(join(firstRoot, ".kxm", "project.yaml")), true);
    assert.equal(readFileSync(join(firstRoot, ".kxm", "state", "update-check.json"), "utf8"), `${firstRoot}-cache\n`);

    assert.throws(
      () => initializeVnextProject(conflictRoot, {
        projectId: "prj_01JMERGECONFLICT0000000000",
        projectName: "Merge Conflict",
        localStateRoot: stateRoot,
        testFaultAt: "first-resource",
      }),
      /injected init fault/,
    );
    writeFileSync(join(conflictRoot, ".kxm", "injected.txt"), "concurrent\n");
    assert.throws(
      () => initializeVnextProject(conflictRoot, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("create_resume_conflict") || issueCodes(error).includes("kxm_workspace_unknown_entry"),
    );
    assert.equal(readFileSync(join(conflictRoot, ".kxm", "injected.txt"), "utf8"), "concurrent\n");
    assert.equal(readFileSync(join(conflictRoot, ".kxm", "state", "update-check.json"), "utf8"), `${conflictRoot}-cache\n`);
    assert.equal(existsSync(join(conflictRoot, ".kxm", "project.yaml")), false);

    assert.throws(
      () => initializeVnextProject(emptyConflictRoot, {
        projectId: "prj_01JMERGEEMPTYCONFLICT00000",
        projectName: "Merge Empty Conflict",
        localStateRoot: stateRoot,
        testFaultAt: "first-resource",
      }),
      /injected init fault/,
    );
    mkdirSync(join(emptyConflictRoot, ".kxm", "orphan-empty"));
    assert.throws(
      () => initializeVnextProject(emptyConflictRoot, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("create_resume_conflict") || issueCodes(error).includes("kxm_workspace_unknown_entry"),
    );
    assert.equal(existsSync(join(emptyConflictRoot, ".kxm", "orphan-empty")), true);
    assert.equal(readFileSync(join(emptyConflictRoot, ".kxm", "state", "update-check.json"), "utf8"), `${emptyConflictRoot}-cache\n`);
    assert.equal(existsSync(join(emptyConflictRoot, ".kxm", "project.yaml")), false);

    assert.throws(
      () => initializeVnextProject(nestedEmptyRoot, {
        projectId: "prj_01JMERGENESTEDEMPTY0000000",
        projectName: "Merge Nested Empty",
        localStateRoot: stateRoot,
        testFaultAt: "first-resource",
      }),
      /injected init fault/,
    );
    mkdirSync(join(nestedEmptyRoot, ".kxm", "agents", "injected-empty"), { recursive: true });
    assert.throws(
      () => initializeVnextProject(nestedEmptyRoot, { localStateRoot: stateRoot }),
      (error) => issueCodes(error).includes("create_resume_conflict") || issueCodes(error).includes("kxm_workspace_unknown_entry"),
    );
    assert.equal(existsSync(join(nestedEmptyRoot, ".kxm", "agents", "injected-empty")), true);
    assert.equal(readFileSync(join(nestedEmptyRoot, ".kxm", "state", "update-check.json"), "utf8"), `${nestedEmptyRoot}-cache\n`);
    assert.equal(existsSync(join(nestedEmptyRoot, ".kxm", "project.yaml")), false);
  } finally {
    for (const root of [preparedRoot, firstRoot, conflictRoot, emptyConflictRoot, nestedEmptyRoot, stateRoot]) rmSync(root, { recursive: true, force: true });
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
