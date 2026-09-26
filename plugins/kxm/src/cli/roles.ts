import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DatabaseSync, openReadOnlyDatabase } from "../sqlite.ts";
import {
  listRoles,
  getRole,
  addRole,
  removeRole,
  modifyRole,
  parseRoleFile,
  rolePurposeForId,
  type KxmRoleDefinition,
} from "../role.ts";
import { discoverKxmProjectRoot, kxmRoleWriteIssues } from "../project-config.ts";
import { ensureKxmSupervisor, kxmRuntimeRequest } from "../runtime-supervisor.ts";
import { projectRuntimeOwnsRun } from "../runtime-store.ts";
import { resumeWorkflowFromRuling, type WorkflowRun } from "../workflow.ts";
import { print, printPlan, type CliIo, type Runtime } from "./types.ts";

export interface PickCandidate {
  id: string;
  label?: string | undefined;
  description?: string | undefined;
  payload?: any;
}

export async function resolvePickItem(
  io: CliIo,
  title: string,
  items: PickCandidate[],
  pickOption?: string | boolean | undefined,
  env?: NodeJS.ProcessEnv | undefined,
): Promise<PickCandidate | undefined> {
  if (items.length === 0) return undefined;

  if (typeof pickOption === "string" && pickOption.trim().length > 0) {
    const trimmed = pickOption.trim();
    const asNum = parseInt(trimmed, 10);
    if (!isNaN(asNum) && asNum >= 1 && asNum <= items.length) {
      return items[asNum - 1];
    }
    const matched = items.find((it) => it.id === trimmed || it.id.toLowerCase() === trimmed.toLowerCase());
    if (matched) return matched;
  }

  const lines: string[] = [`${title}:`];
  items.forEach((item, idx) => {
    const desc = item.description ? ` - ${item.description}` : "";
    const label = item.label ? ` [${item.label}]` : "";
    lines.push(`  ${(idx + 1).toString().padStart(2)}) ${item.id}${label}${desc}`);
  });
  io.stdout(`${lines.join("\n")}\n`);

  const envSelect = env?.KXM_PICK_SELECT ?? process.env.KXM_PICK_SELECT;
  if (envSelect) {
    const asNum = parseInt(envSelect, 10);
    if (!isNaN(asNum) && asNum >= 1 && asNum <= items.length) {
      return items[asNum - 1];
    }
    const matched = items.find((it) => it.id === envSelect);
    if (matched) return matched;
  }

  if (!process.stdin.isTTY) {
    return undefined;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolvePrompt) => {
    rl.question(`Enter selection (1-${items.length}) or ID: `, (answer) => {
      rl.close();
      const ans = answer.trim();
      const asNum = parseInt(ans, 10);
      if (!isNaN(asNum) && asNum >= 1 && asNum <= items.length) {
        resolvePrompt(items[asNum - 1]);
      } else {
        const matched = items.find((it) => it.id === ans);
        resolvePrompt(matched ?? undefined);
      }
    });
  });
}

export async function cmdRoleList(
  runtime: Runtime,
  options: { scope?: "all" | "global" | "local" | undefined },
): Promise<number> {
  const roles = listRoles({
    scope: options.scope,
    repoRoot: runtime.cwd,
    userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
  });
  if (runtime.json) {
    print(runtime.io, true, { ok: true, command: "role list", roles }, "");
    return 0;
  }
  if (roles.length === 0) {
    runtime.io.stdout("No roles configured.\n");
    return 0;
  }
  const lines: string[] = ["ROLES:"];
  for (const r of roles) {
    const scopeTag = r.scope === "overridden" ? "[local override]" : `[${r.scope}]`;
    const modelTag = r.primaryRoute ? `(${r.primaryRoute})` : "";
    lines.push(`  ${r.id.padEnd(16)} ${scopeTag.padEnd(16)} ${modelTag.padEnd(28)} ${r.description}`);
  }
  print(runtime.io, false, {}, `${lines.join("\n")}\n`);
  return 0;
}

export async function cmdRoleGet(
  runtime: Runtime,
  roleId: string,
  options: { scope?: "all" | "global" | "local" | undefined },
): Promise<number> {
  const result = getRole(roleId, {
    scope: options.scope,
    repoRoot: runtime.cwd,
    userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
  });
  if (!result) {
    runtime.io.stderr(`kxm: role '${roleId}' not found\n`);
    return 1;
  }
  print(
    runtime.io,
    runtime.json,
    { ok: true, command: "role get", roleId, scope: result.scope, filePath: result.filePath, role: result.role },
    stringifyYaml(result.role),
  );
  return 0;
}

export async function cmdRoleAdd(
  runtime: Runtime,
  roleId: string | undefined,
  options: {
    file?: string | undefined;
    description?: string | undefined;
    skills?: string | undefined;
    harness?: string | undefined;
    model?: string | undefined;
    scope?: "global" | "local" | undefined;
    overwrite?: boolean | undefined;
    pick?: string | boolean | undefined;
  },
): Promise<number> {
  const scope = options.scope ?? "local";
  let base: KxmRoleDefinition | undefined;
  if (!roleId || options.pick) {
    const candidates: PickCandidate[] = [];
    if (scope === "local") {
      const globalRoles = listRoles({ scope: "global", userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
      for (const gr of globalRoles) {
        // The listing is a summary; the copy needs the definition, read from the listed file (it may be `.yml`).
        const definition = parseRoleFile(gr.filePath);
        if (definition && !candidates.some((c) => c.id === gr.id)) {
          candidates.push({ id: gr.id, description: gr.description, label: "global", payload: definition });
        }
      }
    }
    const picked = await resolvePickItem(runtime.io, `Select a role template to add (${scope})`, candidates, options.pick, runtime.env);
    if (!picked) {
      if (!roleId) {
        runtime.io.stderr("role add failed: missing roleId or pick selection\n");
        return 1;
      }
    } else {
      roleId = picked.id;
      base = picked.payload as KxmRoleDefinition;
    }
  }

  const skills = options.skills ? options.skills.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const roster = options.model ? [{ route: options.model }] : undefined;
  const purpose = rolePurposeForId(roleId ?? "experiment");
  let roleDef: KxmRoleDefinition;
  if (options.file) {
    const filePath = resolve(runtime.cwd, options.file);
    const content = readFileSync(filePath, "utf8");
    roleDef = parseYaml(content) as KxmRoleDefinition;
    roleDef.id = roleId!;
    roleDef.schema = "kxm.role.v2";
    roleDef.purpose ??= rolePurposeForId(roleDef.id);
    roleDef.permission ??= roleDef.purpose === "writer" ? "edit" : "read-only";
  } else if (base) {
    roleDef = {
      ...base,
      schema: "kxm.role.v2",
      description: options.description || base.description,
      skills: skills ?? base.skills,
      roster: roster ?? base.roster,
    };
  } else {
    roleDef = {
      schema: "kxm.role.v2",
      id: roleId!,
      purpose,
      permission: purpose === "writer" ? "edit" : "read-only",
      description: options.description || `Role ${roleId}`,
      skills: skills ?? [],
      roster: roster ?? [],
    };
  }

  // A local role file sits in the project the loader reads, and the loader refuses the
  // whole project over a writer roster it rejects, so the role is checked before it lands.
  let repoRoot = runtime.cwd;
  if (scope === "local") {
    const projectRoot = discoverKxmProjectRoot(runtime.cwd);
    if (!projectRoot) {
      print(
        runtime.io,
        runtime.json,
        { ok: false, command: "role add", error: "project_not_found" },
        "role add failed: local roles belong to a KXM project; run kxm init at the repository root, or pass --scope global",
      );
      return 2;
    }
    const issues = kxmRoleWriteIssues(projectRoot, roleDef.id, stringifyYaml(roleDef));
    if (issues.length > 0) {
      print(
        runtime.io,
        runtime.json,
        { ok: false, command: "role add", error: "role_invalid", issues },
        `role add failed: with this role the project would not load, so nothing was written\n${issues.map((entry) => `  ${entry.file}: ${entry.code}: ${entry.message}`).join("\n")}`,
      );
      return 2;
    }
    repoRoot = projectRoot;
  }

  try {
    const res = addRole(roleDef, {
      scope,
      repoRoot,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
      overwrite: options.overwrite,
      dryRun: runtime.dryRun,
    });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "role add", roleId, ...res }, [{ action: "write", target: res.filePath }], `add role '${roleId}' to ${res.scope}`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "role add", roleId, ...res },
      `Added role '${roleId}' to ${res.scope} (${res.filePath})\n`,
    );
    return 0;
  } catch (err: unknown) {
    runtime.io.stderr(`role add failed: ${(err as Error).message}\n`);
    return 1;
  }
}

export async function cmdRoleRemove(
  runtime: Runtime,
  roleId: string | undefined,
  options: { scope?: "global" | "local" | undefined; pick?: string | boolean | undefined },
): Promise<number> {
  const scope = options.scope ?? "local";
  if (!roleId || options.pick) {
    const roles = listRoles({
      scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
    });
    if (roles.length === 0) {
      runtime.io.stdout(`No roles configured in ${scope} scope to remove.\n`);
      return 0;
    }
    const candidates: PickCandidate[] = roles.map((r) => ({
      id: r.id,
      description: r.description,
      label: r.scope,
    }));
    const picked = await resolvePickItem(runtime.io, `Select a role to remove (${scope})`, candidates, options.pick, runtime.env);
    if (!picked) {
      if (!roleId) {
        runtime.io.stderr("role remove failed: missing roleId or pick selection\n");
        return 1;
      }
    } else {
      roleId = picked.id;
    }
  }

  try {
    const res = removeRole(roleId!, {
      scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
      dryRun: runtime.dryRun,
    });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "role remove", roleId, ...res }, [{ action: "delete", target: res.filePath }], `remove role '${roleId}' from ${res.scope}`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "role remove", roleId, ...res },
      `Removed role '${roleId}' from ${res.scope}\n`,
    );
    return 0;
  } catch (err: unknown) {
    runtime.io.stderr(`role remove failed: ${(err as Error).message}\n`);
    return 1;
  }
}

export async function cmdRoleModify(
  runtime: Runtime,
  roleId: string | undefined,
  options: {
    description?: string | undefined;
    addSkill?: string | undefined;
    removeSkill?: string | undefined;
    addRoute?: string | undefined;
    removeRoute?: string | undefined;
    scope?: "global" | "local" | undefined;
    pick?: string | boolean | undefined;
  },
): Promise<number> {
  if (!roleId || options.pick) {
    const roles = listRoles({
      scope: options.scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
    });
    if (roles.length === 0) {
      runtime.io.stdout("No roles configured to modify.\n");
      return 0;
    }
    const candidates: PickCandidate[] = roles.map((r) => ({
      id: r.id,
      description: r.description,
      label: r.scope,
    }));
    const picked = await resolvePickItem(runtime.io, "Select a role to modify", candidates, options.pick, runtime.env);
    if (!picked) {
      if (!roleId) {
        runtime.io.stderr("role modify failed: missing roleId or pick selection\n");
        return 1;
      }
    } else {
      roleId = picked.id;
    }
  }

  const existing = getRole(roleId!, {
    scope: options.scope,
    repoRoot: runtime.cwd,
    userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
  });
  if (!existing) {
    runtime.io.stderr(`kxm: role '${roleId}' not found\n`);
    return 1;
  }

  const role = existing.role;
  let skills = [...(role.skills ?? [])];
  if (options.addSkill && !skills.includes(options.addSkill)) {
    skills.push(options.addSkill);
  }
  if (options.removeSkill) {
    skills = skills.filter((s) => s !== options.removeSkill);
  }

  let roster = [...(role.roster ?? [])];
  if (options.addRoute) {
    const routeId = options.addRoute;
    const projectRoot = discoverKxmProjectRoot(runtime.cwd) ?? runtime.cwd;
    const modelFile = join(projectRoot, ".kxm", "models", `${routeId}.yaml`);
    if (!existsSync(modelFile)) {
      runtime.io.stderr(`kxm: route '${routeId}' is not a file under .kxm/models/\n`);
      return 1;
    }
    if (!roster.some((entry) => entry.route === routeId)) roster.push({ route: routeId });
  }
  if (options.removeRoute) {
    roster = roster.filter((entry) => entry.route !== options.removeRoute);
  }

  const updates: Partial<KxmRoleDefinition> = {
    ...(options.description ? { description: options.description } : {}),
    skills,
    roster,
  };

  try {
    const res = modifyRole(roleId!, updates, {
      scope: options.scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
      dryRun: runtime.dryRun,
    });
    if (runtime.dryRun) {
      printPlan(runtime, { command: "role modify", roleId, ...res }, [{ action: "write", target: res.filePath }], `modify role '${roleId}' in ${res.scope}`);
      return 0;
    }
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "role modify", roleId, ...res },
      `Modified role '${roleId}' in ${res.scope}\n`,
    );
    return 0;
  } catch (err: unknown) {
    runtime.io.stderr(`role modify failed: ${(err as Error).message}\n`);
    return 1;
  }
}

export async function cmdRoleResume(
  runtime: Runtime,
  runId: string,
  ruling?: string | undefined,
): Promise<number> {
  if (!runId) {
    runtime.io.stderr("kxm role resume requires <runId>\n");
    return 1;
  }

  const effectiveRuling = ruling?.trim() || "operator_ruling: waived and resumed";

  // A run this project's Runtime owns; a hub workflow run of the same id shape falls through.
  const projectRoot = discoverKxmProjectRoot(runtime.cwd);
  if (projectRoot && projectRuntimeOwnsRun(projectRoot, runId, runtime.env)) {
    if (runtime.dryRun) {
      printPlan(
        runtime,
        { command: "role resume", runId, ruling: effectiveRuling },
        [{ action: "request", target: `POST kxm-runtime /v1/runs/${runId}/signal (audit_escalation unblock)` }],
        `resume KXM run ${runId}`,
      );
      return 0;
    }
    try {
      const supervisor = await ensureKxmSupervisor({ env: runtime.env });
      const posted = await kxmRuntimeRequest(
        supervisor,
        "POST",
        `/v1/runs/${encodeURIComponent(runId)}/signal?projectRoot=${encodeURIComponent(projectRoot)}`,
        {
          signalKey: "audit_escalation",
          status: "passed",
          summary: effectiveRuling,
          action: "unblock",
        },
      );
      print(
        runtime.io,
        runtime.json,
        { ok: true, command: "role resume", runId, ruling: effectiveRuling, unblocked: posted.unblocked === true },
        `Resumed KXM run ${runId} with ruling: ${effectiveRuling}\n`,
      );
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "resume_failed";
      print(runtime.io, runtime.json, { ok: false, command: "role resume", error: "resume_failed", detail: msg }, `resume KXM run failed: ${msg}\n`);
      return 1;
    }
  }

  // Workflow run: check local state database (.kxm/state/kxm.db)
  const dbPath = join(runtime.cwd, ".kxm", "state", "kxm.db");
  if (existsSync(dbPath)) {
    try {
      const database = runtime.dryRun ? openReadOnlyDatabase(dbPath) : new DatabaseSync(dbPath);
      try {
        const row = database.prepare("SELECT record FROM workflow_runs WHERE id = ?").get(runId) as { record: string } | undefined;
        if (!row) {
          runtime.io.stderr(`kxm: workflow run '${runId}' not found in ${dbPath}\n`);
          return 1;
        }
        const run = JSON.parse(row.record) as WorkflowRun;
        const now = new Date().toISOString();
        const resumeResult = resumeWorkflowFromRuling(run, effectiveRuling, now);
        if (runtime.dryRun) {
          printPlan(
            runtime,
            { command: "role resume", runId, stageId: resumeResult.stageId, ruling: effectiveRuling, status: resumeResult.run.status },
            [{ action: "write", target: `${dbPath} (workflow_runs ${runId}, one workflow_journal decision)` }],
            `resume workflow run ${runId} (stage: ${resumeResult.stageId})`,
          );
          return 0;
        }

        database.prepare("UPDATE workflow_runs SET record = ? WHERE id = ?").run(
          JSON.stringify(resumeResult.run),
          runId,
        );

        const journalId = randomUUID();
        const journalPayload = {
          id: journalId,
          runId,
          stageId: resumeResult.stageId,
          category: "decision" as const,
          area: "workflow" as const,
          summary: `Role resume ruling: ${effectiveRuling}`,
          details: { ruling: effectiveRuling },
          evidence: {},
          createdAt: now,
        };

        database.prepare(
          "INSERT INTO workflow_journal (id, run_id, category, area, record) VALUES (?, ?, ?, ?, ?)",
        ).run(
          journalId,
          runId,
          "decision",
          "workflow",
          JSON.stringify(journalPayload),
        );

        print(
          runtime.io,
          runtime.json,
          { ok: true, command: "role resume", runId, stageId: resumeResult.stageId, ruling: effectiveRuling, status: resumeResult.run.status },
          `Resumed workflow run ${runId} (stage: ${resumeResult.stageId}) with ruling: ${effectiveRuling}\n`,
        );
        return 0;
      } finally {
        database.close();
      }
    } catch (err: unknown) {
      runtime.io.stderr(`role resume failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  runtime.io.stderr(`kxm: no active run store or database found for run '${runId}'\n`);
  return 1;
}
