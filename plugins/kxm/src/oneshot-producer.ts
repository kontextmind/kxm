import { beginOneShotEvidence, oneShotEvidenceRoot } from "./oneshot-evidence.ts";
import { defaultSpawn, type KxmOneShotProcessResult, type KxmOneShotSpawn } from "./oneshot-process.ts";
export { defaultSpawn, type KxmOneShotProcessResult, type KxmOneShotSpawn } from "./oneshot-process.ts";
import {
  BUILTIN_HARNESSES,
  NATIVE_HARNESS_PROVIDERS,
  probeHarnessAssignmentAsync,
  oneShotPermissionArgs,
  type HarnessAssignmentProbeOptions,
  type HarnessStatus,
  type HarnessCatalogEntry,
  type HarnessInventory,
  type OneShotParsedOutput,
} from "./harness.ts";
import {
  calculateModelCost,
  findModelPrice,
  loadPriceCatalog,
  parsePriceCatalog,
  type PriceCatalog,
} from "./prices.ts";
import {
  registerTrustedProducer,
  type KxmProducer,
  type KxmProducerRequest,
  type KxmProducerResult,
} from "./engine.ts";

export interface KxmOneShotProducerOptions {
  projectRoot?: string | undefined;
  evidenceRoot?: string | undefined;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  inventory?: HarnessInventory | undefined;
  catalog?: readonly HarnessCatalogEntry[] | undefined;
  priceCatalog?: PriceCatalog | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  spawnProcess?: KxmOneShotSpawn | undefined;
  probeHarness?: ((options: Omit<HarnessAssignmentProbeOptions, "runCommand"> & { signal?: AbortSignal | undefined }) => HarnessStatus | Promise<HarnessStatus>) | undefined;
  resolveModel?: ((agentId: string, runId: string) => {
    provider?: string | undefined;
    model?: string | undefined;
    thinking?: string | undefined;
  } | undefined) | undefined;
}

export interface KxmOneShotProducer extends KxmProducer {
  readonly id: "oneshot";
  produce(request: KxmProducerRequest): Promise<KxmProducerResult>;
  close(): Promise<void>;
}

// The last complete top-level `{...}`. One forward pass tracks strings,
// escapes, and brace depth. A `{` that lifts depth from 0 to 1 opens a
// candidate; the matching `}` that returns depth from 1 to 0 closes it.
// The last such span wins. Callers accept the span only when it is the
// entire trimmed reply or the entire final line; an inner object is not
// an outcome.
function lastBalancedJsonObject(text: string): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  let lastStart = -1;
  let lastEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) {
        lastStart = start;
        lastEnd = i;
      }
    }
  }
  if (lastStart < 0) return undefined;
  return text.slice(lastStart, lastEnd + 1);
}

// A standalone object is one balanced `{...}` covering the entire trimmed text.
function standaloneObjectText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const slice = lastBalancedJsonObject(trimmed);
  return slice === trimmed ? slice : undefined;
}

function outcomeOfObjectText(text: string): string | undefined {
  const slice = standaloneObjectText(text);
  if (slice === undefined) return undefined;
  try {
    const result: unknown = JSON.parse(slice);
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const outcome = (result as Record<string, unknown>).outcome;
    return typeof outcome === "string" ? outcome : undefined;
  } catch {
    return undefined;
  }
}

function isClosingFence(line: string): boolean {
  return /^(`{3,}|~{3,})\s*$/.test(line.trim());
}

// The whole reply is one JSON object, or the object stands alone on the final
// line. A closing code fence after that line is allowed. Prose after the
// object, an ambiguous tail, a truncated reply, and a missing or disallowed
// outcome settle failed.
function determineOutcome(text: string, allowedOutcomes: readonly string[]): string {
  const trimmed = text.trim();
  if (!trimmed) return "failed";
  const whole = outcomeOfObjectText(trimmed);
  if (whole !== undefined) return allowedOutcomes.includes(whole) ? whole : "failed";
  const lines = trimmed.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length > 0 && isClosingFence(lines[lines.length - 1]!)) {
    lines.pop();
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  }
  if (lines.length === 0) return "failed";
  const declared = outcomeOfObjectText(lines[lines.length - 1]!);
  if (declared === undefined || !allowedOutcomes.includes(declared)) return "failed";
  return declared;
}

export function createKxmOneShotProducer(options: KxmOneShotProducerOptions = {}): KxmOneShotProducer {
  const running = new Map<AbortController, Promise<KxmProducerResult>>();
  let closed = false;

  function requireHarness(request: KxmProducerRequest): string {
    if (request.harness) return request.harness;
    throw new Error("producer_harness_required");
  }

  function parseModelString(spec: string, harness: string): { provider: string; model: string } {
    const trimmed = spec.trim();
    if (trimmed.includes("/")) {
      const idx = trimmed.indexOf("/");
      return { provider: trimmed.slice(0, idx).toLowerCase(), model: trimmed.slice(idx + 1) };
    }
    const fallbackProvider = NATIVE_HARNESS_PROVIDERS[harness] ?? options.defaultProvider ?? "anthropic";
    return { provider: fallbackProvider, model: trimmed };
  }

  function resolveModelForRequest(
    request: KxmProducerRequest,
    harness: string,
  ): { provider: string; model: string; thinking?: string | undefined } {
    if (request.model) {
      // A separate provider field means the model id is bare and may itself be
      // namespaced (openrouter + qwen/qwen3-coder-plus); reparsing it as a
      // provider/model selector strips the namespace — the same defect #262 fixed
      // in the pi producer. Only parse when the provider must come from the string.
      if (request.provider) {
        return { provider: request.provider.toLowerCase(), model: request.model, thinking: request.thinking };
      }
      const parsed = parseModelString(request.model, harness);
      return {
        provider: request.provider?.toLowerCase() ?? parsed.provider,
        model: parsed.model,
        thinking: request.thinking,
      };
    }
    if (options.resolveModel) {
      const resolved = options.resolveModel(request.agentId, request.runId);
      if (resolved && resolved.model) {
        if (resolved.provider) {
          return { provider: resolved.provider.toLowerCase(), model: resolved.model, thinking: resolved.thinking };
        }
        const parsed = parseModelString(resolved.model, harness);
        return {
          provider: resolved.provider?.toLowerCase() ?? parsed.provider,
          model: parsed.model,
          thinking: resolved.thinking,
        };
      }
    }
    if (options.defaultModel) {
      const parsed = parseModelString(options.defaultModel, harness);
      return { provider: parsed.provider, model: parsed.model, thinking: request.thinking };
    }
    throw new Error("producer_route_not_admitted");
  }

  async function checkAuth(harness: string, provider: string, model: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<HarnessStatus> {
    if (options.inventory) {
      const entry = options.inventory.harnesses.find((h) => h.id === harness);
      if (!entry || !entry.detected || entry.authenticated !== true) {
        throw new Error(`${harness}_not_authenticated: ${harness} harness not authenticated in inventory`);
      }
    }

    const probeFn = options.probeHarness ?? probeHarnessAssignmentAsync;
    const probe = await probeFn({ harness, provider, model, env, signal, timeoutMs: 10_000 });

    if (!probe.detected) {
      throw new Error(`${harness}_not_authenticated: ${harness} harness not detected (${probe.issues.join(", ")})`);
    }
    if (probe.authenticated !== true) {
      throw new Error(`${harness}_not_authenticated: ${harness} not authenticated (${probe.issues.join(", ")})`);
    }
    return probe;
  }

  async function executeRequest(request: KxmProducerRequest): Promise<KxmProducerResult> {
      const startTime = Date.now();
      const harness = requireHarness(request);
      const resolved = resolveModelForRequest(request, harness);

      if (closed) throw new Error("oneshot_producer_closed");
      const cancelled = (): KxmProducerResult => ({ outcome: "cancelled", costBasis: "unknown", costUsd: null,
        latencyMs: Math.max(0, Date.now() - startTime), harness, provider: resolved.provider,
        requestedModel: resolved.model, effectiveModel: "unknown", agentRole: request.agentRole ?? request.agentId });
      if (request.signal.aborted) return cancelled();
      const catalogEntry = (options.catalog ?? BUILTIN_HARNESSES).find((h) => h.id === harness);
      if (!catalogEntry?.oneShot) throw new Error(`oneshot_harness_unsupported: ${harness}`);
      const permission = request.permission === "edit" || request.contextPacket?.task.permissionCeiling === "edit"
        ? "edit"
        : "read-only";
      const permissionArgs = oneShotPermissionArgs(harness, permission);
      if (!permissionArgs) {
        throw new Error(`oneshot_harness_unsupported: ${harness} ${permission === "edit" ? "writer_profile_unaudited" : "permission_profile_unaudited"}`);
      }
      // Pin the environment for auth and execution; don't observe subscription
      // auth under one environment and then spawn under changed API-key settings.
      const env = { ...(options.env ?? process.env) };
      let auth: HarnessStatus;
      try { auth = await checkAuth(harness, resolved.provider, resolved.model, env, request.signal); }
      catch (error) { if (request.signal.aborted) return cancelled(); throw error; }
      if (request.signal.aborted) return cancelled();

      const command = auth.command ?? catalogEntry.commands[0] ?? harness;
      const oneShot = catalogEntry.oneShot;

      let args: string[];
      if (harness === "claude") {
        args = [
          "-p",
          "--model",
          resolved.model,
          ...(resolved.thinking ? ["--effort", resolved.thinking] : []),
          ...permissionArgs,
          "--output-format",
          "json",
        ];
      } else if (harness === "codex") {
        args = [
          "exec",
          "-m",
          resolved.model,
          ...(resolved.thinking ? ["-c", `model_reasoning_effort="${resolved.thinking}"`] : []),
          ...permissionArgs,
          "--json",
          "-",
        ];
      } else if (harness === "grok") {
        args = ["--model", resolved.model,
          ...(resolved.thinking ? ["--reasoning-effort", resolved.thinking] : []),
          ...permissionArgs, "--output-format", "json"];
      } else if (harness === "agy") {
        args = [
          "-m",
          resolved.model,
          ...permissionArgs,
          "--output-format",
          "json",
          "-p",
        ];
      } else if (harness === "kimi") {
        args = [
          "-m",
          resolved.model,
          ...permissionArgs,
          "--output-format",
          "stream-json",
          "-p",
        ];
      } else if (harness === "pi") {
        // pi's model flag takes the provider-qualified id — exactly the auth probe's
        // rule (#265): prefix with the provider unless the model already starts with it.
        // A bare "contains a slash" test is wrong for provider-local namespaces
        // (openrouter + qwen/qwen3-coder-plus must spawn as the full three-part id).
        const qualified = resolved.provider && resolved.model.startsWith(`${resolved.provider}/`)
          ? resolved.model
          : resolved.provider ? `${resolved.provider}/${resolved.model}` : resolved.model;
        args = [
          "--model",
          qualified,
          ...permissionArgs,
          ...oneShot.argv,
        ];
      } else {
        throw new Error(`oneshot_harness_unsupported: ${harness} permission_profile_unaudited`);
      }

      const taskPrompt = request.prompt
        ?? `Execute step ${request.stepId} (attempt ${request.stepAttempt}) for agent ${request.agentId}.`;
      const promptMessage = `${taskPrompt}\n\nReturn a final JSON object with an "outcome" field chosen from ${JSON.stringify(request.allowedOutcomes)} and a concise "summary". Do not wrap it in Markdown. If no allowed outcome is truthful, return {"outcome":"failed"}; never infer success from an incomplete task.`;

      let input: string | undefined;
      if (oneShot.promptVia === "stdin") {
        input = promptMessage;
      } else {
        if (harness === "grok") args.push("--single");
        args.push(promptMessage);
      }

      const spawnFn = options.spawnProcess ?? defaultSpawn;
      const cwd = options.projectRoot ?? process.cwd();
      const timeoutMs = request.timeoutMs ?? options.timeoutMs;
      const evidence = await beginOneShotEvidence(options.evidenceRoot ?? oneShotEvidenceRoot(), {
        runId: request.runId, stepId: request.stepId, attemptId: request.attemptId, assignmentId: request.assignmentId,
        harness, provider: resolved.provider, model: resolved.model, cwd, command, args, input,
        timeoutMs: timeoutMs ?? 120_000,
      }, [request.capability, ...Object.entries(env).filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD|COOKIE|AUTH/i.test(key)).map(([, value]) => value ?? "")]);
      let procResult: KxmOneShotProcessResult;
      try {
        procResult = request.signal.aborted
          ? { stdout: "", stderr: "", code: null, started: false, observedChildExit: false, error: new Error("process_aborted") }
          : await spawnFn(command, args, { cwd, env, input, timeoutMs, signal: request.signal });
      } catch (error) {
        // A rejected adapter promise is not proof that no process/effect started.
        procResult = { stdout: "", stderr: "", code: null, observedChildExit: false, error: error instanceof Error ? error : new Error("process_adapter_error") };
      }

      // Parse available usage even when execution failed or was interrupted.
      let parsed: OneShotParsedOutput;
      try { parsed = oneShot.usageParser(procResult.stdout, procResult.stderr, resolved.model); }
      catch { parsed = { text: "", isError: true }; }
      const aborted = request.signal.aborted || procResult.error?.message === "process_aborted";
      // Process groups are cleanup, not containment. A detached descendant or
      // provider leader may outlive the client; interrupted effects need recovery.
      const unverifiedDescendants = procResult.unverifiedDescendants === true
        || procResult.terminationRequested === true
        || procResult.error?.message === "process_exit_unobserved"
        || (procResult.observedChildExit === false && procResult.started !== false);
      const effectUncertain = unverifiedDescendants || Boolean(procResult.signal);
      const transportFailed = procResult.code !== 0 || Boolean(procResult.error) || effectUncertain;
      const outcome = aborted ? "cancelled" : transportFailed || parsed.isError ? "failed"
        : determineOutcome(parsed.text, request.allowedOutcomes);
      const providerMetadata: Record<string, string | number | boolean> = {
        processStatus: aborted ? "aborted" : transportFailed ? "failed" : "completed",
        executionEvidenceId: evidence.id,
        permission,
        permissionProfile: permission === "edit" ? "writer" : "read-only",
        authored: false,
      };
      if (procResult.code !== null && Number.isFinite(procResult.code)) providerMetadata.processExitCode = procResult.code;
      if (procResult.signal) providerMetadata.processSignal = procResult.signal;
      if (procResult.observedChildExit !== undefined) providerMetadata.observedChildExit = procResult.observedChildExit;
      if (procResult.started !== undefined) providerMetadata.processStarted = procResult.started;
      if (procResult.terminationRequested !== undefined) providerMetadata.terminationRequested = procResult.terminationRequested;
      if (unverifiedDescendants) providerMetadata.descendantEffects = "unverified";
      if (procResult.error) {
        const reason = procResult.error.message;
        providerMetadata.processError = /^process_(aborted|timeout|output_limit|stdin_error|stdio_error|stdio_unclosed|exit_unobserved)$/.test(reason) ? reason : "process_error";
      }
      const latencyMs = Math.max(0, Date.now() - startTime);
      const usage = parsed.usage;
      const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      const boundedCount = (field: string, value: unknown): number | null => {
        if (validCount(value) && value <= 1_000_000) return value;
        if (typeof value === "number" && Number.isFinite(value)) {
          providerMetadata[`raw${field[0]!.toUpperCase()}${field.slice(1)}`] = value;
        }
        return null;
      };
      const tokensIn = boundedCount("tokensIn", usage?.tokensIn);
      const tokensOut = boundedCount("tokensOut", usage?.tokensOut);
      const cacheReadTokens = boundedCount("cacheReadTokens", usage?.cacheReadTokens);
      const cacheWriteTokens = boundedCount("cacheWriteTokens", usage?.cacheWriteTokens);
      const contextTokens = boundedCount("contextTokens", usage?.contextTokens);
      if (typeof usage?.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) providerMetadata.providerReportedCostUsd = usage.costUsd;

      // List estimates and provider-reported amounts are not proof of a bill.
      let catalog: PriceCatalog | undefined;
      try {
        catalog = options.priceCatalog ? parsePriceCatalog(JSON.stringify(options.priceCatalog))
          : loadPriceCatalog(options.projectRoot ?? process.cwd());
      } catch { providerMetadata.priceCatalogUnavailable = true; }
      // Without a freshness-aware vendor feed, don't silently quote an older
      // local snapshot. Even today's hash-verified snapshot is only an estimate.
      if (catalog && catalog.date !== new Date().toISOString().slice(0, 10)) {
        providerMetadata.priceCatalogStale = true;
        catalog = undefined;
      }
      const subscription = ["claude.ai", "ChatGPT", "antigravity-oauth"].includes(auth.authMethod ?? "");
      const costBasis = subscription ? "unmetered" as const : "unknown" as const;
      const costUsd = null;
      const priceRef = subscription ? `subscription:${harness}` : undefined;
      if (auth.authMethod) providerMetadata.authMethod = auth.authMethod;
      const priceRow = catalog ? findModelPrice(catalog, resolved.model, resolved.provider) : undefined;
      const flatTier = priceRow?.tiers.length === 1 && priceRow.tiers[0]?.upToContextTokens == null ? priceRow.tiers[0] : undefined;
      // Unknown context occupancy cannot select a context tier. Claude reports
      // uncached input separately; other protocols need their own price semantics.
      if (catalog && harness === "claude" && flatTier
        && validCount(usage?.tokensIn) && validCount(usage?.tokensOut)
        && validCount(usage?.cacheReadTokens) && validCount(usage?.cacheWriteTokens)
        && (usage.cacheReadTokens === 0 || flatTier.cacheReadPerMillion != null)
        && (usage.cacheWriteTokens === 0 || flatTier.cacheWritePerMillion != null)) {
        const calculated = calculateModelCost(catalog, {
          model: resolved.model, provider: resolved.provider,
          tokensIn: usage.tokensIn, tokensOut: usage.tokensOut,
          cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
          contextTokens,
        });
        if (calculated && Number.isFinite(calculated.costUsd)) {
          providerMetadata.listCostUsd = calculated.costUsd;
          providerMetadata.listPriceRef = calculated.priceRef;
          providerMetadata.listPriceSha256 = catalog.sha256;
        }
      }

      const result: KxmProducerResult = {
        outcome,
        costBasis,
        costUsd,
        tokensIn,
        tokensOut,
        cacheReadTokens,
        cacheWriteTokens,
        contextTokens,
        latencyMs,
        harness,
        provider: resolved.provider,
        requestedModel: resolved.model,
        effectiveModel: parsed.effectiveModel ?? "unknown",
        providerMetadata,
        ...(effectUncertain ? { effectUncertain: true as const } : {}),
        ...(resolved.thinking !== undefined ? { thinking: resolved.thinking } : {}),
        agentRole: request.agentRole ?? request.agentId,
        ...(priceRef !== undefined ? { priceRef } : {}),
      };
      try { providerMetadata.executionEvidenceSha256 = await evidence.finish(procResult, result); }
      catch {
        providerMetadata.evidenceWriteFailed = true;
        return { ...result, outcome: "failed", effectUncertain: true };
      }
      return result;
  }

  const producer: KxmOneShotProducer = {
    id: "oneshot",
    produce(request): Promise<KxmProducerResult> {
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const pending = Promise.resolve().then(() => executeRequest({ ...request, signal }))
        .finally(() => { running.delete(controller); });
      running.set(controller, pending);
      return pending;
    },

    async close(): Promise<void> {
      closed = true;
      const pending = [...running.values()];
      for (const controller of running.keys()) controller.abort();
      await Promise.allSettled(pending);
    },
  };

  registerTrustedProducer(producer);
  return producer;
}
