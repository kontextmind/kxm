import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { runCli as runCliImpl } from "../../plugins/kxm/src/cli.ts";
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
  scaffoldWorkflowDefinition,
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
    await runCliImpl(["workflow", "add", "--scope", "local", "--pick", "1"], env, createIo().io, tempRepoDir);
    assert.equal(await runCliImpl(["workflow", "definitions"], env, wfListTextIo.io, tempRepoDir), 0);
    assert.match(wfListTextIo.out(), /WORKFLOW DEFINITIONS:/);

    const wfEmptyListIo = createIo();
    assert.equal(await runCliImpl(["workflow", "definitions", "--scope", "local"], env, wfEmptyListIo.io, isolatedRepo), 0);
    assert.match(wfEmptyListIo.out(), /No workflow definitions found/);

    // 20. workflow add with file, named pick, and env pick
    const wfFilePath = join(tempRepoDir, "sample-wf.yaml");
    writeFileSync(wfFilePath, stringify(scaffoldWorkflowDefinition("File WF")), "utf8");
    const wfFileIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add", "file-wf", "--file", wfFilePath], env, wfFileIo.io, tempRepoDir), 0);

    const wfNamedPickIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add", "--pick", "dual-critic-review", "--scope", "local"], env, wfNamedPickIo.io, tempRepoDir), 0);

    const wfEnvPickIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add", "--scope", "local"], { ...env, KXM_PICK_SELECT: "spec-and-plan" }, wfEnvPickIo.io, tempRepoDir), 0);

    // 21. workflow add missing workflowId
    const wfMissingIo = createIo();
    assert.equal(await runCliImpl(["workflow", "add"], env, wfMissingIo.io, tempRepoDir), 1);

    // 22. workflow remove empty and missing workflowId
    const wfEmptyRemoveIo = createIo();
    assert.equal(await runCliImpl(["workflow", "remove", "--scope", "local"], env, wfEmptyRemoveIo.io, isolatedRepo), 0);
    assert.match(wfEmptyRemoveIo.out(), /No workflow definitions found in local scope to remove/);

    const wfMissingRemoveIo = createIo();
    assert.equal(await runCliImpl(["workflow", "remove"], env, wfMissingRemoveIo.io, tempRepoDir), 1);

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

test("workflow add dry runs do not create missing local, global, or runtime directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workflow-dry-"));
  const env = {
    KXM_USER_CONFIG_DIR: join(root, "user"),
    KXM_LOGS_DIR: join(root, "logs"),
    KXM_STATE_HOME: join(root, "state"),
  };
  const source = stringify(scaffoldWorkflowDefinition("Imported workflow"));
  writeFileSync(join(root, "source.yaml"), source, "utf8");
  try {
    for (const scope of ["local", "global"] as const) {
      for (const args of [
        ["scaffold"],
        ["from-template", "--template", "implement-and-verify"],
        ["--pick", "implement-and-verify"],
        ["from-file", "--file", "source.yaml"],
      ]) {
        let out = "";
        let err = "";
        const code = await runCliImpl(["workflow", "add", ...args, "--scope", scope, "--dry-run", "--json"], env, {
          stdout: (text) => { out += text; },
          stderr: (text) => { err += text; },
        }, root);
        assert.equal(code, 0, err);
        const result = JSON.parse(out);
        assert.equal(result.dryRun, true);
        assert.equal(result.planned[0]?.action, "write");
        assert.deepEqual(readdirSync(root), ["source.yaml"], `${scope}: ${args.join(" ")} created a path`);
        assert.equal(readFileSync(join(root, "source.yaml"), "utf8"), source);
      }
    }
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
        const code = await runCliImpl(["workflow", "add", ...args, "--json", ...(dryRun ? ["--dry-run"] : [])], env, {
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

test("workflow add picks the global definition instead of substituting the default scaffold", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-workflow-global-pick-"));
  const env = { KXM_USER_CONFIG_DIR: join(root, "user"), KXM_LOGS_DIR: join(root, "logs"), KXM_STATE_HOME: join(root, "state") };
  const source = {
    schema: "kxm.workflow.v1",
    description: "Wait for reviewed input",
    steps: [{ id: "review", kind: "wait", signal: "reviewed", on: { passed: { target: "$terminal", terminalStatus: "completed" } } }],
  };
  try {
    const installed = addWorkflowDefinition("global-review", source, { scope: "global", userConfigDir: env.KXM_USER_CONFIG_DIR, repoRoot: root });
    const original = readFileSync(installed.filePath, "utf8");
    for (const dryRun of [true, false]) {
      let out = "";
      let err = "";
      const code = await runCliImpl(["workflow", "add", "--pick", "global-review", "--json", ...(dryRun ? ["--dry-run"] : [])], env, {
        stdout: (text) => { out += text; },
        stderr: (text) => { err += text; },
      }, root);
      assert.equal(code, 0, err);
      const result = JSON.parse(out);
      assert.equal(result.workflowId, "global-review");
      if (dryRun) {
        assert.equal(existsSync(join(root, ".kxm")), false);
      } else {
        assert.deepEqual(getWorkflowDefinition("global-review", { scope: "local", repoRoot: root, userConfigDir: env.KXM_USER_CONFIG_DIR })?.workflow, source);
      }
      assert.equal(readFileSync(installed.filePath, "utf8"), original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
