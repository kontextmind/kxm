import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Launch environment for a spawned dist/mcp-server.js that never touches the developer's
 * state. The server resolves its project dir from KXM_PROJECT_DIR, then CLAUDE_PROJECT_DIR,
 * then cwd, and the repository root has a `.kxm`; it reads hub-env.json from KXM_STATE_HOME
 * and session.token from KXM_USER_CONFIG_DIR; and a real hub may listen on 127.0.0.1:7331. */
export function isolatedMcpEnv(options: IsolatedMcpEnvOptions = {}): {
  env: NodeJS.ProcessEnv;
  cwd: string;
  cleanup: () => void;
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
  return {
    env,
    cwd: projectDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
