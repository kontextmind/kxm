import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import {
  addRole,
  ensureDefaultRoles,
  getRole,
  listRoles,
  modifyRole,
  parseRoleFile,
  removeRole,
  type KxmRoleDefinition,
} from "../../plugins/kxm/src/role.ts";
import {
  addWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  modifyWorkflowDefinition,
  parseWorkflowFile,
  removeWorkflowDefinition,
} from "../../plugins/kxm/src/workflow-manager.ts";

test("Role subsystem: add, get, list, modify, remove with global/local scoping", () => {
  const tempUserDir = mkdtempSync(join(tmpdir(), "kxm-user-roles-"));
  const tempRepoDir = mkdtempSync(join(tmpdir(), "kxm-repo-roles-"));

  try {
    // 1. Seed default global roles
    ensureDefaultRoles(tempUserDir);
    const globalRoles = listRoles({ scope: "global", userConfigDir: tempUserDir, repoRoot: tempRepoDir });
    assert.ok(globalRoles.length >= 4);
    assert.ok(globalRoles.some((r) => r.id === "writer"));
    assert.ok(globalRoles.some((r) => r.id === "planner"));

    // 2. Add local role
    const customRole: KxmRoleDefinition = {
      schema: "kxm.role.v1",
      id: "sec-specialist",
      description: "AppSec and fuzzing auditor",
      skills: ["appsec", "fuzzing"],
      tools: { preset: "auditor", allow: ["view_file", "run_command"] },
      produces: [{ template: "audit-report" }],
      roster: [{ harness: "grok", model: "grok-4.6", effort: "high" }],
    };
    const addRes = addRole(customRole, { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.equal(addRes.id, "sec-specialist");
    assert.equal(addRes.scope, "local");

    // 3. Get local role
    const retrieved = getRole("sec-specialist", { repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.ok(retrieved);
    assert.equal(retrieved?.role.id, "sec-specialist");
    assert.equal(retrieved?.scope, "local");
    assert.deepEqual(retrieved?.role.skills, ["appsec", "fuzzing"]);

    // 4. Override global role in local repo
    const overriddenWriter: KxmRoleDefinition = {
      schema: "kxm.role.v1",
      id: "writer",
      description: "Custom project writer with strict repo tools",
      skills: ["kxm", "custom-skill"],
      tools: { allow: ["view_file", "write_to_file"] },
      roster: [{ harness: "grok", model: "grok-4.6" }],
    };
    addRole(overriddenWriter, { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir });

    const allRoles = listRoles({ scope: "all", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    const writerSummary = allRoles.find((r) => r.id === "writer");
    assert.ok(writerSummary);
    assert.equal(writerSummary?.scope, "overridden");
    assert.equal(writerSummary?.description, "Custom project writer with strict repo tools");

    // 5. Modify role
    const modified = modifyRole("sec-specialist", {
      description: "Updated AppSec description",
      skills: ["appsec", "fuzzing", "penetration-testing"],
    }, { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.equal(modified.role.description, "Updated AppSec description");
    assert.equal(modified.role.skills?.length, 3);

    // 6. Remove role
    const removeRes = removeRole("sec-specialist", { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.equal(removeRes.removed, true);
    assert.equal(getRole("sec-specialist", { repoRoot: tempRepoDir, userConfigDir: tempUserDir }), undefined);

    // 7. Error cases and parseRoleFile edge cases
    assert.throws(
      () => addRole(overriddenWriter, { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir, overwrite: false }),
      /role_already_exists/,
    );
    assert.throws(
      () => removeRole("nonexistent-role", { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir }),
      /role_not_found/,
    );
    assert.throws(
      () => modifyRole("nonexistent-role", { description: "x" }, { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir }),
      /role_not_found/,
    );
    assert.equal(parseRoleFile(join(tempRepoDir, "does-not-exist.yaml")), undefined);

    const badSchemaFile = join(tempRepoDir, "bad-schema.yaml");
    writeFileSync(badSchemaFile, "schema: invalid.schema\nid: bad\n", "utf8");
    assert.equal(parseRoleFile(badSchemaFile), undefined);

    const invalidYamlFile = join(tempRepoDir, "invalid.yaml");
    writeFileSync(invalidYamlFile, "not: yaml: [broken", "utf8");
    assert.equal(parseRoleFile(invalidYamlFile), undefined);
  } finally {
    rmSync(tempUserDir, { recursive: true, force: true });
    rmSync(tempRepoDir, { recursive: true, force: true });
  }
});

test("Workflow manager subsystem: add, get, list, modify, remove with global/local scoping", () => {
  const tempUserDir = mkdtempSync(join(tmpdir(), "kxm-user-wf-"));
  const tempRepoDir = mkdtempSync(join(tmpdir(), "kxm-repo-wf-"));

  try {
    // 1. Add global workflow
    const globalWf = {
      schema: "kxm.workflow.v1",
      id: "global-review",
      description: "Global standard code review workflow",
      steps: [
        { id: "review", kind: "agent", role: "critic-arch" },
      ],
    };
    const addGlobal = addWorkflowDefinition("global-review", globalWf, { scope: "global", userConfigDir: tempUserDir, repoRoot: tempRepoDir });
    assert.equal(addGlobal.scope, "global");

    // 2. Add local workflow
    const localWf = {
      schema: "kxm.workflow.v1",
      id: "local-feature",
      description: "Local project feature development",
      steps: [
        { id: "plan", kind: "agent", role: "planner" },
        { id: "implement", kind: "agent", role: "writer" },
        { id: "verify", kind: "gate", gate: "verify-gate" },
      ],
    };
    const addLocal = addWorkflowDefinition("local-feature", localWf, { scope: "local", userConfigDir: tempUserDir, repoRoot: tempRepoDir });
    assert.equal(addLocal.scope, "local");

    // 3. List workflow definitions
    const list = listWorkflowDefinitions({ repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.equal(list.length, 2);
    const localSummary = list.find((w) => w.id === "local-feature");
    assert.ok(localSummary);
    assert.equal(localSummary?.stepCount, 3);
    assert.deepEqual(localSummary?.roles, ["planner", "writer"]);

    // 4. Get workflow definition
    const retrieved = getWorkflowDefinition("local-feature", { repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.ok(retrieved);
    assert.equal(retrieved?.scope, "local");
    assert.equal(retrieved?.workflow["description"], "Local project feature development");

    // 5. Modify workflow definition
    const modified = modifyWorkflowDefinition("local-feature", {
      description: "Updated feature development workflow",
    }, { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.equal(modified.workflow["description"], "Updated feature development workflow");

    // 6. Remove workflow definition
    const removed = removeWorkflowDefinition("local-feature", { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    assert.equal(removed.removed, true);
    assert.equal(getWorkflowDefinition("local-feature", { repoRoot: tempRepoDir, userConfigDir: tempUserDir }), undefined);

    // 7. Error cases and parseWorkflowFile edge cases
    assert.throws(
      () => addWorkflowDefinition("global-review", globalWf, { scope: "global", userConfigDir: tempUserDir, repoRoot: tempRepoDir, overwrite: false }),
      /workflow_already_exists/,
    );
    assert.throws(
      () => removeWorkflowDefinition("nonexistent-wf", { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir }),
      /workflow_not_found/,
    );
    assert.throws(
      () => modifyWorkflowDefinition("nonexistent-wf", { description: "x" }, { scope: "local", repoRoot: tempRepoDir, userConfigDir: tempUserDir }),
      /workflow_not_found/,
    );
    assert.equal(parseWorkflowFile(join(tempRepoDir, "does-not-exist.yaml")), undefined);

    const badYamlFile = join(tempRepoDir, "bad-wf.yaml");
    writeFileSync(badYamlFile, ": bad : [yaml", "utf8");
    assert.equal(parseWorkflowFile(badYamlFile), undefined);
  } finally {
    rmSync(tempUserDir, { recursive: true, force: true });
    rmSync(tempRepoDir, { recursive: true, force: true });
  }
});

test("Role & Workflow CLI: commands with pick list, scoping, and JSON output", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const tempUserDir = mkdtempSync(join(tmpdir(), "kxm-cli-user-"));
  const tempRepoDir = mkdtempSync(join(tmpdir(), "kxm-cli-repo-"));

  const env = {
    KXM_USER_CONFIG_DIR: tempUserDir,
    KXM_LOGS_DIR: join(tempRepoDir, ".kxm/logs"),
    KXM_STATE_HOME: join(tempRepoDir, ".kxm/state"),
  };

  const createIo = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: (t: string) => stdout.push(t),
        stderr: (t: string) => stderr.push(t),
      },
      out: () => stdout.join(""),
      err: () => stderr.join(""),
    };
  };

  try {
    // 1. role list (empty initially)
    const listEmptyIo = createIo();
    const emptyCode = await runCliImpl(["role", "list"], env, listEmptyIo.io, tempRepoDir);
    assert.equal(emptyCode, 0);
    assert.match(listEmptyIo.out(), /No roles configured/);

    // 2. role add using pick list for global configuration
    const addPickIo = createIo();
    const addPickCode = await runCliImpl(["role", "add", "--scope", "global", "--pick", "1"], env, addPickIo.io, tempRepoDir);
    assert.equal(addPickCode, 0);
    assert.match(addPickIo.out(), /Added role 'writer' to global/);

    // 3. role list with global populated
    const listGlobalIo = createIo();
    const listGlobalCode = await runCliImpl(["--json", "role", "list"], env, listGlobalIo.io, tempRepoDir);
    assert.equal(listGlobalCode, 0);
    const parsedGlobalList = JSON.parse(listGlobalIo.out());
    assert.equal(parsedGlobalList.ok, true);
    assert.ok(parsedGlobalList.roles.some((r: any) => r.id === "writer" && r.scope === "global"));

    // 4. role add local custom role
    const addLocalIo = createIo();
    const addLocalCode = await runCliImpl([
      "role", "add", "qa-lead",
      "--description", "Quality Assurance Lead",
      "--skills", "testing,e2e",
      "--harness", "grok",
      "--model", "grok-4.6",
      "--scope", "local",
    ], env, addLocalIo.io, tempRepoDir);
    assert.equal(addLocalCode, 0);
    assert.match(addLocalIo.out(), /Added role 'qa-lead' to local/);

    // 5. role get
    const getIo = createIo();
    const getCode = await runCliImpl(["--json", "role", "get", "qa-lead"], env, getIo.io, tempRepoDir);
    assert.equal(getCode, 0);
    const parsedGet = JSON.parse(getIo.out());
    assert.equal(parsedGet.role.id, "qa-lead");
    assert.deepEqual(parsedGet.role.skills, ["testing", "e2e"]);

    // 6. role modify
    const modifyIo = createIo();
    const modCode = await runCliImpl([
      "role", "modify", "qa-lead",
      "--description", "Senior QA Lead",
      "--add-skill", "load-testing",
      "--remove-skill", "e2e",
      "--add-model", "claude:fable",
      "--scope", "local",
    ], env, modifyIo.io, tempRepoDir);
    assert.equal(modCode, 0);

    const getModifiedIo = createIo();
    await runCliImpl(["--json", "role", "get", "qa-lead"], env, getModifiedIo.io, tempRepoDir);
    const parsedModified = JSON.parse(getModifiedIo.out());
    assert.equal(parsedModified.role.description, "Senior QA Lead");
    assert.ok(parsedModified.role.skills.includes("load-testing"));
    assert.ok(!parsedModified.role.skills.includes("e2e"));
    assert.ok(parsedModified.role.roster.some((r: any) => r.model === "fable"));

    // 7. role remove using pick list
    const removePickIo = createIo();
    const removePickCode = await runCliImpl(["role", "remove", "--scope", "local", "--pick", "1"], env, removePickIo.io, tempRepoDir);
    assert.equal(removePickCode, 0);
    assert.match(removePickIo.out(), /Removed role 'qa-lead' from local/);

    // 8. workflow add using pick list from template
    const wfAddPickIo = createIo();
    const wfAddCode = await runCliImpl(["workflow", "add", "--scope", "global", "--pick", "1"], env, wfAddPickIo.io, tempRepoDir);
    assert.equal(wfAddCode, 0);
    assert.match(wfAddPickIo.out(), /Added workflow 'implement-and-verify' to global/);

    // 9. workflow definitions
    const wfListIo = createIo();
    const wfListCode = await runCliImpl(["--json", "workflow", "definitions"], env, wfListIo.io, tempRepoDir);
    assert.equal(wfListCode, 0);
    const parsedWfList = JSON.parse(wfListIo.out());
    assert.ok(parsedWfList.workflows.some((w: any) => w.id === "implement-and-verify" && w.scope === "global"));

    // 10. workflow modify
    const wfModIo = createIo();
    const wfModCode = await runCliImpl(["workflow", "modify", "implement-and-verify", "--description", "Customized global implement workflow", "--scope", "global"], env, wfModIo.io, tempRepoDir);
    assert.equal(wfModCode, 0);

    // 11. workflow remove using pick list
    const wfRemoveIo = createIo();
    const wfRemoveCode = await runCliImpl(["workflow", "remove", "--scope", "global", "--pick", "1"], env, wfRemoveIo.io, tempRepoDir);
    assert.equal(wfRemoveCode, 0);
    assert.match(wfRemoveIo.out(), /Removed workflow 'implement-and-verify' from global/);

    // 12. error cases: missing role / workflow
    const missingRoleIo = createIo();
    assert.equal(await runCliImpl(["role", "get", "non-existent"], env, missingRoleIo.io, tempRepoDir), 1);

    const missingWfRemoveIo = createIo();
    assert.equal(await runCliImpl(["workflow", "remove", "non-existent"], env, missingWfRemoveIo.io, tempRepoDir), 1);

    // 13. Text mode role list and definitions
    const listTextIo = createIo();
    assert.equal(await runCliImpl(["role", "list"], env, listTextIo.io, tempRepoDir), 0);
    assert.match(listTextIo.out(), /ROLES:/);

    // 14. File-based role add
    const fileRolePath = join(tempRepoDir, "sample-role.yaml");
    writeFileSync(fileRolePath, "schema: kxm.role.v1\nid: file-role\ndescription: Role from file\nroster: []\n", "utf8");
    const addFileIo = createIo();
    assert.equal(await runCliImpl(["role", "add", "file-role", "--file", fileRolePath], env, addFileIo.io, tempRepoDir), 0);

    // 15. Named pick and KXM_PICK_SELECT for role add
    const addNamedPickIo = createIo();
    assert.equal(await runCliImpl(["role", "add", "--pick", "writer", "--scope", "local"], env, addNamedPickIo.io, tempRepoDir), 0);

    const addEnvPickIo = createIo();
    assert.equal(await runCliImpl(["role", "add", "--scope", "local"], { ...env, KXM_PICK_SELECT: "planner" }, addEnvPickIo.io, tempRepoDir), 0);

    // 16. role add missing roleId
    const addMissingIo = createIo();
    assert.equal(await runCliImpl(["role", "add"], env, addMissingIo.io, tempRepoDir), 1);

    // 17. role remove empty list and missing roleId
    const isolatedRepo = mkdtempSync(join(tmpdir(), "kxm-empty-"));
    const emptyRemoveIo = createIo();
    assert.equal(await runCliImpl(["role", "remove", "--scope", "local"], env, emptyRemoveIo.io, isolatedRepo), 0);
    assert.match(emptyRemoveIo.out(), /No roles configured in local scope to remove/);

    const removeMissingIo = createIo();
    assert.equal(await runCliImpl(["role", "remove"], env, removeMissingIo.io, tempRepoDir), 1);

    // 18. role modify empty, pick, and missing roleId
    const emptyModIo = createIo();
    assert.equal(await runCliImpl(["role", "modify", "--scope", "local"], env, emptyModIo.io, isolatedRepo), 0);
    assert.match(emptyModIo.out(), /No roles configured to modify/);

    const modPickIo = createIo();
    assert.equal(await runCliImpl(["role", "modify", "--pick", "1", "--description", "Picked mod role"], env, modPickIo.io, tempRepoDir), 0);

    const modMissingIo = createIo();
    assert.equal(await runCliImpl(["role", "modify"], env, modMissingIo.io, tempRepoDir), 1);

    // 19. workflow definitions text mode and empty
    const wfListTextIo = createIo();
    // Add a workflow so list is not empty
    await runCliImpl(["workflow", "add", "--scope", "global", "--pick", "1"], env, createIo().io, tempRepoDir);
    assert.equal(await runCliImpl(["workflow", "definitions"], env, wfListTextIo.io, tempRepoDir), 0);
    assert.match(wfListTextIo.out(), /WORKFLOW DEFINITIONS:/);

    const wfEmptyListIo = createIo();
    assert.equal(await runCliImpl(["workflow", "definitions", "--scope", "local"], env, wfEmptyListIo.io, isolatedRepo), 0);
    assert.match(wfEmptyListIo.out(), /No workflow definitions found/);

    // 20. workflow add with file, named pick, and env pick (global: this directory is no KXM project)
    const wfFilePath = join(tempRepoDir, "sample-wf.yaml");
    writeFileSync(wfFilePath, "schema: kxm.workflow.v1\nid: file-wf\ndescription: File WF\nsteps: []\n", "utf8");
    const wfFileIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add", "file-wf", "--file", wfFilePath, "--scope", "global"], env, wfFileIo.io, tempRepoDir), 0);

    const wfNamedPickIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add", "--pick", "dual-critic-review", "--scope", "global"], env, wfNamedPickIo.io, tempRepoDir), 0);

    const wfEnvPickIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add", "--scope", "global"], { ...env, KXM_PICK_SELECT: "spec-and-plan" }, wfEnvPickIo.io, tempRepoDir), 0);

    // 21. workflow add missing workflowId
    const wfMissingIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add"], env, wfMissingIo.io, tempRepoDir), 1);

    // 22. workflow remove empty and missing workflowId
    const wfEmptyRemoveIo = createIo();
    assert.equal(await runCliImpl(["workflow", "remove", "--scope", "local"], env, wfEmptyRemoveIo.io, isolatedRepo), 0);
    assert.match(wfEmptyRemoveIo.out(), /No workflow definitions found in local scope to remove/);

    const wfMissingRemoveIo = createIo();
    assert.equal(await runCliImpl(["workflow", "remove", "--scope", "global"], env, wfMissingRemoveIo.io, tempRepoDir), 1);

    // 23. workflow modify empty, pick, and missing workflowId
    const wfEmptyModIo = createIo();
    assert.equal(await runCliImpl(["workflow", "modify", "--scope", "local"], env, wfEmptyModIo.io, isolatedRepo), 0);
    assert.match(wfEmptyModIo.out(), /No workflow definitions found to modify/);

    const wfPickModIo = createIo();
    assert.equal(await runCliImpl(["workflow", "modify", "--pick", "1", "--description", "Picked wf mod"], env, wfPickModIo.io, tempRepoDir), 0);

    const wfMissingModIo = createIo();
    assert.equal(await runCliImpl(["workflow", "modify"], env, wfMissingModIo.io, tempRepoDir), 1);

    rmSync(isolatedRepo, { recursive: true, force: true });
  } finally {
    rmSync(tempUserDir, { recursive: true, force: true });
    rmSync(tempRepoDir, { recursive: true, force: true });
  }
});

test("workflow add writes only what the project loader accepts, at the project root, and loadKxmProject still loads", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kxm-workflow-add-load-")));
  const project = join(root, "project");
  const workflows = join(project, ".kxm", "workflows");
  const env: NodeJS.ProcessEnv = {
    HOME: join(root, "home"),
    KXM_STATE_HOME: join(root, "state"),
    KXM_USER_CONFIG_DIR: join(root, "user-config"),
    KXM_USER_TELEMETRY_DIR: join(root, "telemetry"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    KXM_SKIP_COMPLETION_PROMPT: "1",
    KXM_SKIP_GUIDE_SETUP_PROMPT: "1",
    PATH: process.env.PATH,
  };
  const kxm = async (argv: string[], cwd = project): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const code = await runCliImpl([...argv, "--json"], env, { stdout: (text) => { out += text; }, stderr: (text) => { err += text; } }, cwd);
    return { code, out, err };
  };
  try {
    mkdirSync(join(project, "sub"), { recursive: true });
    assert.equal(spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", project]).status, 0);

    // No project to hold it yet, and a stray .kxm/ would make `kxm init` refuse.
    const early = await kxm(["workflow", "add", "demo"]);
    assert.equal(early.code, 2, early.err);
    assert.equal((JSON.parse(early.err) as { error: string }).error, "project_not_found");
    assert.equal(existsSync(join(project, ".kxm")), false);

    assert.equal((await kxm(["init", "--project-id", "prj_01JWORKFLOWLOAD0000000000", "--name", "Workflow load"])).code, 0);

    // The document `workflow add` wrote through v0.7.92: a top-level id and a role-keyed step.
    const legacy = join(root, "legacy.yaml");
    writeFileSync(legacy, [
      "schema: kxm.workflow.v1",
      "id: legacy",
      "coordinator: coordinator",
      "steps:",
      "  - id: step-1",
      "    kind: agent",
      "    role: writer",
      "    on:",
      "      passed:",
      "        target: $terminal",
      "        terminalStatus: completed",
      "",
    ].join("\n"));
    for (const dryRun of [["--dry-run"], []]) {
      const refused = await kxm(["workflow", "add", "legacy", "--file", legacy, ...dryRun]);
      assert.equal(refused.code, 2, refused.err);
      const refusal = JSON.parse(refused.err) as { error: string; issues: Array<{ file: string; message: string }> };
      assert.equal(refusal.error, "workflow_invalid");
      assert.ok(refusal.issues.every((entry) => entry.file === ".kxm/workflows/legacy.yaml"), refused.err);
      for (const message of ["/ must NOT have additional properties (id)", "/steps/0 must NOT have additional properties (role)", "/steps/0 must have required property 'agent'"]) {
        assert.ok(refusal.issues.some((entry) => entry.message === message), `${message}: ${refused.err}`);
      }
      assert.equal(existsSync(join(workflows, "legacy.yaml")), false);
    }

    // From a subdirectory the scaffold still lands where the loader reads it.
    const added = await kxm(["workflow", "add", "demo"], join(project, "sub"));
    assert.equal(added.code, 0, added.err);
    assert.equal((JSON.parse(added.out) as { filePath: string }).filePath, join(workflows, "demo.yaml"));
    assert.equal(existsSync(join(project, "sub", ".kxm")), false);
    assert.ok(loadKxmProject(project).workflows.has("demo"));

    // A file an older release left behind is judged by what replaces it, so --overwrite repairs it.
    writeFileSync(join(workflows, "demo.yaml"), readFileSync(legacy));
    assert.throws(() => loadKxmProject(project), /schema_additionalProperties/);
    const repaired = await kxm(["workflow", "add", "demo", "--overwrite"]);
    assert.equal(repaired.code, 0, repaired.err);
    assert.ok(loadKxmProject(project).workflows.has("demo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
