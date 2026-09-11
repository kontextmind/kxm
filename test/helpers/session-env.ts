import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Tests must not read, overwrite, or inherit an operator's session policy. */
export function isolateSessionEnvironment(): () => void {
  const keys = ["KXM_USER_CONFIG_DIR", "KXM_STATE_HOME", "KXM_SESSION_TOKEN", "KXM_ATTEMPT_TOKEN"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), "kxm-test-session-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  process.env.KXM_USER_CONFIG_DIR = dir;
  process.env.KXM_STATE_HOME = stateDir;
  delete process.env.KXM_SESSION_TOKEN;
  delete process.env.KXM_ATTEMPT_TOKEN;
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}
