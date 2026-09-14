import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DatabaseSync } from "../sqlite.ts";
import {
  DEFAULT_ROLES,
  DEFAULT_ROLE_SEATS,
  listRoles,
  getRole,
  addRole,
  removeRole,
  modifyRole,
  loadRoleHostsConfig,
  setRoleSeatHost,
  resolveRoleSeat,
  type KxmRoleDefinition,
} from "../role.ts";
import { discoverVnextProjectRoot } from "../vnext-config.ts";
import { ensureVnextSupervisor, vnextRuntimeRequest } from "../vnext-runtime-supervisor.ts";
import { resumeWorkflowFromRuling, type WorkflowRun } from "../workflow.ts";
import { print, type CliIo, type Runtime } from "./types.ts";

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
    const modelTag = r.primaryModel ? `(${r.primaryHarness ?? "harness"}:${r.primaryModel})` : "";
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
  if (!roleId || options.pick) {
    const candidates: PickCandidate[] = Object.values(DEFAULT_ROLES).map((r) => ({
      id: r.id,
      description: r.description,
      label: "template",
      payload: r,
    }));
    if (scope === "local") {
      const globalRoles = listRoles({ scope: "global", userConfigDir: runtime.env.KXM_USER_CONFIG_DIR });
      for (const gr of globalRoles) {
        if (!candidates.some((c) => c.id === gr.id)) {
          candidates.push({ id: gr.id, description: gr.description, label: "global", payload: gr });
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
      if (!options.file && picked.payload && DEFAULT_ROLES[picked.id]) {
        const base = DEFAULT_ROLES[picked.id]!;
        const roleDef: KxmRoleDefinition = {
          ...base,
          description: options.description || base.description,
          skills: options.skills ? options.skills.split(",").map((s) => s.trim()).filter(Boolean) : base.skills,
          roster: options.model ? [{ harness: options.harness ?? "pi", model: options.model }] : base.roster,
        };
        try {
          const res = addRole(roleDef, {
            scope,
            repoRoot: runtime.cwd,
            userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
            overwrite: options.overwrite,
          });
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
    }
  }

  let roleDef: KxmRoleDefinition;
  if (options.file) {
    const filePath = resolve(runtime.cwd, options.file);
    const content = readFileSync(filePath, "utf8");
    roleDef = parseYaml(content) as KxmRoleDefinition;
    roleDef.id = roleId!;
  } else {
    const skills = options.skills ? options.skills.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const roster = options.model ? [{ harness: options.harness ?? "pi", model: options.model }] : [];
    roleDef = {
      schema: "kxm.role.v1",
      id: roleId!,
      description: options.description || `Role ${roleId}`,
      skills,
      roster,
    };
  }

  try {
    const res = addRole(roleDef, {
      scope,
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
      overwrite: options.overwrite,
    });
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
    });
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
    addModel?: string | undefined;
    removeModel?: string | undefined;
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
  if (options.addModel) {
    const [harnessOrModel, maybeModel] = options.addModel.split(":");
    const harness = maybeModel ? harnessOrModel! : "pi";
    const model = maybeModel || harnessOrModel!;
    roster.push({ harness, model });
  }
  if (options.removeModel) {
    roster = roster.filter((entry) => entry.model !== options.removeModel);
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
    });
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

export async function cmdRoleHosts(
  runtime: Runtime,
  options: { scope?: "all" | "global" | "local" | undefined } = {},
): Promise<number> {
  const hostsConfig = loadRoleHostsConfig({
    scope: options.scope,
    repoRoot: runtime.cwd,
    userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
  });

  const seatIds = Array.from(
    new Set([
      ...Object.keys(DEFAULT_ROLE_SEATS),
      ...Object.keys(hostsConfig.config.seats ?? {}),
    ]),
  ).sort();

  const seats = seatIds.map((seatId) => {
    const resolved = resolveRoleSeat(seatId, {
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
    });
    return {
      seatId,
      host: resolved.host,
      model: resolved.model,
      provider: resolved.provider,
      effort: resolved.effort,
      source: resolved.source,
      configuredHost: hostsConfig.config.seats?.[seatId]?.host,
      configuredModel: hostsConfig.config.seats?.[seatId]?.model,
    };
  });

  if (runtime.json) {
    print(
      runtime.io,
      true,
      {
        ok: true,
        command: "role hosts",
        scope: hostsConfig.scope,
        filePath: hostsConfig.filePath,
        seats,
        hostProviders: hostsConfig.config.hostProviders ?? {},
      },
      "",
    );
    return 0;
  }

  const lines: string[] = [
    `ROLE SEATS (${hostsConfig.scope}${hostsConfig.filePath ? ` at ${hostsConfig.filePath}` : ""}):`,
  ];
  for (const s of seats) {
    const modelStr = s.model ? ` [${s.model}]` : "";
    const sourceTag = `(via ${s.source})`;
    lines.push(`  ${s.seatId.padEnd(16)} -> host: ${s.host.padEnd(12)} ${modelStr.padEnd(30)} ${sourceTag}`);
  }
  if (hostsConfig.config.hostProviders && Object.keys(hostsConfig.config.hostProviders).length > 0) {
    lines.push("\nHOST PROVIDERS:");
    for (const [h, p] of Object.entries(hostsConfig.config.hostProviders)) {
      lines.push(`  ${h.padEnd(16)} -> provider: ${p}`);
    }
  }
  print(runtime.io, false, {}, `${lines.join("\n")}\n`);
  return 0;
}

export async function cmdRoleSetHost(
  runtime: Runtime,
  seatId: string,
  host: string,
  options: {
    model?: string | undefined;
    effort?: "low" | "medium" | "high" | "xhigh" | undefined;
    scope?: "global" | "local" | undefined;
  } = {},
): Promise<number> {
  if (!seatId || !host) {
    runtime.io.stderr("kxm role set-host requires <seatId> and <host>\n");
    return 1;
  }

  try {
    const result = setRoleSeatHost(seatId, host, {
      model: options.model,
      effort: options.effort,
      scope: options.scope ?? "local",
      repoRoot: runtime.cwd,
      userConfigDir: runtime.env.KXM_USER_CONFIG_DIR,
    });

    print(
      runtime.io,
      runtime.json,
      {
        ok: true,
        command: "role set-host",
        seatId,
        host,
        binding: result.binding,
        filePath: result.filePath,
        scope: result.scope,
      },
      `Bound seat '${seatId}' to host '${host}' in ${result.filePath}\n`,
    );
    return 0;
  } catch (err: unknown) {
    runtime.io.stderr(`role set-host failed: ${(err as Error).message}\n`);
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

  // Check if it's a vNext run
  const projectRoot = discoverVnextProjectRoot(runtime.cwd);
  if (projectRoot && /^run_[a-f0-9]{32}$/i.test(runId)) {
    if (runtime.dryRun) {
      print(runtime.io, runtime.json, { ok: true, command: "role resume", runId, ruling: effectiveRuling }, `would resume vNext run ${runId}`);
      return 0;
    }
    try {
      const supervisor = await ensureVnextSupervisor({ env: runtime.env });
      const posted = await vnextRuntimeRequest(
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
        `Resumed vNext run ${runId} with ruling: ${effectiveRuling}\n`,
      );
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "resume_failed";
      print(runtime.io, runtime.json, { ok: false, command: "role resume", error: "resume_failed", detail: msg }, `resume vNext run failed: ${msg}\n`);
      return 1;
    }
  }

  // Workflow run: check local state database (.kxm/state/kxm.db)
  const dbPath = join(runtime.cwd, ".kxm", "state", "kxm.db");
  if (existsSync(dbPath)) {
    try {
      const database = new DatabaseSync(dbPath);
      try {
        const row = database.prepare("SELECT record FROM workflow_runs WHERE id = ?").get(runId) as { record: string } | undefined;
        if (!row) {
          runtime.io.stderr(`kxm: workflow run '${runId}' not found in ${dbPath}\n`);
          return 1;
        }
        const run = JSON.parse(row.record) as WorkflowRun;
        const now = new Date().toISOString();
        const resumeResult = resumeWorkflowFromRuling(run, effectiveRuling, now);

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
