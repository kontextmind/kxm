import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  registerTrustedProducer,
  type KxmProducer,
  type KxmProducerRequest,
  type KxmProducerResult,
} from "./engine.ts";
import {
  probeHarnessAssignmentAsync,
  type HarnessAssignmentProbeOptions,
  type HarnessInventory,
  type HarnessStatus,
} from "./harness.ts";
import {
  calculateModelCost,
  loadPriceCatalogForEstimate,
  type PriceCatalog,
} from "./prices.ts";

export interface PiRpcProcess {
  readonly stdin: { write(chunk: string): boolean };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export interface PiUsageStats {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  totalTokens?: number | undefined;
  contextUsage?: {
    tokens?: number | undefined;
    contextWindow?: number | undefined;
    percent?: number | undefined;
  } | undefined;
}

export interface PiPromptResult {
  outcome: string;
  text: string;
  usage?: PiUsageStats | undefined;
}

export function formatPiSessionKey(params: {
  runId: string;
  agentId: string;
  instanceNo?: number | undefined;
  scopeEpoch?: number | undefined;
}): string {
  if (params.agentId === "coordinator") {
    return `coordinator:${params.runId}`;
  }
  return `${params.runId}:${params.agentId}:${params.instanceNo ?? 1}:${params.scopeEpoch ?? 1}`;
}

export function formatPiSessionDisplayName(params: {
  runId: string;
  agentId: string;
  instanceNo?: number | undefined;
  scopeEpoch?: number | undefined;
}): string {
  const shortRun = params.runId.length > 8 ? params.runId.slice(0, 8) : params.runId;
  if (params.agentId === "coordinator") {
    return `coordinator@${shortRun}`;
  }
  return `${params.agentId}@${shortRun}#${params.instanceNo ?? 1}.${params.scopeEpoch ?? 1}`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part && "text" in part && typeof (part as { text: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}

function asJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function outcomeField(value: Record<string, unknown>): string | undefined {
  const outcome = value.outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

/**
 * The result a reply actually declares, or `undefined` when it declares none.
 *
 * Two shapes count: the whole reply is one JSON object, or a **standalone** result object on a
 * line of its own — and when there is more than one of those, the **last** one wins, because
 * that is where a reply puts its answer after showing an example. If anything in the tail after
 * that declaration still looks like an outcome key, the reply is **ambiguous and settles
 * `failed`**. What is deliberately not accepted: an outcome *word* anywhere in prose, and an
 * object embedded mid-sentence, so
 * `Example: {"outcome": "passed"}. Actual result: {"outcome": "failed"}` declares nothing at
 * all and settles as `failed` rather than letting the illustration outrank the answer.
 */
function declaredOutcomeOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const whole = asJsonObject(trimmed);
  if (whole) return outcomeField(whole);
  const lines = trimmed.split(/\r?\n/);
  let declaration: { index: number; outcome: string } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const outcome = outcomeField(asJsonObject(lines[index]!.trim()) ?? {});
    if (outcome !== undefined) declaration = { index, outcome };
  }
  if (!declaration) return undefined;
  // Ambiguity after the declaration fails closed. Anything in the tail that still looks like
  // an outcome key — an inline `Actual result: {"outcome": "failed"}` on the next line, a
  // pretty-printed object, or a second mention — means we cannot tell which one the reply is
  // reporting, and guessing is exactly the behaviour this function exists to remove. Trailing
  // prose that says nothing about outcomes is fine, which is what lets a real reply put its
  // usage or sign-off after the result block.
  const tail = lines.slice(declaration.index + 1).join("\n");
  if (/"outcome"\s*:/.test(tail)) return undefined;
  return declaration.outcome;
}

function determineOutcome(text: string, allowedOutcomes: readonly string[]): string {
  // Structured result only. What does **not** count: an outcome *word* anywhere in the text —
  // "the tests did not pass" used to settle a step as `passed` — and an empty or unstructured
  // reply, which used to default to success. Undeclared here means `failed`; if the step does
  // not declare `failed` the engine records `outcome_unknown` and terminates as `failed` anyway.
  const declared = declaredOutcomeOf(text);
  return declared !== undefined && allowedOutcomes.includes(declared) ? declared : "failed";
}

export class PiSession {
  readonly key: string;
  readonly displayName: string;
  readonly runId: string;
  readonly agentId: string;
  readonly instanceNo: number;
  readonly scopeEpoch: number;
  readonly sessionDir?: string | undefined;
  readonly model?: string | undefined;

  private process: PiRpcProcess;
  private status: "idle" | "busy" | "closed" = "idle";
  private commandCounter = 0;
  private pendingCommands = new Map<string, { resolve: (res: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  private activePrompt?: {
    resolve: (res: PiPromptResult) => void;
    reject: (err: Error) => void;
    allowedOutcomes: readonly string[];
    text: string;
    usage: PiUsageStats;
    signal?: AbortSignal | undefined;
    signalCleanup?: (() => void) | undefined;
    aborted?: boolean | undefined;
  } | undefined;
  private lineDecoder = new StringDecoder("utf8");
  private lineBuffer = "";

  constructor(params: {
    key: string;
    displayName: string;
    runId: string;
    agentId: string;
    instanceNo: number;
    scopeEpoch: number;
    sessionDir?: string | undefined;
    model?: string | undefined;
    process: PiRpcProcess;
  }) {
    this.key = params.key;
    this.displayName = params.displayName;
    this.runId = params.runId;
    this.agentId = params.agentId;
    this.instanceNo = params.instanceNo;
    this.scopeEpoch = params.scopeEpoch;
    this.sessionDir = params.sessionDir;
    this.model = params.model;
    this.process = params.process;

    this.attachStdout();
    this.attachProcessEvents();
  }

  isClosed(): boolean {
    return this.status === "closed";
  }

  isBusy(): boolean {
    return this.status === "busy";
  }

  private attachStdout(): void {
    this.process.stdout.on("data", (chunk: Buffer | string) => {
      this.lineBuffer += this.lineDecoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      let newlineIdx: number;
      while ((newlineIdx = this.lineBuffer.indexOf("\n")) !== -1) {
        let line = this.lineBuffer.slice(0, newlineIdx);
        this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          this.handleRpcMessage(parsed);
        } catch {
          // ignore non-JSON output from subprocess
        }
      }
    });
  }

  private attachProcessEvents(): void {
    this.process.on("close", (code, signal) => {
      this.status = "closed";
      const err = new Error(`pi_process_closed: code=${code ?? "null"} signal=${signal ?? "null"}`);
      for (const pending of this.pendingCommands.values()) {
        pending.reject(err);
      }
      this.pendingCommands.clear();
      if (this.activePrompt) {
        this.activePrompt.signalCleanup?.();
        this.activePrompt.reject(err);
        this.activePrompt = undefined;
      }
    });

    this.process.on("error", (err) => {
      this.status = "closed";
      for (const pending of this.pendingCommands.values()) {
        pending.reject(err);
      }
      this.pendingCommands.clear();
      if (this.activePrompt) {
        this.activePrompt.signalCleanup?.();
        this.activePrompt.reject(err);
        this.activePrompt = undefined;
      }
    });
  }

  private handleRpcMessage(msg: Record<string, unknown>): void {
    if (msg.type === "response" && typeof msg.id === "string") {
      const pending = this.pendingCommands.get(msg.id);
      if (pending) {
        this.pendingCommands.delete(msg.id);
        if (msg.success === false) {
          pending.reject(new Error(typeof msg.error === "string" ? msg.error : "rpc_command_failed"));
        } else {
          pending.resolve(msg);
        }
      }
      return;
    }

    if (!this.activePrompt) return;

    if (msg.type === "message_update") {
      if (msg.usage && typeof msg.usage === "object") {
        this.updateUsage(msg.usage as Record<string, unknown>);
      }
    } else if (msg.type === "turn_end") {
      const message = msg.message as Record<string, unknown> | undefined;
      if (message && message.content !== undefined) {
        this.activePrompt.text += `${extractText(message.content)}\n`;
      }
      if (message && message.usage && typeof message.usage === "object") {
        this.updateUsage(message.usage as Record<string, unknown>);
      }
    } else if (msg.type === "agent_end") {
      const messages = msg.messages;
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (m && typeof m === "object" && (m as Record<string, unknown>).role === "assistant") {
            const content = (m as Record<string, unknown>).content;
            if (content) this.activePrompt.text += `${extractText(content)}\n`;
            const usage = (m as Record<string, unknown>).usage;
            if (usage && typeof usage === "object") this.updateUsage(usage as Record<string, unknown>);
          }
        }
      }
    } else if (msg.type === "agent_settled") {
      const active = this.activePrompt;
      this.activePrompt = undefined;
      this.status = "idle";
      active.signalCleanup?.();
      const isAborted = active.aborted || active.signal?.aborted;
      let outcome: string;
      if (isAborted) {
        // A cancel is a cancel. The old chain fell through to `allowedOutcomes[0]` when the
        // step declared neither `cancelled` nor `failed`, so aborting a step whose only
        // declared outcome was `passed` reported `passed`. Returning `cancelled` instead lets
        // the engine record `outcome_unknown` and terminate `failed` — never a borrowed success.
        outcome = "cancelled";
      } else {
        outcome = determineOutcome(active.text, active.allowedOutcomes);
      }
      active.resolve({
        outcome,
        text: active.text.trim() || (isAborted ? "aborted" : ""),
        usage: active.usage,
      });
    }
  }

  private updateUsage(raw: Record<string, unknown>): void {
    if (!this.activePrompt) return;
    const u = this.activePrompt.usage;
    if (typeof raw.input === "number") u.input = raw.input;
    if (typeof raw.output === "number") u.output = raw.output;
    if (typeof raw.cacheRead === "number") u.cacheRead = raw.cacheRead;
    if (typeof raw.cacheWrite === "number") u.cacheWrite = raw.cacheWrite;
    if (typeof raw.totalTokens === "number") u.totalTokens = raw.totalTokens;
    if (raw.contextUsage && typeof raw.contextUsage === "object") {
      const cu = raw.contextUsage as Record<string, unknown>;
      u.contextUsage = {
        tokens: typeof cu.tokens === "number" ? cu.tokens : undefined,
        contextWindow: typeof cu.contextWindow === "number" ? cu.contextWindow : undefined,
        percent: typeof cu.percent === "number" ? cu.percent : undefined,
      };
    }
  }

  async sendCommand(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.status === "closed") {
      throw new Error("pi_session_closed");
    }
    const id = `cmd_${++this.commandCounter}`;
    const payload = { ...command, id };
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });
      try {
        this.process.stdin.write(JSON.stringify(payload) + "\n");
      } catch (err) {
        this.pendingCommands.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async prompt(
    message: string,
    allowedOutcomes: readonly string[],
    signal?: AbortSignal,
  ): Promise<PiPromptResult> {
    if (this.status === "closed") {
      throw new Error("pi_session_closed");
    }
    if (this.status === "busy") {
      throw new Error("pi_session_busy");
    }
    if (signal?.aborted) {
      // Same rule as the in-flight abort: never fall back to the first declared outcome.
      return { outcome: "cancelled", text: "aborted", usage: {} };
    }

    this.status = "busy";

    return new Promise((resolve, reject) => {
      let signalCleanup: (() => void) | undefined;
      if (signal) {
        const onAbort = () => {
          if (this.activePrompt) {
            this.activePrompt.aborted = true;
          }
          void this.abort().catch(() => {});
        };
        signal.addEventListener("abort", onAbort, { once: true });
        signalCleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.activePrompt = {
        resolve,
        reject,
        allowedOutcomes,
        text: "",
        usage: {},
        signal,
        signalCleanup,
        aborted: false,
      };

      this.sendCommand({ type: "prompt", message }).catch((err) => {
        if (this.activePrompt) {
          this.activePrompt.signalCleanup?.();
          this.activePrompt = undefined;
          this.status = "idle";
        }
        reject(err);
      });
    });
  }

  async abort(): Promise<void> {
    if (this.status === "closed") return;
    if (this.activePrompt) {
      this.activePrompt.aborted = true;
    }
    try {
      await this.sendCommand({ type: "abort" });
    } catch {
      // ignore abort write errors
    }
  }

  async close(): Promise<void> {
    if (this.status === "closed") return;
    this.status = "closed";
    try {
      this.process.kill();
    } catch {
      // ignore kill errors
    }
  }
}

export interface KxmPiProducerOptions {
  projectRoot?: string | undefined;
  sessionDir?: string | undefined;
  piCommand?: string | undefined;
  inventory?: HarnessInventory | undefined;
  priceCatalog?: PriceCatalog | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  spawnProcess?: ((command: string, args: readonly string[], options: Record<string, unknown>) => PiRpcProcess) | undefined;
  probeHarness?: ((options: Omit<HarnessAssignmentProbeOptions, "runCommand"> & { signal?: AbortSignal | undefined }) => HarnessStatus | Promise<HarnessStatus>) | undefined;
  resolveModel?: ((agentId: string, runId: string) => { provider?: string | undefined; model?: string | undefined; thinking?: string | undefined } | undefined) | undefined;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
}

export interface KxmPiProducer extends KxmProducer {
  readonly id: "pi";
  readonly sessions: ReadonlyMap<string, PiSession>;
  produce(request: KxmProducerRequest): Promise<KxmProducerResult>;
  close(): Promise<void>;
  closeRun(runId: string): Promise<void>;
}

export function createKxmPiProducer(options: KxmPiProducerOptions = {}): KxmPiProducer {
  const sessions = new Map<string, PiSession>();
  const defaultModel = options.defaultModel ?? "xai/grok-4.6";
  const defaultProvider = options.defaultProvider ?? "xai";

  function parseModelString(spec: string): { provider: string; model: string } {
    const trimmed = spec.trim();
    if (trimmed.includes("/")) {
      const idx = trimmed.indexOf("/");
      return { provider: trimmed.slice(0, idx).toLowerCase(), model: trimmed.slice(idx + 1) };
    }
    return { provider: defaultProvider, model: trimmed };
  }

  function resolveModelForRequest(request: KxmProducerRequest): { provider: string; model: string; thinking?: string | undefined } {
    if (request.model) {
      // A separate provider field means the model id is bare and may itself be
      // namespaced (`qwen/qwen3-coder-plus` under `openrouter`); reparsing it as a
      // provider/model selector strips the namespace and sends the wrong model. Only
      // parse when the provider must come from the string itself.
      if (request.provider) {
        return { provider: request.provider.toLowerCase(), model: request.model, thinking: request.thinking };
      }
      const parsed = parseModelString(request.model);
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
        const parsed = parseModelString(resolved.model);
        return {
          provider: resolved.provider?.toLowerCase() ?? parsed.provider,
          model: parsed.model,
          thinking: resolved.thinking,
        };
      }
    }
    const parsed = parseModelString(defaultModel);
    return { provider: parsed.provider, model: parsed.model };
  }

  async function checkPiAuth(provider: string, model: string, signal: AbortSignal): Promise<void> {
    if (options.inventory) {
      const piEntry = options.inventory.harnesses.find((h) => h.id === "pi");
      if (!piEntry || !piEntry.detected || piEntry.authenticated === false) {
        throw new Error("pi_not_authenticated: pi harness not authenticated in inventory");
      }
    }

    const probeFn = options.probeHarness ?? probeHarnessAssignmentAsync;
    const probe = await probeFn({
      harness: "pi",
      provider,
      model,
      env: options.env,
      signal,
      timeoutMs: 10_000,
    });

    if (!probe.detected) {
      throw new Error(`pi_not_authenticated: pi harness not detected (${probe.issues.join(", ")})`);
    }
    if (probe.authenticated !== true) {
      throw new Error(`pi_not_authenticated: pi not authenticated for provider ${provider} (${probe.issues.join(", ")})`);
    }
  }

  async function getOrCreateSession(request: KxmProducerRequest, model: string): Promise<PiSession> {
    const key = formatPiSessionKey({
      runId: request.runId,
      agentId: request.agentId,
      instanceNo: request.instanceNo,
      scopeEpoch: request.scopeEpoch,
    });

    const existing = sessions.get(key);
    if (existing && !existing.isClosed()) {
      return existing;
    }

    const displayName = formatPiSessionDisplayName({
      runId: request.runId,
      agentId: request.agentId,
      instanceNo: request.instanceNo,
      scopeEpoch: request.scopeEpoch,
    });

    const command = options.piCommand ?? "pi";
    const args = ["--mode", "rpc", "--name", displayName];
    if (options.sessionDir) {
      const safeDirName = key.replace(/[^a-zA-Z0-9_-]/g, "_");
      args.push("--session-dir", join(options.sessionDir, request.runId, safeDirName));
    }
    if (model) {
      args.push("--model", model);
    }

    let proc: PiRpcProcess;
    if (options.spawnProcess) {
      proc = options.spawnProcess(command, args, { env: options.env ?? process.env });
    } else {
      const child = spawn(command, args, {
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc = {
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr ?? undefined,
        kill: (sig) => child.kill(sig),
        on: (ev: any, listener: any) => {
          child.on(ev, listener);
          return proc;
        },
      };
    }

    const session = new PiSession({
      key,
      displayName,
      runId: request.runId,
      agentId: request.agentId,
      instanceNo: request.instanceNo ?? 1,
      scopeEpoch: request.scopeEpoch ?? 1,
      sessionDir: options.sessionDir,
      model,
      process: proc,
    });

    sessions.set(key, session);
    return session;
  }

  const producer: KxmPiProducer = {
    id: "pi",
    get sessions(): ReadonlyMap<string, PiSession> {
      return sessions;
    },

    async produce(request: KxmProducerRequest): Promise<KxmProducerResult> {
      const startTime = Date.now();
      const resolved = resolveModelForRequest(request);

      // Preflight auth check - fails closed via the async bounded probe
      await checkPiAuth(resolved.provider, resolved.model, request.signal);

      // Get or create session
      const session = await getOrCreateSession(request, resolved.model);

      const promptMessage = request.prompt
        ?? `Execute step ${request.stepId} (attempt ${request.stepAttempt}) for agent ${request.agentId}. Allowed outcomes: ${request.allowedOutcomes.join(", ")}.`;

      let promptResult: PiPromptResult;
      try {
        promptResult = await session.prompt(promptMessage, request.allowedOutcomes, request.signal);
      } catch (err) {
        return Promise.reject(err);
      }

      const latencyMs = Math.max(0, Date.now() - startTime);
      const usage = promptResult.usage;
      const tokensIn = typeof usage?.input === "number" ? usage.input : null;
      const tokensOut = typeof usage?.output === "number" ? usage.output : null;
      const cacheReadTokens = typeof usage?.cacheRead === "number" ? usage.cacheRead : null;
      const cacheWriteTokens = typeof usage?.cacheWrite === "number" ? usage.cacheWrite : null;
      const contextTokens = typeof usage?.contextUsage?.tokens === "number" ? usage.contextUsage.tokens : tokensIn;

      // Catalog errors must not discard observed usage or crash settlement.
      const providerMetadata: Record<string, string | number | boolean> = {};
      const loaded = loadPriceCatalogForEstimate({
        priceCatalog: options.priceCatalog,
        projectRoot: options.projectRoot,
      });
      if (loaded.unavailable) providerMetadata.priceCatalogUnavailable = true;
      if (loaded.stale) providerMetadata.priceCatalogStale = true;
      const catalog = loaded.catalog;
      const costBasis = "unknown" as const;
      const costUsd = null;
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
        if (calculated && Number.isFinite(calculated.costUsd)) {
          providerMetadata.listCostUsd = calculated.costUsd;
          providerMetadata.listPriceRef = calculated.priceRef;
          providerMetadata.listPriceSha256 = catalog.sha256;
        }
      }

      return {
        outcome: promptResult.outcome,
        costBasis,
        costUsd,
        tokensIn,
        tokensOut,
        cacheReadTokens,
        cacheWriteTokens,
        contextTokens,
        latencyMs,
        harness: "pi",
        provider: resolved.provider,
        requestedModel: resolved.model,
        effectiveModel: resolved.model,
        providerMetadata,
        ...(resolved.thinking !== undefined ? { thinking: resolved.thinking } : {}),
        agentRole: request.agentRole ?? request.agentId,
      };
    },

    async closeRun(runId: string): Promise<void> {
      const toClose: PiSession[] = [];
      for (const [key, session] of sessions.entries()) {
        if (session.runId === runId) {
          toClose.push(session);
          sessions.delete(key);
        }
      }
      await Promise.all(toClose.map((s) => s.close()));
    },

    async close(): Promise<void> {
      const toClose = [...sessions.values()];
      sessions.clear();
      await Promise.all(toClose.map((s) => s.close()));
    },
  };

  registerTrustedProducer(producer);
  return producer;
}
