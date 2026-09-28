/**
 * Opt-in mid-attempt route walk (role authority P4).
 *
 * A role walks only when `policy.fallback.onError` lists the failure class.
 * An empty or absent list keeps today's single-route failure. Cancellation,
 * policy refusal, authentication, an unhosted model, gate failure, tool
 * policy, and admission errors never walk.
 *
 * The chain is the role roster (own entries, then `extends`), with each
 * route's `fallbacks` selectors expanded one level. Selectors use the
 * profile / tag / provider+model shapes from the model schema.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { oneShotWriterArgs, validateHarnessModelPair } from "./harness.ts";
import { listRoleBindings, loadRoutePolicy } from "./routes.ts";
import { EFFORTS, WALKABLE_CLASSES, type WalkableClass } from "./route-switch.ts";
import { findYamlBasename } from "./workforce-names.mjs";

export { WALKABLE_CLASSES, type WalkableClass } from "./route-switch.ts";

export type FailureClass =
  | WalkableClass
  | "cancelled"
  | "policy_refusal"
  | "auth"
  | "unhosted_model"
  | "gate"
  | "tool_policy"
  | "admission"
  | "unknown";

export interface ClassifiedFailure {
  class: FailureClass;
  walkable: boolean;
}

export interface FallbackSelector {
  profile?: string;
  tag?: string;
  capabilities?: readonly string[];
  provider?: string;
  model?: string;
}

export interface FallbackCandidate {
  routeId: string;
  harness: string;
  provider: string;
  model: string;
  selector: string;
  vendor: string;
  permissions: readonly string[];
  priority: number;
  effort?: string;
}

export interface FallbackPolicy {
  onError: readonly WalkableClass[];
  /** Switches allowed after the starting route. Defaults to 1 when the role opts in and omits the field. */
  maxSwitches: number;
  revert: "next_run" | "never";
}

export interface ChainRosterEntry {
  route: string;
  effort?: string;
}

export interface ChainModel {
  routeId: string;
  harness: string;
  model: string;
  vendor: string;
  status: string;
  permissions: readonly string[];
  tags: readonly string[];
  capabilities: readonly string[];
  priority: number;
  fallbacks: readonly FallbackSelector[];
  hosted: boolean;
  writerReady: boolean;
  onWriterRoster: boolean;
}

export interface RouteSessionMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface RouteSessionCarry {
  transcript: RouteSessionMessage[];
}

const CARRY_ROLES = new Set(["user", "assistant", "tool"]);
const MAX_CARRY_MESSAGES = 8;
const MAX_CARRY_TEXT = 2000;
const MAX_CARRY_TOTAL = 8000;
const DEFAULT_MAX_SWITCHES = 1;

export function classifyRouteFailure(input: {
  code?: string | undefined;
  text?: string | undefined;
  httpStatus?: number | undefined;
  name?: string | undefined;
}): ClassifiedFailure {
  const code = (input.code ?? "").toLowerCase();
  const text = `${code} ${input.text ?? ""}`.toLowerCase();
  const name = (input.name ?? "").toLowerCase();
  const status = input.httpStatus;

  const result = (failureClass: FailureClass): ClassifiedFailure => ({
    class: failureClass,
    walkable: (WALKABLE_CLASSES as readonly string[]).includes(failureClass),
  });

  if (name === "aborterror" || /\b(?:user_cancelled|cancelled|cancellation)\b/.test(text) || code === "process_aborted" || text.includes("abort")) {
    return result("cancelled");
  }
  if (/policy_refusal|content_policy|tool_policy|usage policy|safety/.test(text) || text.includes("policy refusal")) {
    return result("policy_refusal");
  }
  if (code.includes("not_authenticated") || /unauthori[sz]ed|authentication|invalid api key|auth_failed|\bauth\b/.test(text) || status === 401 || status === 403) {
    return result("auth");
  }
  if (/permission_profile_unaudited|writer_profile_unaudited|tool_policy/.test(text)) {
    return result("tool_policy");
  }
  if (/harness_unhosted_model|unhosted|does not host/.test(text)) {
    return result("unhosted_model");
  }
  if (code.startsWith("gate_") || text.includes("gate_unsupported") || text.includes("gate_failed")) {
    return result("gate");
  }
  if (code === "producer_route_not_admitted" || text.includes("not_admitted") || text.includes("not admitted")) {
    return result("admission");
  }
  if (status === 413 || /context_overflow|context length|context window|maximum context|token limit|prompt too long|context overflow/.test(text)) {
    return result("context_overflow");
  }
  if (status === 429 || /rate_limit|rate limit|ratelimit|too many requests/.test(text)) {
    return result("rate_limit");
  }
  if (
    status === 408 || status === 502 || status === 504
    || code === "process_timeout"
    || /etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|\btimeout\b|timed out|\btransport\b/.test(text)
  ) {
    return result("transport");
  }
  if (
    status === 500 || status === 503
    || /provider_unavailable|model unavailable|service unavailable|overloaded|model_not_found|no available model/.test(text)
  ) {
    return result("provider_unavailable");
  }
  return result("unknown");
}

export function parseFallbackPolicy(value: unknown): FallbackPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const onErrorRaw = record.onError;
  if (!Array.isArray(onErrorRaw) || onErrorRaw.length === 0) return undefined;
  if (new Set(onErrorRaw).size !== onErrorRaw.length) return undefined;
  const onError: WalkableClass[] = [];
  for (const item of onErrorRaw) {
    if (typeof item !== "string" || !(WALKABLE_CLASSES as readonly string[]).includes(item)) return undefined;
    onError.push(item as WalkableClass);
  }
  let maxSwitches = DEFAULT_MAX_SWITCHES;
  if (record.maxSwitches !== undefined) {
    if (!Number.isInteger(record.maxSwitches) || (record.maxSwitches as number) < 0) return undefined;
    maxSwitches = record.maxSwitches as number;
  }
  let revert: FallbackPolicy["revert"] = "next_run";
  if (record.revert !== undefined) {
    if (record.revert !== "next_run" && record.revert !== "never") return undefined;
    revert = record.revert;
  }
  return { onError, maxSwitches, revert };
}

function admittedSelector(model: ChainModel, admitted: ReadonlySet<string>, disabled: ReadonlySet<string>): string | undefined {
  const candidates = [model.model, `${model.vendor}/${model.model}`, `${model.harness}/${model.model}`];
  const selector = candidates.find((candidate) => admitted.has(candidate));
  if (!selector || disabled.has(selector)) return undefined;
  return selector;
}

function splitSelector(selector: string): { provider: string; model: string } | undefined {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return undefined;
  return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
}

function eligible(
  model: ChainModel,
  admitted: ReadonlySet<string>,
  disabled: ReadonlySet<string>,
  liveWrite: boolean,
): FallbackCandidate | undefined {
  if (model.status !== "admitted" || !model.hosted) return undefined;
  if (liveWrite && (!model.permissions.includes("edit") || !model.writerReady || !model.onWriterRoster)) return undefined;
  const selector = admittedSelector(model, admitted, disabled);
  if (!selector) return undefined;
  const parts = splitSelector(selector);
  if (!parts) return undefined;
  return {
    routeId: model.routeId,
    harness: model.harness,
    provider: parts.provider,
    model: parts.model,
    selector,
    vendor: model.vendor,
    permissions: model.permissions,
    priority: model.priority,
  };
}

function selectorsFor(fallback: FallbackSelector, models: readonly ChainModel[]): ChainModel[] {
  if (fallback.profile) {
    const model = models.find((item) => item.routeId === fallback.profile);
    return model ? [model] : [];
  }
  if (fallback.tag) {
    const required = new Set(fallback.capabilities ?? []);
    return models
      .filter((item) => item.tags.includes(fallback.tag!) && [...required].every((capability) => item.capabilities.includes(capability)))
      .slice()
      .sort((left, right) => right.priority - left.priority || left.routeId.localeCompare(right.routeId));
  }
  if (fallback.provider && fallback.model) {
    return models.filter((item) => item.vendor === fallback.provider && item.model === fallback.model);
  }
  return [];
}

export function buildFallbackChain(input: {
  roster: readonly ChainRosterEntry[];
  extendsRoster?: readonly ChainRosterEntry[] | undefined;
  models: readonly ChainModel[];
  admitted: readonly string[];
  disabled: readonly string[];
  liveWrite: boolean;
  criticVendors?: readonly string[] | undefined;
  vendorIndependenceRequired?: boolean | undefined;
}): FallbackCandidate[] {
  const admitted = new Set(input.admitted);
  const disabled = new Set(input.disabled);
  const critics = new Set(input.criticVendors ?? []);
  const byId = new Map(input.models.map((model) => [model.routeId, model]));
  const chain: FallbackCandidate[] = [];
  const seen = new Set<string>();
  const entries = [...input.roster, ...(input.extendsRoster ?? [])];

  const push = (model: ChainModel | undefined, effort: string | undefined): void => {
    if (!model || seen.has(model.routeId)) return;
    const candidate = eligible(model, admitted, disabled, input.liveWrite);
    if (!candidate) return;
    if (input.vendorIndependenceRequired && chain.length > 0 && critics.has(candidate.vendor)) return;
    seen.add(model.routeId);
    const resolvedEffort = effort && EFFORTS.has(effort) ? effort : undefined;
    chain.push(resolvedEffort ? { ...candidate, effort: resolvedEffort } : candidate);
  };

  for (const entry of entries) {
    const model = byId.get(entry.route);
    push(model, entry.effort);
    if (!model) continue;
    for (const fallback of model.fallbacks) {
      for (const resolved of selectorsFor(fallback, input.models)) push(resolved, entry.effort);
    }
  }
  return chain;
}

export function decideRouteSwitch(input: {
  policy: FallbackPolicy | undefined;
  chain: readonly FallbackCandidate[];
  currentRouteId: string;
  switchesUsed: number;
  failure: ClassifiedFailure;
  currentEffort?: string | undefined;
}): { action: "continue"; cause: "disabled" | "not_walkable" | "class_not_opted_in" | "budget" | "no_candidate" }
  | { action: "switch"; to: FallbackCandidate; reason: WalkableClass; effort?: string } {
  if (!input.policy || input.policy.onError.length === 0) return { action: "continue", cause: "disabled" };
  if (!input.failure.walkable) return { action: "continue", cause: "not_walkable" };
  if (!(input.policy.onError as readonly string[]).includes(input.failure.class)) {
    return { action: "continue", cause: "class_not_opted_in" };
  }
  if (input.switchesUsed >= input.policy.maxSwitches) return { action: "continue", cause: "budget" };
  const index = input.chain.findIndex((candidate) => candidate.routeId === input.currentRouteId);
  const next = index >= 0 ? input.chain[index + 1] : undefined;
  if (!next) return { action: "continue", cause: "no_candidate" };
  const effort = next.effort ?? (input.currentEffort && EFFORTS.has(input.currentEffort) ? input.currentEffort : undefined);
  return {
    action: "switch",
    to: next,
    reason: input.failure.class as WalkableClass,
    ...(effort ? { effort } : {}),
  };
}

export function parseSessionCarry(value: unknown): RouteSessionCarry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const transcript = (value as { transcript?: unknown }).transcript;
  if (!Array.isArray(transcript) || transcript.length === 0) return undefined;
  const messages: RouteSessionMessage[] = [];
  let total = 0;
  for (const item of transcript) {
    if (messages.length >= MAX_CARRY_MESSAGES) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    if (typeof role !== "string" || !CARRY_ROLES.has(role) || typeof text !== "string" || text.length === 0) continue;
    const clipped = text.slice(0, MAX_CARRY_TEXT);
    if (total + clipped.length > MAX_CARRY_TOTAL) break;
    total += clipped.length;
    messages.push({ role: role as RouteSessionMessage["role"], text: clipped });
  }
  return messages.length > 0 ? { transcript: messages } : undefined;
}

export function mergeSessionCarry(left?: RouteSessionCarry | undefined, right?: RouteSessionCarry | undefined): RouteSessionCarry | undefined {
  return parseSessionCarry({ transcript: [...(left?.transcript ?? []), ...(right?.transcript ?? [])] });
}

export function carryForwardPrompt(prompt: string | undefined, carry: RouteSessionCarry | undefined): string | undefined {
  if (!carry || carry.transcript.length === 0) return prompt;
  const lines = carry.transcript.map((message) => `${message.role}: ${message.text}`);
  const block = `Prior attempt transcript:\n${lines.join("\n")}`;
  if (!prompt || prompt.length === 0) return block;
  return `${prompt}\n\n${block}`;
}

function readYaml(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readSelectors(projectRoot: string, value: unknown): FallbackSelector[] {
  if (!Array.isArray(value)) return [];
  const modelsDir = join(projectRoot, ".kxm", "models");
  const selectors: FallbackSelector[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.profile === "string") {
      selectors.push({ profile: findYamlBasename(modelsDir, record.profile, "route") ?? record.profile });
    } else if (typeof record.tag === "string") {
      selectors.push({
        tag: record.tag,
        ...(Array.isArray(record.capabilities) ? { capabilities: stringList(record.capabilities) } : {}),
      });
    } else if (typeof record.provider === "string" && typeof record.model === "string") {
      selectors.push({ provider: record.provider, model: record.model });
    }
  }
  return selectors;
}

function loadChainModel(projectRoot: string, routeId: string, writerIds: ReadonlySet<string>): ChainModel | undefined {
  const modelsDir = join(projectRoot, ".kxm", "models");
  const fileId = findYamlBasename(modelsDir, routeId, "route") ?? routeId;
  const doc = readYaml(join(modelsDir, `${fileId}.yaml`));
  if (!doc || doc.schema !== "kxm.model.v2") return undefined;
  const harness = typeof doc.harness === "string" ? doc.harness : "";
  const model = typeof doc.model === "string" ? doc.model : "";
  const vendor = typeof doc.vendor === "string" ? doc.vendor : "";
  if (!harness || !model || !vendor) return undefined;
  const permissions = stringList(doc.permissions);
  const selector = [model, `${vendor}/${model}`, `${harness}/${model}`].find((candidate) => candidate.includes("/")) ?? `${vendor}/${model}`;
  const parts = splitSelector(selector);
  const hosted = parts ? validateHarnessModelPair(harness, { provider: parts.provider, model: parts.model }).valid : false;
  return {
    routeId: fileId,
    harness,
    model,
    vendor,
    status: typeof doc.status === "string" ? doc.status : "",
    permissions,
    tags: stringList(doc.tags),
    capabilities: stringList(doc.capabilities),
    priority: typeof doc.priority === "number" ? doc.priority : 0,
    fallbacks: readSelectors(projectRoot, doc.fallbacks),
    hosted,
    writerReady: oneShotWriterArgs(harness) !== undefined,
    onWriterRoster: writerIds.has(fileId) || writerIds.has(routeId),
  };
}

function canonicalRoster(projectRoot: string, entries: readonly ChainRosterEntry[]): ChainRosterEntry[] {
  const modelsDir = join(projectRoot, ".kxm", "models");
  return entries.map((entry) => {
    const route = findYamlBasename(modelsDir, entry.route, "route") ?? entry.route;
    return entry.effort ? { route, effort: entry.effort } : { route };
  });
}

function rosterEntries(doc: Record<string, unknown> | undefined): ChainRosterEntry[] {
  if (!Array.isArray(doc?.roster)) return [];
  const entries: ChainRosterEntry[] = [];
  for (const item of doc.roster) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const route = (item as { route?: unknown }).route;
    const effort = (item as { effort?: unknown }).effort;
    if (typeof route !== "string" || route.length === 0) continue;
    entries.push(typeof effort === "string" ? { route, effort } : { route });
  }
  return entries;
}

function loadModelsFor(projectRoot: string, roster: readonly ChainRosterEntry[], writerIds: ReadonlySet<string>): ChainModel[] {
  const modelsDir = join(projectRoot, ".kxm", "models");
  const wanted = new Set<string>();
  for (const entry of roster) wanted.add(entry.route);
  if (existsSync(modelsDir)) {
    for (const name of readdirSync(modelsDir)) {
      if (!name.endsWith(".yaml") || name === "inventory.yaml") continue;
      wanted.add(name.slice(0, -5));
    }
  }
  const models: ChainModel[] = [];
  const seen = new Set<string>();
  for (const routeId of wanted) {
    const model = loadChainModel(projectRoot, routeId, writerIds);
    if (!model || seen.has(model.routeId)) continue;
    seen.add(model.routeId);
    models.push(model);
  }
  return models;
}

function criticVendors(projectRoot: string, writerIds: ReadonlySet<string>): string[] {
  const dir = join(projectRoot, ".kxm", "roles");
  if (!existsSync(dir)) return [];
  const vendors: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yaml")) continue;
    const doc = readYaml(join(dir, name));
    const purpose = doc?.purpose;
    if (purpose !== "reviewer-arch" && purpose !== "reviewer-cli") continue;
    const first = rosterEntries(doc)[0];
    if (!first) continue;
    const model = loadChainModel(projectRoot, first.route, writerIds);
    if (model?.status === "admitted") vendors.push(model.vendor);
  }
  return vendors;
}

export function loadAgentFallback(
  projectRoot: string,
  agentId: string,
  options: { liveWrite: boolean },
): { policy: FallbackPolicy; chain: FallbackCandidate[]; roleId: string } | undefined {
  const agentsDir = join(projectRoot, ".kxm", "agents");
  const agentFile = findYamlBasename(agentsDir, agentId, "agent") ?? agentId;
  const agent = readYaml(join(agentsDir, `${agentFile}.yaml`));
  const roleId = typeof agent?.role === "string" ? agent.role : "";
  if (!roleId) return undefined;
  const role = readYaml(join(projectRoot, ".kxm", "roles", `${roleId}.yaml`));
  if (!role) return undefined;
  const policyRecord = role.policy && typeof role.policy === "object" ? (role.policy as Record<string, unknown>).fallback : undefined;
  const policy = parseFallbackPolicy(policyRecord);
  if (!policy) return undefined;
  const own = canonicalRoster(projectRoot, rosterEntries(role));
  const seenRoles = new Set<string>([roleId]);
  let extendsRoster: ChainRosterEntry[] = [];
  let cursor = typeof role.extends === "string" ? role.extends : "";
  while (cursor && !seenRoles.has(cursor)) {
    seenRoles.add(cursor);
    const parent = readYaml(join(projectRoot, ".kxm", "roles", `${cursor}.yaml`));
    extendsRoster = extendsRoster.concat(canonicalRoster(projectRoot, rosterEntries(parent)));
    cursor = typeof parent?.extends === "string" ? parent.extends : "";
  }
  const writerIds = new Set(listRoleBindings(projectRoot).writer ?? []);
  const models = loadModelsFor(projectRoot, [...own, ...extendsRoster], writerIds);
  const routePolicy = loadRoutePolicy(projectRoot);
  const independence = Boolean(role.policy && typeof role.policy === "object" && (role.policy as { vendorIndependenceRequired?: unknown }).vendorIndependenceRequired);
  const chain = buildFallbackChain({
    roster: own,
    extendsRoster,
    models,
    admitted: routePolicy.admitted,
    disabled: routePolicy.disabled,
    liveWrite: options.liveWrite,
    criticVendors: independence ? criticVendors(projectRoot, writerIds) : [],
    vendorIndependenceRequired: independence,
  });
  return { policy, chain, roleId };
}
