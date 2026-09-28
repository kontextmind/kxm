import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "../helpers.ts";

export interface IsolatedMcpEnvOptions {
  /** Hub the spawned server talks to; defaults to a port nothing listens on. */
  hubUrl?: string;
  /** Sets KXM_AUTH_TOKEN; without it the server sees no explicit token. */
  authToken?: string;
  project?: string;
  agentName?: string;
  /** Create `.kxm` in the throwaway project dir, which makes the server register at startup. */
  withKxmDir?: boolean;
  extra?: Record<string, string>;
}

const STOP_GRACE_MS = 5_000;

function whenExited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    if (child.exitCode !== null || child.signalCode !== null) resolve();
  });
}

/** Stop a spawned MCP server, then let the caller remove its directory.
 * `child.kill()` on Windows is TerminateProcess: the server's SIGTERM handler
 * never runs, so the hub agent stays online and the temp directory stays
 * locked. Ending stdin runs the same shutdown the server uses for a client
 * that exits without a signal (unregister, then exit). Kill is the fallback
 * when that shutdown does not finish. */
export async function stopMcpChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = whenExited(child);
  if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
  const graceful = await Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS)),
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch { /* already exited */ }
  await Promise.race([
    done,
    new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
  ]);
}

/** Launch environment for a spawned dist/mcp-server.js that never touches the developer's
 * state. The server resolves its project dir from KXM_PROJECT_DIR, then CLAUDE_PROJECT_DIR,
 * then cwd, and the repository root has a `.kxm`; it reads hub-env.json from KXM_STATE_HOME
 * and session.token from KXM_USER_CONFIG_DIR; and a real hub may listen on 127.0.0.1:7331. */
export function isolatedMcpEnv(options: IsolatedMcpEnvOptions = {}): {
  env: NodeJS.ProcessEnv;
  cwd: string;
  track: (child: ChildProcess) => void;
  cleanup: () => Promise<void>;
} {
  const root = mkdtempSync(join(tmpdir(), "kxm-mcp-spawn-"));
  const projectDir = join(root, "project");
  const stateHome = join(root, "state");
  const userConfigDir = join(root, "user-config");
  mkdirSync(projectDir);
  mkdirSync(stateHome);
  mkdirSync(userConfigDir);
  if (options.withKxmDir) mkdirSync(join(projectDir, ".kxm"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "CLAUDE_PROJECT_DIR",
    "KXM_SESSION_TOKEN",
    "KXM_ATTEMPT_TOKEN",
    "KXM_PROJECT_TOKENS",
    "KXM_AUTH_TOKEN",
    "KXM_PROJECT",
    "KXM_AGENT_NAME",
    "KXM_AGENT_PURPOSE",
  ]) delete env[key];
  env.KXM_PROJECT_DIR = projectDir;
  env.KXM_STATE_HOME = stateHome;
  env.KXM_USER_CONFIG_DIR = userConfigDir;
  env.KXM_SERVER_URL = options.hubUrl ?? "http://127.0.0.1:1";
  if (options.authToken) env.KXM_AUTH_TOKEN = options.authToken;
  if (options.project) env.KXM_PROJECT = options.project;
  if (options.agentName) env.KXM_AGENT_NAME = options.agentName;
  Object.assign(env, options.extra);
  const children: ChildProcess[] = [];
  return {
    env,
    cwd: projectDir,
    track(child) { children.push(child); },
    async cleanup() {
      // After hooks run in registration order, and this cleanup is registered
      // before the test's own stop hook. Stop tracked children here so the
      // directory is not removed while a live process still uses it as cwd.
      await Promise.all(children.splice(0).map((child) => stopMcpChild(child)));
      // A lock that outlasts the child is abandoned after about three seconds.
      // The old 20-by-250ms backoff still ended in EPERM and cost about a
      // minute per directory on windows-latest.
      removeTempDir(root);
    },
  };
}
