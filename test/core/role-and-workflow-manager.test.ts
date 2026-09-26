import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { runCli as runCliImpl } from "../../plugins/kxm/src/cli.ts";
import { initializeKxmProject } from "../../plugins/kxm/src/init.ts";
import { loadKxmProject } from "../../plugins/kxm/src/project-config.ts";
import {
  addRole,
  getRole,
  listRoles,
  modifyRole,
  parseRoleFile,
  removeRole,
  type KxmRoleDefinition,
} from "../../plugins/kxm/src/role.ts";
import { setRouteState } from "../../plugins/kxm/src/routes.ts";
import {
  addWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  modifyWorkflowDefinition,
  parseWorkflowFile,
  removeWorkflowDefinition,
  scaffoldWorkflowDefinition,
} from "../../plugins/kxm/src/workflow-manager.ts";

test("Role subsystem: add, get, list, modify, remove with global/local scoping", () => {
  const tempUserDir = mkdtempSync(join(tmpdir(), "kxm-user-roles-"));
  const tempRepoDir = mkdtempSync(join(tmpdir(), "kxm-repo-roles-"));

  try {
    addRole({
      schema: "kxm.role.v2", id: "writer", purpose: "writer", permission: "edit",
      description: "Primary implementation agent.", roster: [{ route: "grok-native", effort: "medium" }],
    }, { scope: "global", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    addRole({
      schema: "kxm.role.v2", id: "planner", purpose: "planner", permission: "read-only",
      description: "Plans the change.", roster: [{ route: "fable-claude", effort: "medium" }],
    }, { scope: "global", repoRoot: tempRepoDir, userConfigDir: tempUserDir });
    const globalRoles = listRoles({ scope: "global", userConfigDir: tempUserDir, repoRoot: tempRepoDir });
    assert.ok(globalRoles.some((r) => r.id === "writer"));
    assert.ok(globalRoles.some((r) => r.id === "planner"));

    // 2. Add local role
    const customRole: KxmRoleDefinition = {
      schema: "kxm.role.v2",
      id: "sec-specialist",
      purpose: "experiment",
      permission: "read-only",
      description: "AppSec and fuzzing auditor",
      skills: ["appsec", "fuzzing"],
      tools: { preset: "auditor", allow: ["view_file", "run_command"] },
      produces: [{ template: "audit-report" }],
      roster: [{ route: "grok-native", effort: "high" }],
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
      schema: "kxm.role.v2",
      id: "writer",
      purpose: "writer",
      permission: "edit",
      description: "Custom project writer with strict repo tools",
      skills: ["kxm", "custom-skill"],
      tools: { allow: ["view_file", "write_to_file"] },
      roster: [{ route: "grok-native" }],
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
      description: "Global standard code review workflow",
      steps: [
        { id: "review", kind: "agent", agent: "critic-arch", on: { passed: { target: "$terminal", terminalStatus: "completed" } } },
      ],
    };
    const addGlobal = addWorkflowDefinition("global-review", globalWf, { scope: "global", userConfigDir: tempUserDir, repoRoot: tempRepoDir });
    assert.equal(addGlobal.scope, "global");

    // 2. Add local workflow
    const localWf = {
      schema: "kxm.workflow.v1",
      description: "Local project feature development",
      steps: [
        { id: "plan", kind: "agent", agent: "planner", on: { passed: "implement" } },
        { id: "implement", kind: "agent", agent: "writer", on: { passed: "verify" } },
        { id: "verify", kind: "gate", gate: "verify-gate", on: { passed: { target: "$terminal", terminalStatus: "completed" } } },
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
  const tempUserDir = mkdtempSync(join(tmpdir(), "kxm-cli-user-"));
  const tempRepoDir = mkdtempSync(join(tmpdir(), "kxm-cli-repo-"));
  // Local roles belong to a KXM project.
  assert.equal(spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", tempRepoDir]).status, 0);
  initializeKxmProject(tempRepoDir, { projectId: "prj_01JROLECLI0000000000000000" });
  rmSync(join(tempRepoDir, ".kxm", "roles", "writer.yaml"), { force: true });
  rmSync(join(tempRepoDir, ".kxm", "roles", "planner.yaml"), { force: true });

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

    const addPickIo = createIo();
    const addPickCode = await runCliImpl(["role", "add", "writer", "--scope", "global", "--description", "Primary implementation agent."], env, addPickIo.io, tempRepoDir);
    assert.equal(addPickCode, 0);
    assert.match(addPickIo.out(), /Added role 'writer' to global/);
    assert.equal(await runCliImpl(["role", "add", "planner", "--scope", "global", "--description", "Plans the change."], env, createIo().io, tempRepoDir), 0);

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
      "--route", "grok-default",
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
      "--add-route", "fable-default",
      "--scope", "local",
    ], env, modifyIo.io, tempRepoDir);
    assert.equal(modCode, 0);

    const getModifiedIo = createIo();
    await runCliImpl(["--json", "role", "get", "qa-lead"], env, getModifiedIo.io, tempRepoDir);
    const parsedModified = JSON.parse(getModifiedIo.out());
    assert.equal(parsedModified.role.description, "Senior QA Lead");
    assert.ok(parsedModified.role.skills.includes("load-testing"));
    assert.ok(!parsedModified.role.skills.includes("e2e"));
    assert.ok(parsedModified.role.roster.some((r: { route?: string }) => r.route === "fable-default"));

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
    writeFileSync(fileRolePath, "schema: kxm.role.v2\nid: file-role\npurpose: experiment\npermission: read-only\ndescription: Role from file\nroster: []\n", "utf8");
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
    writeFileSync(wfFilePath, stringify(scaffoldWorkflowDefinition("File WF")), "utf8");
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

test("Workflow resource IDs fail before directory creation or path-based access", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workflow-ids-"));
  const repoRoot = join(root, "repo");
  const userConfigDir = join(root, "user");
  try {
    const invalidIds = [
      "software-engineering/bug-fix",
      "../escape",
      "..\\escape",
      "C:\\escape",
      "workflow.yaml",
      "Uppercase",
      "9workflow",
      "two--hyphens",
      "trailing_",
      "con",
      "a".repeat(65),
      "",
    ];
    for (const scope of ["local", "global"] as const) {
      for (const id of invalidIds) {
        const options = { repoRoot, userConfigDir, scope };
        assert.throws(() => addWorkflowDefinition(id, undefined, options), /workflow_id_invalid/, `${scope}: add ${id}`);
        assert.throws(() => getWorkflowDefinition(id, options), /workflow_id_invalid/, `${scope}: get ${id}`);
        assert.throws(() => modifyWorkflowDefinition(id, { description: "invalid" }, options), /workflow_id_invalid/, `${scope}: modify ${id}`);
        assert.throws(() => removeWorkflowDefinition(id, options), /workflow_id_invalid/, `${scope}: remove ${id}`);
        assert.deepEqual(readdirSync(root), [], `${scope}: ${id} must not create any directory`);
      }
    }

    for (const id of ["review_v2", "a".repeat(64)]) {
      addWorkflowDefinition(id, undefined, { repoRoot, userConfigDir });
      assert.equal(getWorkflowDefinition(id, { repoRoot, userConfigDir })?.scope, "local");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Workflow installation rejects invalid YAML, legacy role steps, and invalid transitions before writing", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workflow-content-"));
  const options = { repoRoot: join(root, "repo"), userConfigDir: join(root, "user") };
  try {
    const invalidDocuments: Array<{ content: Record<string, unknown> | string; error: RegExp }> = [
      { content: "schema: [unterminated", error: /invalid_yaml/ },
      {
        content: {
          schema: "kxm.workflow.v1",
          steps: [{ id: "implement", kind: "agent", role: "writer" }],
        },
        error: /agent/,
      },
      {
        content: {
          schema: "kxm.workflow.v1",
          steps: [{ id: "implement", kind: "agent", agent: "implementer", on: { passed: "missing-step" } }],
        },
        error: /transition_target_unknown/,
      },
    ];
    for (const scope of ["local", "global"] as const) {
      for (const dryRun of [false, true]) {
        for (const { content, error } of invalidDocuments) {
          assert.throws(() => addWorkflowDefinition("invalid", content, { ...options, scope, dryRun }), error);
          assert.deepEqual(readdirSync(root), [], `${scope}, dryRun=${dryRun}: invalid content must not create any directory`);
        }
      }
    }

    const installed = addWorkflowDefinition("preserved", undefined, options);
    const original = readFileSync(installed.filePath, "utf8");
    assert.throws(() => addWorkflowDefinition("preserved", invalidDocuments[1]!.content, { ...options, overwrite: true }), /agent/);
    assert.equal(readFileSync(installed.filePath, "utf8"), original, "invalid overwrite preserves the existing workflow");
    assert.throws(() => modifyWorkflowDefinition("preserved", { steps: [] }, options), /steps/);
    assert.equal(readFileSync(installed.filePath, "utf8"), original, "invalid modification preserves the existing workflow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow add global dry runs do not create missing configuration or runtime directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workflow-dry-"));
  const env = {
    KXM_USER_CONFIG_DIR: join(root, "user"),
    KXM_LOGS_DIR: join(root, "logs"),
    KXM_STATE_HOME: join(root, "state"),
  };
  const source = stringify(scaffoldWorkflowDefinition("Imported workflow"));
  writeFileSync(join(root, "source.yaml"), source, "utf8");
  try {
    for (const args of [
      ["scaffold"],
      ["from-template", "--template", "implement-and-verify"],
      ["--pick", "implement-and-verify"],
      ["from-file", "--file", "source.yaml"],
    ]) {
      let out = "";
      let err = "";
      const code = await runCliImpl(["workflow", "add", ...args, "--scope", "global", "--dry-run", "--json"], env, {
        stdout: (text) => { out += text; },
        stderr: (text) => { err += text; },
      }, root);
      assert.equal(code, 0, err);
      const result = JSON.parse(out);
      assert.equal(result.dryRun, true);
      assert.equal(result.planned[0]?.action, "write");
      assert.deepEqual(readdirSync(root), ["source.yaml"], `${args.join(" ")} created a path`);
      assert.equal(readFileSync(join(root, "source.yaml"), "utf8"), source);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow add writes only what the project loader accepts, at the project root, and loadKxmProject still loads", async () => {
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

    const source = join(root, "source.yaml");
    writeFileSync(source, stringify(scaffoldWorkflowDefinition("Imported workflow")), "utf8");
    const beforeDryRun = readdirSync(root, { recursive: true }).sort();
    for (const args of [
      ["dry-scaffold"],
      ["dry-template", "--template", "implement-and-verify"],
      ["dry-pick", "--pick", "implement-and-verify"],
      ["dry-file", "--file", source],
    ]) {
      const planned = await kxm(["workflow", "add", ...args, "--dry-run"], join(project, "sub"));
      assert.equal(planned.code, 0, planned.err);
      assert.equal(JSON.parse(planned.out).dryRun, true);
      assert.deepEqual(readdirSync(root, { recursive: true }).sort(), beforeDryRun);
    }

    // Schema-valid documents must also resolve their agents in this project.
    const unknownAgent = join(root, "unknown-agent.yaml");
    writeFileSync(unknownAgent, stringify({
      schema: "kxm.workflow.v1",
      steps: [{ id: "implement", kind: "agent", agent: "missing-agent", on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
    }));
    for (const dryRun of [["--dry-run"], []]) {
      const refused = await kxm(["workflow", "add", "unknown-agent", "--file", unknownAgent, ...dryRun]);
      assert.equal(refused.code, 2, refused.err);
      const refusal = JSON.parse(refused.err) as { error: string; issues: Array<{ code: string }> };
      assert.equal(refusal.error, "workflow_invalid");
      assert.ok(refusal.issues.some((entry) => entry.code === "agent_unknown"), refused.err);
      assert.equal(existsSync(join(workflows, "unknown-agent.yaml")), false);
    }

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
      const refusal = JSON.parse(refused.err) as { error: string; issues: Array<{ file: string; code: string }> };
      assert.equal(refusal.error, "workflow_invalid");
      assert.ok(refusal.issues.every((entry) => entry.file === ".kxm/workflows/legacy.yaml"), refused.err);
      for (const code of ["schema_additionalProperties", "schema_required"]) {
        assert.ok(refusal.issues.some((entry) => entry.code === code), refused.err);
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
    const blocked = await kxm(["workflow", "add", "another"]);
    assert.equal(blocked.code, 2, blocked.err);
    assert.equal(JSON.parse(blocked.err).error, "workflow_invalid");
    assert.equal(existsSync(join(workflows, "another.yaml")), false);
    const repaired = await kxm(["workflow", "add", "demo", "--overwrite"]);
    assert.equal(repaired.code, 0, repaired.err);
    assert.ok(loadKxmProject(project).workflows.has("demo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow add reports file and ID failures through the CLI without installing anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workflow-errors-"));
  const env = { KXM_USER_CONFIG_DIR: join(root, "user"), KXM_LOGS_DIR: join(root, "logs"), KXM_STATE_HOME: join(root, "state") };
  writeFileSync(join(root, "bad.yaml"), "schema: [unterminated", "utf8");
  writeFileSync(join(root, "legacy.yaml"), "schema: kxm.workflow.v1\nsteps:\n  - id: implement\n    kind: agent\n    role: writer\n", "utf8");
  try {
    for (const dryRun of [false, true]) {
      const failures: Array<{ args: string[]; message: RegExp }> = [
        { args: ["nested/workflow"], message: /workflow_id_invalid/ },
        { args: ["nested/workflow", "--pick", "implement-and-verify"], message: /workflow_id_invalid/ },
        { args: ["imported", "--file", "missing.yaml"], message: /missing\.yaml/ },
        { args: ["imported", "--file", "bad.yaml"], message: /yaml/ },
        { args: ["imported", "--file", "legacy.yaml"], message: /agent/ },
        { args: ["imported", "--file", ""], message: /EISDIR|EPERM|EACCES/ },
      ];
      for (const { args, message } of failures) {
        let out = "";
        let err = "";
        const code = await runCliImpl(["workflow", "add", ...args, "--scope", "global", "--json", ...(dryRun ? ["--dry-run"] : [])], env, {
          stdout: (text) => { out += text; },
          stderr: (text) => { err += text; },
        }, root);
        assert.equal(code, 1, args.join(" "));
        assert.equal(out, "");
        const result = JSON.parse(err);
        assert.equal(result.ok, false);
        assert.equal(result.error, "workflow_add_failed");
        assert.match(result.message, message);
        assert.deepEqual(readdirSync(root).sort(), ["bad.yaml", "legacy.yaml"]);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow add --pick <global-id> copies that global definition into the project, and refuses one the project loader rejects", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kxm-workflow-pick-global-")));
  const project = join(root, "project");
  const workflows = join(project, ".kxm", "workflows");
  const globalWorkflows = join(root, "user-config", "workflows");
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
  const kxm = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const code = await runCliImpl([...argv, "--json"], env, { stdout: (text) => { out += text; }, stderr: (text) => { err += text; } }, project);
    return { code, out, err };
  };
  try {
    mkdirSync(project, { recursive: true });
    assert.equal(spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", project]).status, 0);
    assert.equal((await kxm(["init", "--project-id", "prj_01JWORKFLOWPICKGLOBAL0000", "--name", "Workflow pick"])).code, 0);

    // The two-step template, kept globally, arrives in the project as written, not as the one-step scaffold.
    const kept = await kxm(["workflow", "add", "gdemo", "--scope", "global", "--template", "spec-and-plan"]);
    assert.equal(kept.code, 0, kept.err);
    const original = readFileSync(join(globalWorkflows, "gdemo.yaml"), "utf8");
    for (const dryRun of [true, false]) {
      const picked = await kxm(["workflow", "add", "--pick", "gdemo", ...(dryRun ? ["--dry-run"] : [])]);
      assert.equal(picked.code, 0, picked.err);
      assert.equal(JSON.parse(picked.out).workflowId, "gdemo");
      assert.equal(existsSync(join(workflows, "gdemo.yaml")), !dryRun);
      if (!dryRun) {
        assert.deepEqual(loadKxmProject(project).workflows.get("gdemo")?.value, parseWorkflowFile(join(globalWorkflows, "gdemo.yaml")));
      }
      assert.equal(readFileSync(join(globalWorkflows, "gdemo.yaml"), "utf8"), original);
    }

    // A valid `.yml` copy supports an explicit destination and a local-only description.
    const ymlSource = join(globalWorkflows, "yml-review.yml");
    writeFileSync(ymlSource, original);
    for (const dryRun of [true, false]) {
      const copied = await kxm(["workflow", "add", "local-review", "--pick", "yml-review", "--description", "Custom", ...(dryRun ? ["--dry-run"] : [])]);
      assert.equal(copied.code, 0, copied.err);
      assert.equal(JSON.parse(copied.out).workflowId, "local-review");
      assert.equal(existsSync(join(workflows, "local-review.yaml")), !dryRun);
      assert.equal(existsSync(join(workflows, "yml-review.yaml")), false);
      if (!dryRun) {
        assert.deepEqual(loadKxmProject(project).workflows.get("local-review")?.value, {
          ...parseWorkflowFile(ymlSource),
          description: "Custom",
        });
      }
      assert.equal(readFileSync(ymlSource, "utf8"), original);
    }

    // A `.yml` global in the shape written through v0.7.92 is listed for the pick, and the project loader refuses it.
    writeFileSync(join(globalWorkflows, "gold.yml"), [
      "schema: kxm.workflow.v1",
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
    const refused = await kxm(["workflow", "add", "--pick", "gold"]);
    assert.equal(refused.code, 2, refused.out);
    assert.equal((JSON.parse(refused.err) as { error: string }).error, "workflow_invalid");
    assert.equal(existsSync(join(workflows, "gold.yaml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("role add --pick <global-id> copies that global role into the project, with --description, --skills and --route applied over it", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kxm-role-pick-global-")));
  const project = join(root, "project");
  const roles = join(project, ".kxm", "roles");
  const globalRoles = join(root, "user-config", "roles");
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
  const kxm = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const code = await runCliImpl([...argv, "--json"], env, { stdout: (text) => { out += text; }, stderr: (text) => { err += text; } }, project);
    return { code, out, err };
  };
  try {
    mkdirSync(project, { recursive: true });
    assert.equal(spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", project]).status, 0);
    assert.equal((await kxm(["init", "--project-id", "prj_01JROLEPICKGLOBAL00000000", "--name", "Role pick"])).code, 0);

    // A global role arrives in the project as written, not as an empty role under its id.
    const kept = await kxm(["role", "add", "qa-lead", "--scope", "global", "--description", "QA lead", "--skills", "testing,e2e", "--route", "grok-default"]);
    assert.equal(kept.code, 0, kept.err);
    const picked = await kxm(["role", "add", "--pick", "qa-lead"]);
    assert.equal(picked.code, 0, picked.err);
    assert.equal((JSON.parse(picked.out) as { filePath: string }).filePath, join(roles, "qa-lead.yaml"));
    assert.deepEqual(parseRoleFile(join(roles, "qa-lead.yaml")), parseRoleFile(join(globalRoles, "qa-lead.yaml")));

    // A `.yml` global, which a lookup by `<id>.yaml` misses, takes the overrides and keeps the rest.
    writeFileSync(join(globalRoles, "reviewer.yml"), [
      "schema: kxm.role.v2",
      "id: reviewer",
      "purpose: experiment",
      "permission: read-only",
      "description: Reviews diffs",
      "skills:",
      "  - review",
      "tools:",
      "  preset: critic",
      "roster:",
      "  - route: sol-codex",
      "",
    ].join("\n"));
    const overridden = await kxm(["role", "add", "--pick", "reviewer", "--description", "Project reviewer", "--skills", "review,security", "--route", "fable-default"]);
    assert.equal(overridden.code, 0, overridden.err);
    const copy = parseRoleFile(join(roles, "reviewer.yaml"));
    assert.equal(copy?.description, "Project reviewer");
    assert.deepEqual(copy?.skills, ["review", "security"]);
    assert.deepEqual(copy?.roster, [{ route: "fable-default" }]);
    assert.deepEqual(copy?.tools, { preset: "critic" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("role add writes a local role only at the project root, and only if the project loader accepts it", async () => {
  const { runCli: runCliImpl } = await import("../../plugins/kxm/src/cli.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kxm-role-add-load-")));
  const project = join(root, "project");
  const roles = join(project, ".kxm", "roles");
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
    const early = await kxm(["role", "add", "early"]);
    assert.equal(early.code, 2, early.err);
    assert.equal((JSON.parse(early.err) as { error: string }).error, "project_not_found");
    assert.equal(existsSync(join(project, ".kxm")), false);

    assert.equal((await kxm(["init", "--project-id", "prj_01JROLEADDLOAD000000000000", "--name", "Role load"])).code, 0);
    rmSync(join(roles, "writer.yaml"));
    mkdirSync(join(root, "user-config", "roles"), { recursive: true });
    writeFileSync(join(root, "user-config", "roles", "writer.yaml"), "schema: kxm.role.v2\nid: writer\npurpose: writer\npermission: edit\ndescription: Global writer.\nroster:\n  - route: grok-default\n");
    // An implementer on a model the built-in writer template's roster leaves out.
    const implementer = join(project, ".kxm", "agents", "implementer.yaml");
    const undeclared = readFileSync(implementer, "utf8").replace(/^harness:.*\n/m, "").replace(/^model:.*\n(?: {2}.*\n)*/m, "");
    writeFileSync(implementer, `${undeclared}harness: claude\nmodel:\n  provider: anthropic\n  model: claude-fable-5-1\n`);
    assert.ok(loadKxmProject(project));

    // The writer template's roster leaves out the implementer's model, so the loader would refuse the project.
    for (const dryRun of [["--dry-run"], []]) {
      const refused = await kxm(["role", "add", "--pick", "writer", ...dryRun]);
      assert.equal(refused.code, 2, refused.err);
      const refusal = JSON.parse(refused.err) as { error: string; issues: Array<{ code: string; file: string }> };
      assert.equal(refusal.error, "role_invalid");
      assert.ok(refusal.issues.some((entry) => entry.code === "role_roster_conflicts_with_agent" && entry.file === ".kxm/roles/writer.yaml"), refused.err);
      assert.equal(existsSync(join(roles, "writer.yaml")), false);
    }

    // With the implementer's model, from a subdirectory, the role lands where the loader reads it.
    writeFileSync(join(project, ".kxm", "models", "fable-agent.yaml"), "schema: kxm.model.v2\nid: fable-agent\nharness: claude\nmodel: claude-fable-5-1\nvendor: anthropic\nstatus: admitted\npermissions:\n  - edit\n");
    const added = await kxm(["role", "add", "--pick", "writer", "--route", "fable-agent"], join(project, "sub"));
    assert.equal(added.code, 0, added.err);
    assert.equal((JSON.parse(added.out) as { filePath: string }).filePath, join(roles, "writer.yaml"));
    assert.equal(existsSync(join(project, "sub", ".kxm")), false);
    assert.ok(loadKxmProject(project));

    // A conflicting writer left on disk is judged by what replaces it, so --overwrite repairs it.
    writeFileSync(join(roles, "writer.yaml"), "schema: kxm.role.v2\nid: writer\npurpose: writer\npermission: edit\ndescription: Conflicting writer.\nroster:\n  - route: grok-default\n");
    assert.throws(() => loadKxmProject(project), /role_roster_conflicts_with_agent/);
    const repaired = await kxm(["role", "add", "writer", "--route", "fable-agent", "--overwrite"]);
    assert.equal(repaired.code, 0, repaired.err);
    assert.ok(loadKxmProject(project));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setRouteState refuses an unknown route and does not default a new role to edit", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-route-bind-"));
  try {
    assert.throws(() => setRouteState(root, "xai/missing-model", "admitted", "planner"), /unknown route/);
    assert.equal(existsSync(join(root, ".kxm", "routes.yaml")), false);
    mkdirSync(join(root, ".kxm", "models"), { recursive: true });
    writeFileSync(join(root, ".kxm", "models", "planner-route.yaml"), [
      "schema: kxm.model.v2",
      "id: planner-route",
      "harness: claude",
      "model: fable",
      "vendor: anthropic",
      "status: admitted",
      "permissions:",
      "  - read-only",
      "",
    ].join("\n"));
    setRouteState(root, "anthropic/fable", "admitted", "planner");
    const role = parseRoleFile(join(root, ".kxm", "roles", "planner.yaml"));
    assert.equal(role?.purpose, "planner");
    assert.equal(role?.permission, "read-only");
    assert.deepEqual(role?.roster, [{ route: "planner-route" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
