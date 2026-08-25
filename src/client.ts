import type { AgentRecord, DeliveryMode, HubEvent, MessageRecord } from "./protocol.ts";

export interface MeshClientOptions {
  serverUrl: string;
  authToken?: string;
  name: string;
  purpose: string;
  project: string;
  model?: string;
  heartbeatMs?: number;
  reconnectMs?: number;
}

export interface SendOptions {
  target: string;
  content: string;
  delivery?: DeliveryMode;
  hops?: number;
  maxHops?: number;
  correlationId?: string;
  replyTo?: string;
}

export class MeshClient {
  readonly options: MeshClientOptions;
  agent?: AgentRecord;
  private agentKey?: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private eventsAbort?: AbortController;
  private stopped = true;
  private onEvent?: (event: HubEvent) => void | Promise<void>;

  constructor(options: MeshClientOptions) {
    this.options = { heartbeatMs: 10_000, reconnectMs: 1_000, ...options };
  }

  async start(onEvent: (event: HubEvent) => void | Promise<void>): Promise<AgentRecord> {
    if (!this.stopped) throw new Error("mesh client is already started");
    this.stopped = false;
    this.onEvent = onEvent;
    const registration = await this.request<{ agent: AgentRecord; agentKey: string }>("/v1/agents/register", {
      method: "POST",
      body: JSON.stringify({
        name: this.options.name,
        purpose: this.options.purpose,
        project: this.options.project,
        model: this.options.model,
      }),
    }, false);
    this.agent = registration.agent;
    this.agentKey = registration.agentKey;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.options.heartbeatMs);
    this.heartbeatTimer.unref();
    void this.runEventLoop();
    return this.agent;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.eventsAbort?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.agent) {
      try {
        await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}`, { method: "DELETE" });
      } catch {
        // The hub may already be gone during process shutdown.
      }
    }
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.request<{ agents: AgentRecord[] }>("/v1/agents");
    return result.agents;
  }

  async send(options: SendOptions): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>("/v1/messages", {
      method: "POST",
      body: JSON.stringify(options),
    });
    return result.message;
  }

  async getMessage(messageId: string): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>(`/v1/messages/${encodeURIComponent(messageId)}`);
    return result.message;
  }

  async acknowledge(messageId: string): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>(
      `/v1/messages/${encodeURIComponent(messageId)}/ack`,
      { method: "POST", body: "{}" },
    );
    return result.message;
  }

  async reply(messageId: string, content: string): Promise<MessageRecord> {
    const result = await this.request<{ message: MessageRecord }>(
      `/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { method: "POST", body: JSON.stringify({ content }) },
    );
    return result.message;
  }

  async awaitResponse(messageId: string, timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<MessageRecord> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("await cancelled");
      const message = await this.getMessage(messageId);
      if (message.status === "replied" || message.status === "error") return message;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("await cancelled"));
        }, { once: true });
      });
    }
    throw new Error(`timed out waiting for ${messageId}`);
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || !this.agent) return;
    try {
      await this.request(`/v1/agents/${encodeURIComponent(this.agent.id)}/heartbeat`, {
        method: "POST",
        body: "{}",
      });
    } catch {
      // The event loop and the next user-visible operation expose lasting failures.
    }
  }

  private async runEventLoop(): Promise<void> {
    while (!this.stopped && this.agent) {
      this.eventsAbort = new AbortController();
      try {
        const response = await fetch(
          `${this.options.serverUrl.replace(/\/$/, "")}/v1/events?agentId=${encodeURIComponent(this.agent.id)}`,
          {
            headers: this.headers(),
            signal: this.eventsAbort.signal,
          },
        );
        if (!response.ok || !response.body) throw new Error(`event stream failed with HTTP ${response.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          if (this.stopped) break;
          buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const parsed = JSON.parse(data) as HubEvent | { agent: AgentRecord };
            if ("type" in parsed) await this.onEvent?.(parsed);
          }
        }
      } catch (error) {
        if (this.stopped || (error instanceof Error && error.name === "AbortError")) return;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.options.reconnectMs));
    }
  }

  private headers(includeIdentity = true): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    if (includeIdentity && this.agent && this.agentKey) {
      headers["x-mesh-agent-id"] = this.agent.id;
      headers["x-mesh-agent-key"] = this.agentKey;
    }
    return headers;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, includeIdentity = true): Promise<T> {
    const response = await fetch(`${this.options.serverUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { ...this.headers(includeIdentity), ...(init.headers ?? {}) },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) throw new Error(String(body.error ?? `HTTP ${response.status}`));
    return body as T;
  }
}

