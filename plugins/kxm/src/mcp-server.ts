import { statSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HubClient, HubHttpError } from "./client.ts";
import { resolveAgentHubAuthToken } from "./hub-env.ts";
import { defaultProjectName } from "./project-name.ts";
import { AGENT_COMMANDS_MAP, enforceToolPolicy, getMcpTools, reconcileInbox } from "./commands.ts";
import { deliverInboxNotification } from "./inbox.ts";
import type { HubEvent, MessageRecord } from "./protocol.ts";
import { sessionTokenFixHint } from "./session-token-hint.ts";

const VERSION = "0.7.1";
const CONFIGURE_PLUGIN = "/plugin configure kxm@kxm";
const inbox = new Map<string, MessageRecord>();
const notifiedInbox = new Set<string>();
let meshClient: HubClient | undefined;
let starting: Promise<HubClient> | undefined;

const mcp = new Server(
  { name: "kxm", version: VERSION },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Peer requests arrive as <channel source="kxm" message_id="..."> events, or in kxm_inbox; handle each under normal safety rules, then call kxm_reply with message_id and the final response.',
      "For workflow requests, call kxm_workflow_get, record material knowledge with kxm_workflow_record in its ten categories (plan, decision, contradiction, error, lesson, observation, hypothesis, experiment, state-change, skill-candidate), pass the stageId each entry belongs to, and pass every checkpoint before replying.",
      "For external work, call kxm_workflow_wait, then kxm_reply; a signed callback resumes the run.",
      "In a KXM project, call kxm_context with your role and task before planning.",
      "If a KXM tool reports a problem with the hub or token, continue without KXM and tell the user the next step it names.",
    ].join(" "),
  },
);

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Where this session works and which hub it talks to, read from the launch environment. */
function sessionIdentity(): { projectDir: string; project: string; serverUrl: string } {
  const projectDir = process.env.KXM_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return {
    projectDir,
    project: defaultProjectName(projectDir, process.env),
    serverUrl: process.env.KXM_SERVER_URL?.trim() || "http://127.0.0.1:7331",
  };
}

/** Tell the session about an inbox request on the channel, at most once per process. */
async function announce(message: MessageRecord): Promise<void> {
  const meta: Record<string, string> = {
    message_id: message.id,
    from_agent: message.fromName,
    delivery: message.delivery,
  };
  if (message.correlationId) meta.correlation_id = message.correlationId;
  await deliverInboxNotification(message.id, notifiedInbox, async () => {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: [
          `Peer request from ${message.fromName}:`,
          "",
          message.content,
          "",
          `When complete, call kxm_reply with messageId ${message.id}.`,
        ].join("\n"),
        meta,
      },
    });
  });
}

async function onHubEvent(client: HubClient, event: HubEvent): Promise<void> {
  if (event.type === "cancelled" || event.type === "expired") {
    inbox.delete(event.message.id);
    notifiedInbox.delete(event.message.id);
    return;
  }
  if (event.type !== "message") return;
  if (event.message.status === "queued") await client.acknowledge(event.message.id);
  inbox.set(event.message.id, event.message);
  await announce(event.message);
}

/** A durable KXM_AGENT_NAME resumes its agent id, but the event stream replays only requests
 * that agent has not acknowledged. One an earlier process acknowledged and never answered is
 * still open on the hub, so it is read back here and announced like a pushed request: this
 * session has not been told about it. The inbox is reconciled before anything is announced,
 * so a request cancelled or expired while the list was in flight is dropped, not announced;
 * its event may have gone to a stream that was not connected yet. Queued requests are left
 * to the stream, which acknowledges them in order. */
async function seedInbox(client: HubClient): Promise<void> {
  for (const message of await client.listInbox()) {
    if (message.status === "delivered" && !inbox.has(message.id)) inbox.set(message.id, message);
  }
  await reconcileInbox(client, inbox, notifiedInbox);
  for (const messageId of [...inbox.keys()]) {
    const message = inbox.get(messageId);
    if (message) await announce(message);
  }
}

async function startClient(project: string, serverUrl: string, name: string, authToken: string): Promise<HubClient> {
  const candidate = new HubClient({
    serverUrl,
    name,
    purpose: process.env.KXM_AGENT_PURPOSE?.trim() || "Claude Code implementation and review agent",
    project,
    model: "claude-code",
    authToken,
  });
  try {
    await candidate.start((event) => onHubEvent(candidate, event));
    // A tool call waits for the seeded inbox: `starting` stays pending until this returns.
    await seedInbox(candidate);
    meshClient = candidate;
    return candidate;
  } catch (error) {
    await candidate.stop();
    throw error;
  }
}

async function ensureClient(): Promise<HubClient> {
  if (meshClient?.agent) return meshClient;
  if (starting) return starting;
  starting = (async () => {
    const { project, serverUrl } = sessionIdentity();
    // An agent session registers with a project token only. The hub admits its admin token
    // to any project missing from its token map, so no project token fails here, before the
    // hub is contacted.
    const authToken = resolveAgentHubAuthToken(process.env, project);
    if (!authToken) {
      throw new Error(
        `KXM has no project token for project ${project} on this machine. Ask the user to set the kxm plugin auth_token (${CONFIGURE_PLUGIN}) or to add ${project} to the hub KXM_PROJECT_TOKENS, listing every existing project too because that variable replaces the saved map.`,
      );
    }
    const name = process.env.KXM_AGENT_NAME?.trim() || `claude-${process.pid}`;
    try {
      return await startClient(project, serverUrl, name, authToken);
    } catch (error) {
      if (!(error instanceof HubHttpError && error.code === "duplicate_agent_name")) throw error;
      // Another live session in this project holds the name; register beside it once.
      const substitute = `${name}-${process.pid}`;
      process.stderr.write(`kxm: agent name ${name} is already active in project ${project}; this session registers as ${substitute}\n`);
      return await startClient(project, serverUrl, substitute, authToken);
    }
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

/** The reason the hub could not be reached at all, or undefined for any other failure. */
function unreachableCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message.startsWith("request timed out after")) return error.message;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  if (error.message === "fetch failed") {
    if (typeof causeCode === "string") return causeCode;
    return cause instanceof Error && cause.message ? cause.message : error.message;
  }
  if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" || error.message.includes("ECONNREFUSED")) return "ECONNREFUSED";
  return undefined;
}

async function connectedClient(): Promise<HubClient> {
  try {
    return await ensureClient();
  } catch (error) {
    const cause = unreachableCause(error);
    if (!cause) throw error;
    throw new Error(
      `KXM hub unreachable at ${sessionIdentity().serverUrl} (${cause}). Ask the user to start the hub (\`kxm hub start\`) or to correct the kxm plugin server_url with ${CONFIGURE_PLUGIN}.`,
    );
  }
}

/** Tool errors are read by the model, so each names the next step and who takes it. */
function toolErrorText(error: unknown): string {
  if (error instanceof HubHttpError && error.code === "invalid_auth") {
    return `KXM hub rejected the project token for project ${sessionIdentity().project}. Ask the user to set the kxm plugin auth_token (${CONFIGURE_PLUGIN}) to that project's token from the hub KXM_PROJECT_TOKENS.`;
  }
  return error instanceof Error ? error.message : String(error);
}

const tools = getMcpTools();

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const policy = enforceToolPolicy(request.params.name);
    if (!policy.allowed) {
      // The denial stays fail closed; the hint only tells the user how to lift it.
      const hint = sessionTokenFixHint(policy);
      throw new Error(hint ? `tool_policy_denied: ${policy.detail}. ${hint}` : `tool_policy_denied: ${policy.detail ?? policy.error}`);
    }
    const client = await connectedClient();
    const cmd = AGENT_COMMANDS_MAP.get(request.params.name);
    if (!cmd) throw new Error(`unknown tool: ${request.params.name}`);
    const args = asRecord(request.params.arguments);
    // Every open inbound request is work this session is handling; a request it sends
    // meanwhile continues their hop chain.
    const result = await cmd.execute(client, args, {
      signal: extra.signal,
      inbox,
      notifiedInbox,
      handling: [...inbox.values()],
    });
    return textResult(result);
  } catch (error) {
    return {
      content: [{ type: "text" as const, text: toolErrorText(error) }],
      isError: true,
    };
  }
});

/** Register before the first tool call, so peers see this session and its requests arrive,
 * only where a tool call would register anyway: a KXM project with a project token whose tool
 * policy lets the session receive and answer peer requests. */
function registersAtStartup(): boolean {
  const { projectDir, project } = sessionIdentity();
  try {
    if (!statSync(join(projectDir, ".kxm")).isDirectory()) return false;
    if (!resolveAgentHubAuthToken(process.env, project)) return false;
  } catch {
    return false;
  }
  return enforceToolPolicy("kxm_inbox").allowed && enforceToolPolicy("kxm_reply").allowed;
}

// Wait for the client's initialized notification: a channel event sent before the handshake
// completes would be marked delivered while the client could still drop it.
mcp.oninitialized = () => {
  if (registersAtStartup()) void ensureClient().catch(() => undefined);
};

await mcp.connect(new StdioServerTransport());

let shuttingDown: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shuttingDown ??= (async () => {
    const client = meshClient ?? await starting?.catch(() => undefined);
    await client?.stop();
    await mcp.close();
  })();
  return shuttingDown;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
// A client that exits without signalling closes stdin. Leave the hub then, so this session is
// not listed as online and does not hold its agent name against the next session.
process.stdin.once("end", () => void shutdown());
