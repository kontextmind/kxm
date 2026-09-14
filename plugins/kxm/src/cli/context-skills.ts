import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { redactSecrets } from "../redact.ts";
import {
  createMemoryNote,
  formatMemoryBriefText,
  generateMemoryBrief,
  syncHarnessMemory,
  type MemoryScope,
} from "../memory.ts";
import { SkillLifecycle, type SkillEvaluationKind, type SkillState } from "../skills.ts";
import { writeCompiledWiki } from "../wiki.ts";
import { print, type Runtime } from "./types.ts";

/** Authenticated hub POST for context operations. The CLI operates as the
 * control plane: the administrative token scopes one project per request. */
export async function hubContextPost(input: {
  serverUrl: string;
  path: string;
  body: Record<string, unknown>;
  authToken?: string | undefined;
  fetchImpl: typeof fetch;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await input.fetchImpl(`${input.serverUrl.replace(/\/$/, "")}${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
    },
    body: JSON.stringify(input.body),
  });
  const text = redactSecrets((await response.text()).slice(0, 64_000));
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep text for diagnostics without treating it as a secret.
  }
  return { ok: response.ok, status: response.status, body };
}

export function parseContextKinds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((kind) => kind.trim()).filter((kind) => kind.length > 0);
}

export async function cmdContextGet(runtime: Runtime, project: string, options: { role: string; task: string; run?: string | undefined; stage?: string | undefined; budget?: string | undefined; kinds?: string | undefined }): Promise<number> {
  const budget = options.budget === undefined ? undefined : Number(options.budget);
  if (options.budget !== undefined && (!Number.isInteger(budget) || (budget as number) < 512 || (budget as number) > 200_000)) {
    runtime.io.stderr("context get --budget must be an integer between 512 and 200000\n");
    return 2;
  }
  const body: Record<string, unknown> = {
    project,
    role: options.role,
    task: options.task,
  };
  if (options.run) body.workflowRunId = options.run;
  if (options.stage) body.stageId = options.stage;
  if (budget !== undefined) body.budgetTokens = budget;
  const kinds = parseContextKinds(options.kinds);
  if (kinds) body.includeKinds = kinds;
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/get",
    body,
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context get", status: response.status, ...(response.body as object) }, `context get ${response.ok ? "assembled" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

export async function cmdContextRecall(runtime: Runtime, project: string, options: { query?: string | undefined; kinds?: string | undefined; limit?: string | undefined }): Promise<number> {
  const body: Record<string, unknown> = { project };
  if (options.query) body.query = options.query;
  const kinds = parseContextKinds(options.kinds);
  if (kinds) body.kinds = kinds;
  if (options.limit) body.limit = Number(options.limit);
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/recall",
    body,
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context recall", status: response.status, ...(response.body as object) }, `context recall ${response.ok ? "complete" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

export async function cmdContextState(runtime: Runtime, project: string, key: string, options: { asOf?: string | undefined }): Promise<number> {
  const body: Record<string, unknown> = { project, key };
  if (options.asOf) body.asOf = options.asOf;
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/state",
    body,
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context state", status: response.status, ...(response.body as object) }, `context state ${response.ok ? "resolved" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

export async function cmdContextEpisode(runtime: Runtime, project: string, options: { run?: string | undefined }): Promise<number> {
  const body: Record<string, unknown> = { project };
  if (options.run) body.workflowRunId = options.run;
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/episode",
    body,
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context episode", status: response.status, ...(response.body as object) }, `context episode ${response.ok ? "complete" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

export async function cmdContextPromote(runtime: Runtime, project: string, proposalId: string, options: { evidence: string }): Promise<number> {
  const evidence = options.evidence.split(",").map((ref) => ref.trim()).filter((ref) => ref.length > 0);
  if (evidence.length === 0) {
    runtime.io.stderr("context promote --evidence must contain at least one durable evidence reference\n");
    return 2;
  }
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/state/promote",
    body: { project, proposalId, evidence },
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context promote", status: response.status, ...(response.body as object) }, `context promote ${response.ok ? "recorded" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

export async function cmdContextExplain(runtime: Runtime, project: string, itemId: string): Promise<number> {
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/explain",
    body: { project, id: itemId },
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  print(runtime.io, runtime.json, { ok: response.ok, command: "context explain", status: response.status, ...(response.body as object) }, `context explain ${response.ok ? "complete" : `failed (${response.status})`}`);
  return response.ok ? 0 : 1;
}

export async function cmdContextWikiCompile(runtime: Runtime, project: string, options: { out?: string | undefined }): Promise<number> {
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/wiki/compile",
    body: { project },
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  if (!response.ok) {
    print(runtime.io, runtime.json, { ok: false, command: "context wiki-compile", status: response.status, body: response.body }, `wiki compile failed (${response.status})`);
    return 1;
  }
  const compiled = response.body as { audit: { pages: string[]; contradictions: number }; pages: { path: string; content: string }[] };
  let written: string[] = [];
  if (options.out) {
    const pages = new Map(compiled.pages.map((page) => [page.path, page.content]));
    written = writeCompiledWiki(options.out, { pages, index: pages.get(".kxm/knowledge/wiki/index.md") ?? "", audit: { project, pages: compiled.audit.pages, stateItems: 0, contextItems: 0, contradictions: compiled.audit.contradictions, compiledAt: "" } });
  }
  print(runtime.io, runtime.json, { ok: true, command: "context wiki-compile", project, pages: compiled.audit.pages, openContradictions: compiled.audit.contradictions, ...(written.length > 0 ? { written: written.length, outDir: options.out } : { dryRun: true }) }, `compiled ${compiled.audit.pages.length} wiki page(s)${written.length > 0 ? ` to ${options.out}` : " (dry-run)"}`);
  return 0;
}

export async function cmdContextWikiLint(runtime: Runtime, project: string): Promise<number> {
  const response = await hubContextPost({
    serverUrl: runtime.serverUrl,
    path: "/v1/context/wiki/compile",
    body: { project },
    ...(runtime.env.KXM_AUTH_TOKEN?.trim() ? { authToken: runtime.env.KXM_AUTH_TOKEN.trim() } : {}),
    fetchImpl: runtime.fetchImpl,
  });
  if (!response.ok) {
    print(runtime.io, runtime.json, { ok: false, command: "context wiki-lint", status: response.status, body: response.body }, `wiki lint failed (${response.status})`);
    return 1;
  }
  const compiled = response.body as {
    audit: { stateItems: number; contextItems: number; contradictions: number; compiledAt: string };
    lint: { severity: string; rule: string; path: string; message: string }[];
  };
  const issues = compiled.lint;
  print(runtime.io, runtime.json, { ok: issues.length === 0, command: "context wiki-lint", project, issues, audit: compiled.audit }, issues.length === 0 ? "wiki lint clean" : `wiki lint found ${issues.length} issue(s)`);
  return issues.every((issue) => issue.severity !== "error") ? 0 : 1;
}

export function skillStateFromFlag(value: string): SkillState {
  if (value === "candidate" || value === "promoted" || value === "quarantined" || value === "rejected") return value;
  throw new Error(`invalid skill state ${value}`);
}

export function skillsRoot(runtime: Runtime): string {
  return join(runtime.dirs.workdir, ".kxm", "skills");
}

export function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

export async function cmdSkillsCreate(runtime: Runtime, options: { file: string; name: string; description?: string | undefined; createdBy: string; run?: string | undefined; journal?: string | undefined; receipt?: string | undefined; harness: string; models: string; supersedes?: string | undefined }): Promise<number> {
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "skills create", dryRun: true, name: options.name }, "would create skill candidate");
    return 0;
  }
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const metadata = lifecycle.create({
      name: options.name,
      description: options.description ?? "",
      content: readFileSync(options.file, "utf8"),
      createdBy: options.createdBy,
      sources: {
        runIds: csv(options.run) ?? [],
        journalEntryIds: csv(options.journal) ?? [],
        evidenceReceipts: csv(options.receipt) ?? [],
      },
      compatibility: { harness: options.harness, models: csv(options.models) ?? [] },
      ...(options.supersedes ? { supersedes: options.supersedes } : {}),
    });
    print(runtime.io, runtime.json, { ok: true, command: "skills create", metadata }, `created skill candidate ${metadata.id}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills create failed: ${message}\n`);
    return 1;
  }
}

export async function cmdSkillsEvaluate(runtime: Runtime, skillId: string, options: { kind: string; evaluator: string; fail?: boolean | undefined; score?: string | undefined; details?: string | undefined }): Promise<number> {
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const outcome = lifecycle.evaluate(skillId, {
      kind: options.kind as SkillEvaluationKind,
      evaluatorVersion: options.evaluator,
      passed: options.fail !== true,
      ...(options.score !== undefined ? { score: Number(options.score) } : {}),
      ...(options.details ? { details: options.details } : {}),
    });
    print(runtime.io, runtime.json, { ok: true, command: "skills evaluate", skillId, quarantined: outcome.quarantined, evaluation: outcome.evaluation }, `recorded ${options.kind} evaluation${outcome.quarantined ? " (candidate quarantined)" : ""}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills evaluate failed: ${message}\n`);
    return 1;
  }
}

export async function cmdSkillsPromote(runtime: Runtime, skillId: string, options: { decidedBy: string; evidence: string; reason?: string | undefined }): Promise<number> {
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const promoted = lifecycle.promote(skillId, {
      decidedBy: options.decidedBy,
      reason: options.reason ?? "passed protected evaluation",
      evidenceRefs: csv(options.evidence) ?? [],
    });
    print(runtime.io, runtime.json, { ok: true, command: "skills promote", skillId, metadata: promoted, patchPath: promoted.patchPath }, `promoted skill ${skillId} (patch: ${promoted.patchPath})`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills promote failed: ${message}\n`);
    return 1;
  }
}

export async function cmdSkillsReject(runtime: Runtime, skillId: string, options: { decidedBy: string; reason?: string | undefined }): Promise<number> {
  const lifecycle = new SkillLifecycle(skillsRoot(runtime));
  try {
    const metadata = lifecycle.reject(skillId, { decidedBy: options.decidedBy, reason: options.reason ?? "rejected" });
    print(runtime.io, runtime.json, { ok: true, command: "skills reject", skillId, metadata }, `rejected skill ${skillId} (history retained)`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills reject failed: ${message}\n`);
    return 1;
  }
}

export async function cmdSkillsList(runtime: Runtime, options: { state: string }): Promise<number> {
  try {
    const lifecycle = new SkillLifecycle(skillsRoot(runtime));
    const state = skillStateFromFlag(options.state);
    const items = lifecycle.list(state).map((metadata) => ({
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      createdBy: metadata.createdBy,
      createdAt: metadata.createdAt,
      models: metadata.compatibility.models,
    }));
    print(runtime.io, runtime.json, { ok: true, command: "skills list", state: options.state, skills: items }, `${items.length} ${state} skill(s)`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills list failed: ${message}\n`);
    return 1;
  }
}

export async function cmdSkillsVerify(runtime: Runtime, skillId: string, options: { state: string }): Promise<number> {
  try {
    const lifecycle = new SkillLifecycle(skillsRoot(runtime));
    const state = skillStateFromFlag(options.state);
    const metadata = lifecycle.verify(state, skillId);
    print(runtime.io, runtime.json, { ok: true, command: "skills verify", skillId, state: options.state, contentSha256: metadata.contentSha256 }, `skill ${skillId} integrity verified`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`skills verify failed: ${message}\n`);
    return 1;
  }
}

export async function cmdMemoryBrief(runtime: Runtime): Promise<number> {
  try {
    const brief = generateMemoryBrief(runtime.cwd);
    const text = formatMemoryBriefText(brief);
    print(runtime.io, runtime.json, { ok: true, command: "memory brief", brief }, text);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`memory brief failed: ${message}\n`);
    return 1;
  }
}

export async function cmdMemoryNote(
  runtime: Runtime,
  fact: string,
  options: { scope?: string | undefined; kind?: string | undefined; body?: string | undefined },
): Promise<number> {
  try {
    const { record, path } = createMemoryNote(runtime.cwd, fact, {
      scope: (options.scope ?? "project") as MemoryScope,
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    const relPath = relative(runtime.cwd, path);
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "memory note", candidate: record, path: relPath },
      `Recorded memory candidate ${record.id} in ${relPath} (promoted via PR)`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`memory note failed: ${message}\n`);
    return 1;
  }
}

export async function cmdMemorySync(runtime: Runtime): Promise<number> {
  try {
    const result = syncHarnessMemory(runtime.cwd);
    print(
      runtime.io,
      runtime.json,
      { ok: true, command: "memory sync", ...result },
      `Synced project memory across AGENTS.md, CLAUDE.md, and GEMINI.md`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.io.stderr(`memory sync failed: ${message}\n`);
    return 1;
  }
}
