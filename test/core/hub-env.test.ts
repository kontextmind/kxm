import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  HUB_ENV_SCHEMA,
  HubEnvError,
  generateHubAuthToken,
  hubEnvFile,
  readHubEnvRecord,
  resolveAgentHubAuthToken,
  resolveClientHubAuthToken,
  resolveHubCredentials,
  writeHubEnvRecord,
} from "../../plugins/kxm/src/hub-env.ts";

function stateEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-hub-env-"));
  return { env: { KXM_STATE_HOME: root }, root };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("hub env record round-trips with 0600 permissions and strict validation", () => {
  const { env, root } = stateEnv();
  try {
    const record = {
      schema: HUB_ENV_SCHEMA,
      createdAt: "2026-09-11T00:00:00.000Z",
      authToken: "kxm_admin_test-token",
      projectTokens: { demo: "demo-token" },
    };
    assert.equal(writeHubEnvRecord(record, env), hubEnvFile(env));
    assert.equal(existsSync(hubEnvFile(env)), true);
    assert.equal(mode(hubEnvFile(env)), 0o600);
    assert.deepEqual(readHubEnvRecord(env), record);

    writeFileSync(hubEnvFile(env), "{not json");
    assert.throws(() => readHubEnvRecord(env), HubEnvError);
    writeFileSync(hubEnvFile(env), JSON.stringify({ schema: "other.v1", createdAt: "" }));
    assert.throws(() => readHubEnvRecord(env), HubEnvError);
    writeFileSync(hubEnvFile(env), JSON.stringify({ schema: HUB_ENV_SCHEMA, createdAt: "", authToken: "" }));
    assert.throws(() => readHubEnvRecord(env), HubEnvError);
    writeFileSync(hubEnvFile(env), JSON.stringify({ schema: HUB_ENV_SCHEMA, createdAt: "", projectTokens: { "": "x" } }));
    assert.throws(() => readHubEnvRecord(env), HubEnvError);
    assert.equal(readHubEnvRecord({ KXM_STATE_HOME: join(root, "missing") }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveHubCredentials generates once, persists, and reuses across restarts", () => {
  const { env } = stateEnv();
  try {
    // First start with nothing: generates and persists the admin token.
    const first = resolveHubCredentials({ env, generateToken: () => "kxm_admin_gen-1", now: () => "2026-09-11T01:00:00.000Z" });
    assert.equal(first.authToken, "kxm_admin_gen-1");
    assert.equal(first.authTokenSource, "generated");
    assert.equal(first.written, true);

    // Restart without env: reuses the persisted value without rewriting.
    const second = resolveHubCredentials({ env, generateToken: () => "kxm_admin_gen-2" });
    assert.equal(second.authToken, "kxm_admin_gen-1");
    assert.equal(second.authTokenSource, "file");
    assert.equal(second.written, false);

    // Explicit env token wins and is persisted for the next restart.
    const third = resolveHubCredentials({ env: { ...env, KXM_AUTH_TOKEN: "kxm_admin_env-3" } });
    assert.equal(third.authToken, "kxm_admin_env-3");
    assert.equal(third.authTokenSource, "env");
    assert.equal(third.written, true);

    // And survives another restart.
    const fourth = resolveHubCredentials({ env });
    assert.equal(fourth.authToken, "kxm_admin_env-3");
    assert.equal(fourth.authTokenSource, "file");

    // Project tokens persist alongside and merge identically.
    const fifth = resolveHubCredentials({ env: { ...env, KXM_PROJECT_TOKENS: '{"web":"web-token"}' } });
    assert.deepEqual(fifth.projectTokens, { web: "web-token" });
    assert.equal(fifth.written, true);
    const sixth = resolveHubCredentials({ env });
    assert.deepEqual(sixth.projectTokens, { web: "web-token" });
    assert.equal(sixth.projectTokensSource, "file");

    // Invalid KXM_PROJECT_TOKENS fails closed.
    assert.throws(
      () => resolveHubCredentials({ env: { ...env, KXM_PROJECT_TOKENS: "nope" } }),
      HubEnvError,
    );

    // persist:false never writes.
    const other = { KXM_STATE_HOME: join(env.KXM_STATE_HOME!, "other") };
    const skipped = resolveHubCredentials({ env: other, persist: false, generateToken: () => "kxm_admin_gen-9" });
    assert.equal(skipped.authTokenSource, "generated");
    assert.equal(existsSync(hubEnvFile(other)), false);
  } finally {
    rmSync(env.KXM_STATE_HOME!, { recursive: true, force: true });
  }
});

test("resolveClientHubAuthToken prefers env, then project token, then admin token", () => {
  const { env, root } = stateEnv();
  try {
    assert.equal(resolveClientHubAuthToken(env, "demo"), undefined);

    writeHubEnvRecord({
      schema: HUB_ENV_SCHEMA,
      createdAt: "2026-09-16T00:00:00.000Z",
      authToken: "admin-token",
      projectTokens: { demo: "demo-token", other: "other-token" },
    }, env);

    // Project token wins over the admin token for its own project.
    assert.equal(resolveClientHubAuthToken(env, "demo"), "demo-token");
    // Unknown projects fall back to the admin token.
    assert.equal(resolveClientHubAuthToken(env, "unknown"), "admin-token");
    // Explicit env token wins over everything and never touches the file.
    const before = readFileSync(hubEnvFile(env), "utf8");
    assert.equal(resolveClientHubAuthToken({ ...env, KXM_AUTH_TOKEN: " env-token " }, "demo"), "env-token");
    assert.equal(readFileSync(hubEnvFile(env), "utf8"), before, "read-only resolution must not rewrite the record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveClientHubAuthToken fails closed on a malformed persisted record", () => {
  const { env, root } = stateEnv();
  try {
    writeFileSync(hubEnvFile(env), "{not json");
    assert.throws(() => resolveClientHubAuthToken(env, "demo"), HubEnvError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveAgentHubAuthToken never returns the persisted admin token", () => {
  const { env, root } = stateEnv();
  try {
    writeHubEnvRecord({
      schema: HUB_ENV_SCHEMA,
      createdAt: "2026-09-23T00:00:00.000Z",
      authToken: "admin-token",
      projectTokens: { demo: " demo-token " },
    }, env);

    assert.equal(resolveAgentHubAuthToken(env, "demo"), "demo-token");
    // The operator resolver falls back to the admin token here; the agent resolver does not.
    assert.equal(resolveClientHubAuthToken(env, "unknown"), "admin-token");
    assert.equal(resolveAgentHubAuthToken(env, "unknown"), undefined);
    // Inherited object keys are not project tokens.
    assert.equal(resolveAgentHubAuthToken(env, "constructor"), undefined);
    assert.equal(resolveAgentHubAuthToken({ ...env, KXM_AUTH_TOKEN: " env-token " }, "unknown"), "env-token");
    assert.equal(resolveAgentHubAuthToken({ ...env, KXM_AUTH_TOKEN: "  " }, "unknown"), undefined);

    writeHubEnvRecord({ schema: HUB_ENV_SCHEMA, createdAt: "2026-09-23T00:00:00.000Z", authToken: "admin-token" }, env);
    assert.equal(resolveAgentHubAuthToken(env, "demo"), undefined);

    writeFileSync(hubEnvFile(env), "{not json");
    assert.throws(() => resolveAgentHubAuthToken(env, "demo"), HubEnvError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generateHubAuthToken produces long unique url-safe tokens", () => {  const seen = new Set<string>();
  for (let i = 0; i < 16; i += 1) {
    const token = generateHubAuthToken();
    assert.match(token, /^kxm_admin_[A-Za-z0-9_-]{20,}$/);
    seen.add(token);
  }
  assert.equal(seen.size, 16);
});

/** A start that a live hub already owns must refuse before it writes credentials. */
test("kxm-hub wrapper refuses a live-hub conflict without minting an admin token", { timeout: 60_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-hub-wrap-clash-"));
  const userState = mkdtempSync(join(tmpdir(), "kxm-hub-wrap-clash-state-"));
  const stateDir = join(workdir, ".kxm", "state");
  mkdirSync(stateDir, { recursive: true });
  // A well-formed claim whose pid is alive (this test runner): the exact shape
  // `claimPidFile()` refuses on.
  const claim = { version: 1, pid: process.pid, role: "hub", startedAt: new Date().toISOString(), controlFile: "hub.stop" };
  const envFile = join(userState, "hub-env.json");
  try {
    writeFileSync(join(stateDir, "hub.pid"), `${JSON.stringify(claim)}\n`, "utf8");
    const proc = spawn(process.execPath, ["scripts/kxm-hub.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, KXM_WORKDIR: workdir, KXM_STATE_HOME: userState, KXM_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
    const code = await new Promise<number | null>((resolveExit) => proc.once("exit", resolveExit));

    assert.notEqual(code, 0, "a refused start exits nonzero");
    assert.match(err, /already managed by PID/);
    assert.doesNotMatch(out + err, /newly generated KXM_AUTH_TOKEN/, "must not mint a token for a hub it will not start");
    assert.equal(existsSync(envFile), false, "a refused start must not persist hub credentials");
    assert.deepEqual(
      JSON.parse(readFileSync(join(stateDir, "hub.pid"), "utf8")).pid,
      process.pid,
      "the live claim is left untouched",
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(userState, { recursive: true, force: true });
  }
});

/** End-to-end wrapper run: generated token is injected, persisted, and reused. */
test("kxm-hub wrapper generates, injects, and persists credentials across restarts", { timeout: 120_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kxm-hub-wrap-work-"));
  const userState = mkdtempSync(join(tmpdir(), "kxm-hub-wrap-state-"));
  const pidPath = join(workdir, ".kxm", "state", "hub.pid");
  const envFile = join(userState, "hub-env.json");
  let child: ChildProcess | undefined;
  const launch = () => new Promise<{ out: string; code: number | null; exited: Promise<number | null> }>((resolveLaunch) => {
    const proc = spawn(process.execPath, ["scripts/kxm-hub.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, KXM_WORKDIR: workdir, KXM_STATE_HOME: userState, KXM_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    let out = "";
    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    const exited = new Promise<number | null>((resolveExit) => proc.once("exit", resolveExit));
    const seen = new Promise<void>((resolveSeen) => {
      const inspect = () => { if (/kxm hub listening/.test(out)) { resolveSeen(); return; } setTimeout(inspect, 50); };
      inspect();
      setTimeout(() => resolveSeen(), 30_000);
    });
    void seen.then(() => {
      resolveLaunch({ out, code: proc.exitCode, exited });
    });
  });
  try {
    const first = await launch();
    try {
      assert.match(first.out, /using newly generated KXM_AUTH_TOKEN/);
      assert.match(first.out, /auth=token/);
      assert.equal(existsSync(envFile), true);
      assert.equal(mode(envFile), 0o600);
      const persisted = JSON.parse(readFileSync(envFile, "utf8")) as { authToken?: string };
      assert.match(persisted.authToken ?? "", /^kxm_admin_/);
      const record = JSON.parse(readFileSync(pidPath, "utf8")) as { pid: number; serverPid: number };
      assert.equal(Number.isInteger(record.serverPid), true, "wrapper records the server child pid");
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await first.exited;
      }
    }

    // Second start reuses the same persisted token.
    const second = await launch();
    try {
      assert.match(second.out, /using persisted KXM_AUTH_TOKEN/);
      const persisted = JSON.parse(readFileSync(envFile, "utf8")) as { authToken?: string };
      assert.equal(existsSync(pidPath), true, "second wrapper claimed the pid file");
      assert.equal((JSON.parse(readFileSync(envFile, "utf8")) as { authToken?: string }).authToken, persisted.authToken, "token unchanged across restarts");
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await second.exited;
      }
    }
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    rmSync(workdir, { recursive: true, force: true });
    rmSync(userState, { recursive: true, force: true });
  }
});
