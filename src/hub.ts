import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  DEFAULT_MAX_HOPS,
  DEFAULT_STALE_AFTER_MS,
  MAX_BODY_BYTES,
  MAX_CONTENT_CHARS,
  ProtocolError,
  newId,
  nowIso,
  optionalString,
  parseBoundedInteger,
  parseDeliveryMode,
  requireString,
  type AgentRecord,
  type HubEvent,
  type MessageRecord,
} from "./protocol.ts";

interface InternalAgent extends AgentRecord {
  key: string;
}

export interface MeshHubOptions {
  host?: string;
  port?: number;
  authToken?: string;
  staleAfterMs?: number;
  logger?: (entry: Record<string, unknown>) => void;
}

export interface MeshHub {
  readonly server: Server;
  readonly state: {
    agents: Map<string, InternalAgent>;
    messages: Map<string, MessageRecord>;
  };
  start(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

type SseClient = { response: ServerResponse; heartbeat: NodeJS.Timeout };

function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

function publicAgent(agent: InternalAgent): AgentRecord {
  const { key: _key, ...record } = agent;
  return record;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new ProtocolError(413, "request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ProtocolError(400, "request body must be valid JSON object");
  }
}

export function createMeshHub(options: MeshHubOptions = {}): MeshHub {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7331;
  const authToken = options.authToken?.trim();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const logger = options.logger ?? (() => undefined);

  if (!isLoopback(host) && !authToken) {
    throw new Error("PI_MESH_AUTH_TOKEN is required when binding beyond localhost");
  }

  const agents = new Map<string, InternalAgent>();
  const messages = new Map<string, MessageRecord>();
  const streams = new Map<string, Set<SseClient>>();
  let cleanupTimer: NodeJS.Timeout | undefined;

  function requireHubAuth(request: IncomingMessage): void {
    if (!authToken) return;
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      throw new ProtocolError(401, "invalid hub authentication token");
    }
  }

  function requireAgent(request: IncomingMessage, expectedId?: string): InternalAgent {
    const agentId = expectedId ?? String(request.headers["x-mesh-agent-id"] ?? "");
    const agentKey = String(request.headers["x-mesh-agent-key"] ?? "");
    const agent = agents.get(agentId);
    if (!agent || !agentKey || agent.key !== agentKey) {
      throw new ProtocolError(401, "invalid agent identity");
    }
    agent.lastSeenAt = nowIso();
    agent.online = true;
    return agent;
  }

  function publish(agentId: string, event: HubEvent): boolean {
    const clients = streams.get(agentId);
    if (!clients || clients.size === 0) return false;
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.response.write(frame);
    return true;
  }

  function broadcastPresence(agent: InternalAgent): void {
    for (const candidate of agents.values()) {
      if (candidate.project === agent.project && candidate.id !== agent.id && candidate.online) {
        publish(candidate.id, { type: "presence", agent: publicAgent(agent) });
      }
    }
  }

  function findTarget(project: string, target: string): InternalAgent {
    const byId = agents.get(target);
    if (byId?.project === project && byId.online) return byId;
    const byName = [...agents.values()].find(
      (agent) => agent.project === project && agent.online && agent.name.toLowerCase() === target.toLowerCase(),
    );
    if (!byName) throw new ProtocolError(404, `online target not found: ${target}`);
    return byName;
  }

  function flushPending(agentId: string): void {
    for (const message of messages.values()) {
      if (message.to === agentId && message.status === "queued") {
        publish(agentId, { type: "message", message });
      }
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, agents: [...agents.values()].filter((agent) => agent.online).length });
        return;
      }

      requireHubAuth(request);

      if (method === "POST" && url.pathname === "/v1/agents/register") {
        const body = await readJson(request);
        const name = requireString(body.name, "name", { max: 64 });
        const purpose = requireString(body.purpose ?? "General-purpose Pi agent", "purpose", { max: 256 });
        const project = requireString(body.project, "project", { max: 128 });
        const model = optionalString(body.model, "model", 128);
        const duplicate = [...agents.values()].find(
          (agent) => agent.online && agent.project === project && agent.name.toLowerCase() === name.toLowerCase(),
        );
        if (duplicate) throw new ProtocolError(409, `agent name already active in project: ${name}`);
        const timestamp = nowIso();
        const agent: InternalAgent = {
          id: newId("agt"),
          key: newId("key"),
          name,
          purpose,
          project,
          model,
          connectedAt: timestamp,
          lastSeenAt: timestamp,
          online: true,
        };
        agents.set(agent.id, agent);
        logger({ event: "agent_registered", agentId: agent.id, name, project });
        broadcastPresence(agent);
        json(response, 201, { agent: publicAgent(agent), agentKey: agent.key });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/agents") {
        const current = requireAgent(request);
        const result = [...agents.values()]
          .filter((agent) => agent.project === current.project && agent.online)
          .map(publicAgent);
        json(response, 200, { agents: result });
        return;
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch) {
        const current = requireAgent(request, decodeURIComponent(heartbeatMatch[1]));
        json(response, 200, { agent: publicAgent(current) });
        return;
      }

      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (method === "DELETE" && agentMatch) {
        const current = requireAgent(request, decodeURIComponent(agentMatch[1]));
        current.online = false;
        current.lastSeenAt = nowIso();
        broadcastPresence(current);
        logger({ event: "agent_unregistered", agentId: current.id, project: current.project });
        response.writeHead(204).end();
        return;
      }

      if (method === "GET" && url.pathname === "/v1/events") {
        const agentId = requireString(url.searchParams.get("agentId"), "agentId", { max: 80 });
        const current = requireAgent(request, agentId);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ agent: publicAgent(current) })}\n\n`);
        const client: SseClient = {
          response,
          heartbeat: setInterval(() => response.write(": heartbeat\n\n"), 15_000),
        };
        const clients = streams.get(agentId) ?? new Set<SseClient>();
        clients.add(client);
        streams.set(agentId, clients);
        flushPending(agentId);
        request.on("close", () => {
          clearInterval(client.heartbeat);
          clients.delete(client);
          if (clients.size === 0) streams.delete(agentId);
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/messages") {
        const sender = requireAgent(request);
        const body = await readJson(request);
        const target = findTarget(sender.project, requireString(body.target, "target", { max: 80 }));
        if (target.id === sender.id) throw new ProtocolError(400, "cannot send a request to yourself");
        const content = requireString(body.content, "content", { max: MAX_CONTENT_CHARS });
        const hops = parseBoundedInteger(body.hops, "hops", 0, 0, 100);
        const maxHops = parseBoundedInteger(body.maxHops, "maxHops", DEFAULT_MAX_HOPS, 1, 20);
        if (hops >= maxHops) throw new ProtocolError(400, `hop limit reached (${hops}/${maxHops})`);
        const message: MessageRecord = {
          id: newId("msg"),
          project: sender.project,
          from: sender.id,
          fromName: sender.name,
          to: target.id,
          toName: target.name,
          content,
          delivery: parseDeliveryMode(body.delivery),
          hops,
          maxHops,
          correlationId: optionalString(body.correlationId, "correlationId", 128),
          replyTo: optionalString(body.replyTo, "replyTo", 80),
          createdAt: nowIso(),
          status: "queued",
        };
        messages.set(message.id, message);
        publish(target.id, { type: "message", message });
        logger({ event: "message_sent", messageId: message.id, from: sender.id, to: target.id, hops });
        json(response, 202, { message });
        return;
      }

      const ackMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const receiver = requireAgent(request);
        const message = messages.get(decodeURIComponent(ackMatch[1]));
        if (!message) throw new ProtocolError(404, "message not found");
        if (message.to !== receiver.id) throw new ProtocolError(403, "only the recipient can acknowledge this message");
        if (message.status === "queued") {
          message.status = "delivered";
          message.deliveredAt = nowIso();
        }
        json(response, 200, { message });
        return;
      }

      const replyMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)\/reply$/);
      if (method === "POST" && replyMatch) {
        const receiver = requireAgent(request);
        const message = messages.get(decodeURIComponent(replyMatch[1]));
        if (!message) throw new ProtocolError(404, "message not found");
        if (message.to !== receiver.id) throw new ProtocolError(403, "only the recipient can reply to this message");
        if (message.reply) throw new ProtocolError(409, "message already has a reply");
        const body = await readJson(request);
        message.reply = {
          content: requireString(body.content, "content", { max: MAX_CONTENT_CHARS }),
          createdAt: nowIso(),
        };
        message.repliedAt = message.reply.createdAt;
        message.status = "replied";
        publish(message.from, { type: "reply", message });
        logger({ event: "message_replied", messageId: message.id, from: receiver.id, to: message.from });
        json(response, 200, { message });
        return;
      }

      const messageMatch = url.pathname.match(/^\/v1\/messages\/([^/]+)$/);
      if (method === "GET" && messageMatch) {
        const current = requireAgent(request);
        const message = messages.get(decodeURIComponent(messageMatch[1]));
        if (!message) throw new ProtocolError(404, "message not found");
        if (message.from !== current.id && message.to !== current.id) {
          throw new ProtocolError(403, "message is not visible to this agent");
        }
        json(response, 200, { message });
        return;
      }

      throw new ProtocolError(404, "route not found");
    } catch (error) {
      const statusCode = error instanceof ProtocolError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : "unknown error";
      if (statusCode >= 500) logger({ event: "server_error", message });
      if (!response.headersSent) json(response, statusCode, { error: message });
      else response.end();
    }
  });

  return {
    server,
    state: { agents, messages },
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      cleanupTimer = setInterval(() => {
        const cutoff = Date.now() - staleAfterMs;
        for (const agent of agents.values()) {
          if (agent.online && Date.parse(agent.lastSeenAt) < cutoff) {
            agent.online = false;
            broadcastPresence(agent);
            logger({ event: "agent_stale", agentId: agent.id, project: agent.project });
          }
        }
      }, Math.max(1_000, Math.floor(staleAfterMs / 3)));
      cleanupTimer.unref();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("hub did not expose a TCP address");
      return { host, port: address.port, url: `http://${host}:${address.port}` };
    },
    async close() {
      if (cleanupTimer) clearInterval(cleanupTimer);
      for (const clients of streams.values()) {
        for (const client of clients) {
          clearInterval(client.heartbeat);
          client.response.end();
        }
      }
      streams.clear();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

