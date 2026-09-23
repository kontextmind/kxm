/**
 * Claude Code plugin hook entry, bundled as dist/claude-hook.js.
 *
 * `node dist/claude-hook.js session-start` prints one SessionStart JSON object
 * whose additionalContext holds a short status for this project (hub state,
 * this project's active runs, the open request count for this agent, fix hints
 * addressed to the user) followed by the project memory brief.
 *
 * The hook is read-only and scoped to the project Claude Code opened: it
 * writes no files, mints no token, spawns nothing, and never prints a token,
 * a plugin option other than server_url, agent_name and project, or journal
 * text. Outside a KXM project it prints nothing. It always exits 0.
 *
 * Bounds: stdin 300 ms, hub health probe 300 ms, SQLite busy timeout 250 ms
 * across at most three databases. The plugin manifest timeout is the only
 * hard limit; an internal timer cannot fire while a synchronous SQLite read
 * blocks.
 *
 * The heavy modules load through dynamic import so a failure while they load
 * (for example a Node without node:sqlite) is caught and the hook stays
 * silent instead of exiting non-zero.
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionTokenFixHint } from "./session-token-hint.ts";

const STDIN_LIMIT_BYTES = 64 * 1024;
const STDIN_WAIT_MS = 300;
const HUB_PROBE_MS = 300;
const SNAPSHOT_BUSY_TIMEOUT_MS = 250;
const STATUS_MAX_CHARS = 1500;
const MAX_ACTIVE_RUNS = 3;
const ACTIVE_RUN_STATUSES = new Set(["running", "waiting", "created", "preparing"]);
const DEFAULT_SERVER_URL = "http://127.0.0.1:7331";

interface HookInput {
  cwd?: unknown;
}

function readHookInput(): Promise<HookInput> {
  const stdin = process.stdin;
  if (stdin.isTTY) return Promise.resolve({});
  return new Promise((resolveInput) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (overflow: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onEnd);
      stdin.pause();
      if (overflow) {
        resolveInput({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolveInput(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as HookInput : {});
      } catch {
        resolveInput({});
      }
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > STDIN_LIMIT_BYTES) finish(true);
      else chunks.push(buffer);
    };
    const onEnd = (): void => finish(false);
    const timer = setTimeout(onEnd, STDIN_WAIT_MS);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onEnd);
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Values read from disk or options stay on one line of the context. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function sessionStartContext(input: HookInput, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const inputCwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const root = resolve(env.CLAUDE_PROJECT_DIR?.trim() || inputCwd || process.cwd());
  if (!isDirectory(join(root, ".kxm"))) return undefined;

  const [
    { resolveSessionHubStatus },
    { loadLocalMeshSnapshot, resolveKxmSnapshotPaths },
    { formatMemoryBriefText, generateMemoryBrief },
    { defaultProjectName },
    { enforceToolPolicy },
    { parse },
  ] = await Promise.all([
    import("./session-work.ts"),
    import("./local-snapshot.ts"),
    import("./memory.ts"),
    import("./project-name.ts"),
    import("./commands.ts"),
    import("yaml"),
  ]);

  // Same inputs .mcp.json hands the MCP server.
  const hubProject = defaultProjectName(root, { ...env, KXM_PROJECT: env.CLAUDE_PLUGIN_OPTION_PROJECT ?? "" });
  const recipientName = env.CLAUDE_PLUGIN_OPTION_AGENT_NAME?.trim() || undefined;
  const url = (env.CLAUDE_PLUGIN_OPTION_SERVER_URL?.trim() || DEFAULT_SERVER_URL).replace(/\/$/, "");
  let runtimeProjectId: string | undefined;
  try {
    const project = parse(readFileSync(join(root, ".kxm", "project.yaml"), "utf8")) as { id?: unknown } | null;
    if (typeof project?.id === "string" && project.id.trim()) runtimeProjectId = project.id.trim();
  } catch {
    // No readable project.yaml: no Runtime runs.
  }

  const hub = await resolveSessionHubStatus(url, fetch, HUB_PROBE_MS);
  const lines = [`KXM project ${oneLine(hubProject)} · hub ${hub.state} at ${url}`];

  try {
    const paths = resolveKxmSnapshotPaths(root, env);
    const snapshot = loadLocalMeshSnapshot(paths.dataPath, paths.stateDir, {
      env,
      projectRoot: root,
      busyTimeoutMs: SNAPSHOT_BUSY_TIMEOUT_MS,
      scope: { hubProject, runtimeProjectId, recipientName },
    });
    const active = snapshot.runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).slice(0, MAX_ACTIVE_RUNS);
    if (active.length > 0) {
      lines.push("Active workflow runs in this project:");
      for (const run of active) {
        const stage = run.currentStage ? ` stage=${oneLine(run.currentStage)}` : "";
        const mine = recipientName && run.targetAgentName === recipientName ? " (assigned to you)" : "";
        lines.push(`- ${oneLine(run.id)} ${oneLine(run.definitionId)} ${oneLine(run.status)}${stage}${mine}`);
      }
    }
    if (recipientName) lines.push(`Open peer requests to ${oneLine(recipientName)}: ${snapshot.openMessageTotal}`);
  } catch {
    // Unreadable local state: report the hub and hints without runs.
  }

  lines.push("Call kxm_context with your role and task before planning; kxm_workflow_get <runId> for an assigned run; kxm_inbox then kxm_reply for peer requests.");
  if (hub.state !== "on") {
    lines.push(`The KXM hub is ${hub.state} at ${url}, so kxm_* tools will fail. Ask the user to start it with \`kxm hub start\` (the kxm CLI installs separately: npm install --global --omit=peer @kontextmind/kxm).`);
  }
  const tokenHint = sessionTokenFixHint(enforceToolPolicy("kxm_list", env));
  if (tokenHint) lines.push(tokenHint);

  const status = truncate(lines.join("\n"), STATUS_MAX_CHARS);
  let memory: string | undefined;
  try {
    // Unmodified and untruncated: the same facts `kxm memory brief` prints.
    memory = formatMemoryBriefText(generateMemoryBrief(root));
  } catch {
    // A malformed memory file: keep the status sections.
  }
  return memory === undefined ? status : `${status}\n\n${memory}`;
}

async function main(argv: readonly string[]): Promise<void> {
  let output = "";
  try {
    if (argv[2] === "session-start") {
      const context = await sessionStartContext(await readHookInput(), process.env);
      if (context !== undefined) {
        output = `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`;
      }
    }
  } catch {
    output = "";
  }
  if (!output) process.exit(0);
  process.stdout.write(output, () => process.exit(0));
}

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
void main(process.argv);
