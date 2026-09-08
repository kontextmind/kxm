import { spawn } from "node:child_process";
import {
  BUILTIN_HARNESSES,
  NATIVE_HARNESS_PROVIDERS,
  probeHarnessAssignment,
  type HarnessCatalogEntry,
  type HarnessInventory,
} from "./vnext-harness.ts";
import {
  calculateModelCost,
  loadPriceCatalog,
  type PriceCatalog,
} from "./prices.ts";
import {
  registerTrustedProducer,
  type VnextProducer,
  type VnextProducerRequest,
  type VnextProducerResult,
} from "./vnext-engine.ts";

export interface VnextOneShotProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: Error | undefined;
}

export type VnextOneShotSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    input?: string | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  },
) => Promise<VnextOneShotProcessResult>;

export interface VnextOneShotProducerOptions {
  projectRoot?: string | undefined;
  defaultHarness?: string | undefined;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  inventory?: HarnessInventory | undefined;
  catalog?: readonly HarnessCatalogEntry[] | undefined;
  priceCatalog?: PriceCatalog | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  spawnProcess?: VnextOneShotSpawn | undefined;
  probeHarness?: typeof probeHarnessAssignment | undefined;
  resolveHarness?: ((agentId: string, runId: string) => string | undefined) | undefined;
  resolveModel?: ((agentId: string, runId: string) => {
    harness?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    thinking?: string | undefined;
  } | undefined) | undefined;
}

export interface VnextOneShotProducer extends VnextProducer {
  readonly id: "oneshot";
  produce(request: VnextProducerRequest): Promise<VnextProducerResult>;
  close(): Promise<void>;
}

function determineOutcome(text: string, allowedOutcomes: readonly string[]): string {
  const normalized = text.trim();
  const jsonMatch = /"outcome"\s*:\s*"([^"]+)"/.exec(normalized);
  if (jsonMatch && allowedOutcomes.includes(jsonMatch[1]!)) {
    return jsonMatch[1]!;
  }
  for (const outcome of allowedOutcomes) {
    const regex = new RegExp(`\\b${outcome}\\b`, "i");
    if (regex.test(normalized)) {
      return outcome;
    }
  }
  if (allowedOutcomes.includes("passed")) return "passed";
  return allowedOutcomes[0] ?? "completed";
}

export function defaultSpawn(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    input?: string | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<VnextOneShotProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (options.signal) {
      if (options.signal.aborted) {
        child.kill();
        return resolve({ stdout: "", stderr: "aborted", code: null, error: new Error("process_aborted") });
      }
      const onAbort = () => {
        killed = true;
        child.kill();
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => options.signal?.removeEventListener("abort", onAbort));
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      const timer = setTimeout(() => {
        killed = true;
        child.kill();
      }, options.timeoutMs);
      child.on("close", () => clearTimeout(timer));
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({ stdout, stderr, code: null, error: err });
    });

    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        code,
        ...(killed ? { error: new Error("process_aborted") } : {}),
      });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

export function createVnextOneShotProducer(options: VnextOneShotProducerOptions = {}): VnextOneShotProducer {
  const defaultHarness = options.defaultHarness ?? "claude";

  function resolveHarnessForRequest(request: VnextProducerRequest): string {
    if (request.harness) return request.harness;
    if (options.resolveHarness) {
      const resolved = options.resolveHarness(request.agentId, request.runId);
      if (resolved) return resolved;
    }
    if (options.resolveModel) {
      const resolved = options.resolveModel(request.agentId, request.runId);
      if (resolved?.harness) return resolved.harness;
    }
    return defaultHarness;
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
    request: VnextProducerRequest,
    harness: string,
  ): { provider: string; model: string; thinking?: string | undefined } {
    if (request.model) {
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
        const parsed = parseModelString(resolved.model, harness);
        return {
          provider: resolved.provider?.toLowerCase() ?? parsed.provider,
          model: parsed.model,
          thinking: resolved.thinking,
        };
      }
    }
    const defaultModel = options.defaultModel ?? (harness === "codex" ? "gpt-5.6-sol" : "claude-3-7-sonnet");
    const parsed = parseModelString(defaultModel, harness);
    return { provider: parsed.provider, model: parsed.model, thinking: request.thinking };
  }

  function checkAuth(harness: string, provider: string, model: string): void {
    if (options.inventory) {
      const entry = options.inventory.harnesses.find((h) => h.id === harness);
      if (!entry || !entry.detected || entry.authenticated !== true) {
        throw new Error(`${harness}_not_authenticated: ${harness} harness not authenticated in inventory`);
      }
    }

    const probeFn = options.probeHarness ?? probeHarnessAssignment;
    const probe = probeFn({
      harness,
      provider,
      model,
      env: options.env,
    });

    if (!probe.detected) {
      throw new Error(`${harness}_not_authenticated: ${harness} harness not detected (${probe.issues.join(", ")})`);
    }
    if (probe.authenticated !== true) {
      throw new Error(`${harness}_not_authenticated: ${harness} not authenticated (${probe.issues.join(", ")})`);
    }
  }

  const producer: VnextOneShotProducer = {
    id: "oneshot",

    async produce(request: VnextProducerRequest): Promise<VnextProducerResult> {
      const startTime = Date.now();
      const harness = resolveHarnessForRequest(request);
      const resolved = resolveModelForRequest(request, harness);

      // Preflight fail-closed check
      checkAuth(harness, resolved.provider, resolved.model);

      const catalogEntry = (options.catalog ?? BUILTIN_HARNESSES).find((h) => h.id === harness);
      if (!catalogEntry || !catalogEntry.oneShot) {
        throw new Error(`oneshot_harness_unsupported: ${harness}`);
      }

      const command = catalogEntry.commands[0] ?? harness;
      const oneShot = catalogEntry.oneShot;

      let args: string[];
      if (harness === "claude") {
        args = [
          "-p",
          "--model",
          resolved.model,
          ...(resolved.thinking ? ["--effort", resolved.thinking] : []),
          "--output-format",
          "json",
        ];
      } else if (harness === "codex") {
        args = [
          "exec",
          "-m",
          resolved.model,
          ...(resolved.thinking ? ["-c", `model_reasoning_effort="${resolved.thinking}"`] : []),
          "--json",
          "-",
        ];
      } else {
        args = [
          ...oneShot.argv,
          "--model",
          resolved.model,
          ...(resolved.thinking ? ["--thinking", resolved.thinking] : []),
        ];
      }

      const promptMessage = request.prompt
        ?? `Execute step ${request.stepId} (attempt ${request.stepAttempt}) for agent ${request.agentId}. Allowed outcomes: ${request.allowedOutcomes.join(", ")}.`;

      let input: string | undefined;
      if (oneShot.promptVia === "stdin") {
        input = promptMessage;
      } else {
        args.push(promptMessage);
      }

      if (request.signal?.aborted) {
        const outcome = request.allowedOutcomes.includes("cancelled")
          ? "cancelled"
          : (request.allowedOutcomes.includes("failed") ? "failed" : request.allowedOutcomes[0]!);
        return {
          outcome,
          costBasis: "unknown",
          costUsd: null,
          latencyMs: 0,
          harness,
          provider: resolved.provider,
          requestedModel: resolved.model,
          effectiveModel: resolved.model,
          agentRole: request.agentRole ?? request.agentId,
        };
      }

      const spawnFn = options.spawnProcess ?? defaultSpawn;
      const procResult = await spawnFn(command, args, {
        cwd: options.projectRoot ?? process.cwd(),
        env: options.env,
        input,
        timeoutMs: options.timeoutMs,
        signal: request.signal,
      });

      if (request.signal?.aborted || procResult.error?.message === "process_aborted") {
        const outcome = request.allowedOutcomes.includes("cancelled")
          ? "cancelled"
          : (request.allowedOutcomes.includes("failed") ? "failed" : request.allowedOutcomes[0]!);
        return {
          outcome,
          costBasis: "unknown",
          costUsd: null,
          latencyMs: Math.max(0, Date.now() - startTime),
          harness,
          provider: resolved.provider,
          requestedModel: resolved.model,
          effectiveModel: resolved.model,
          agentRole: request.agentRole ?? request.agentId,
        };
      }

      const parsed = oneShot.usageParser(procResult.stdout, procResult.stderr);
      let outcome: string;
      if (parsed.isError) {
        outcome = request.allowedOutcomes.includes("failed") ? "failed" : request.allowedOutcomes[0]!;
      } else {
        outcome = determineOutcome(parsed.text || procResult.stdout, request.allowedOutcomes);
      }

      const latencyMs = Math.max(0, Date.now() - startTime);
      const usage = parsed.usage;
      const tokensIn = typeof usage?.tokensIn === "number" ? usage.tokensIn : null;
      const tokensOut = typeof usage?.tokensOut === "number" ? usage.tokensOut : null;
      const cacheReadTokens = typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : null;
      const cacheWriteTokens = typeof usage?.cacheWriteTokens === "number" ? usage.cacheWriteTokens : null;
      const contextTokens = typeof usage?.contextTokens === "number" ? usage.contextTokens : tokensIn;

      // Price calculation: metered when price row exists, else unmetered for subscription with priceRef
      const catalog = options.priceCatalog ?? loadPriceCatalog(options.projectRoot ?? process.cwd());
      let costBasis: "metered" | "unmetered" | "unknown" = "unknown";
      let costUsd: number | null = null;
      let priceRef: string | undefined;

      if (catalog) {
        const calculated = calculateModelCost(catalog, {
          model: resolved.model,
          provider: resolved.provider,
          tokensIn,
          tokensOut,
          cacheReadTokens,
          cacheWriteTokens,
          contextTokens,
        });
        if (calculated) {
          costBasis = "metered";
          costUsd = calculated.costUsd;
          priceRef = calculated.priceRef;
        }
      }

      if (costBasis === "unknown" && (harness === "claude" || harness === "codex")) {
        costBasis = "unmetered";
        costUsd = null;
        priceRef = `subscription:${harness}`;
      }

      return {
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
        effectiveModel: resolved.model,
        ...(resolved.thinking !== undefined ? { thinking: resolved.thinking } : {}),
        agentRole: request.agentRole ?? request.agentId,
        ...(priceRef !== undefined ? { priceRef } : {}),
      };
    },

    async close(): Promise<void> {
      // One-shot producer holds no persistent process pools
    },
  };

  registerTrustedProducer(producer);
  return producer;
}
