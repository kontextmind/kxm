import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  HUB_AUTOSTART_LOG_NAME,
  ensureHubRunning,
  hubAutoStartMode,
  readLiveHubClaim,
  type HubSpawnOptions,
} from "../../plugins/kxm/src/hub-autostart.ts";
import { HUB_BINDING_SCHEMA } from "../../plugins/kxm/src/hub-binding.ts";
import { HUB_ENV_SCHEMA, writeHubEnvRecord } from "../../plugins/kxm/src/hub-env.ts";
import { loadKxmConfig } from "../../plugins/kxm/src/config.ts";

function fixture(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function workspaceEnv(home: string, workdir: string): NodeJS.ProcessEnv {
  return { KXM_STATE_HOME: home, KXM_WORKDIR: workdir };
}

function writeClaim(workdir: string, pid: number): void {
  const stateDir = join(workdir, ".kxm", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "hub.pid"), `${JSON.stringify({ version: 1, pid, role: "hub", startedAt: "2026-09-11T00:00:00.000Z" })}\n`);
}

test("hubAutoStartMode defaults to background and fails closed on unknown values", () => {
  assert.equal(hubAutoStartMode(undefined), "background");
  assert.equal(hubAutoStartMode({}), "background");
  assert.equal(hubAutoStartMode({ hub: {} }), "background");
  assert.equal(hubAutoStartMode({ hub: { autoStart: "background" } }), "background");
  assert.equal(hubAutoStartMode({ hub: { autoStart: "off" } }), "off");
  assert.equal(hubAutoStartMode({ hub: { autoStart: "yes" } }), "background");
  assert.equal(hubAutoStartMode({ hub: { autoStart: null } }), "background");
});

test("loadKxmConfig exposes hub.autoStart with a background default and closed normalization", () => {
  const home = fixture("kxm-autostart-cfg-home-");
  const repo = fixture("kxm-autostart-cfg-repo-");
  try {
    assert.equal(loadKxmConfig(repo, { userConfigDir: home }).hub.autoStart, "background");
    writeFileSync(join(home, "config.yaml"), "schema: kxm.config.v1\nhub:\n  autoStart: off\n");
    assert.equal(loadKxmConfig(repo, { userConfigDir: home }).hub.autoStart, "off");
    writeFileSync(join(home, "config.yaml"), "schema: kxm.config.v1\nhub:\n  autoStart: sideways\n");
    assert.equal(loadKxmConfig(repo, { userConfigDir: home }).hub.autoStart, "background");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("auto-start off never probes or spawns", async () => {
  const home = fixture("kxm-autostart-off-home-");
  const workdir = fixture("kxm-autostart-off-work-");
  try {
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "off" } },
      cwd: workdir,
      env: workspaceEnv(home, workdir),
      fetchImpl: (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch,
      spawner: () => {
        throw new Error("must not spawn");
      },
    });
    assert.deepEqual(res, { status: "disabled" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a healthy bound hub is reused without spawning", async () => {
  const home = fixture("kxm-autostart-bound-home-");
  const workdir = fixture("kxm-autostart-bound-work-");
  try {
    writeFileSync(join(home, "hub-binding.json"), `${JSON.stringify({
      schema: HUB_BINDING_SCHEMA,
      url: "http://127.0.0.1:7331",
      boundAt: "2026-09-11T00:00:00.000Z",
    })}\n`);
    let spawns = 0;
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env: workspaceEnv(home, workdir),
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
      spawner: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    });
    assert.deepEqual(res, { status: "bound-healthy", url: "http://127.0.0.1:7331" });
    assert.equal(spawns, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("an unbound but healthy hub on the configured URL is reused without spawning", async () => {
  const home = fixture("kxm-autostart-url-home-");
  const workdir = fixture("kxm-autostart-url-work-");
  try {
    let spawns = 0;
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env: workspaceEnv(home, workdir),
      fetchImpl: (async (input: RequestInfo | URL) => {
        assert.equal(String(input), "http://127.0.0.1:7331/health", "the configured default URL is probed");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
      spawner: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    });
    assert.deepEqual(res, { status: "url-healthy", url: "http://127.0.0.1:7331" });
    assert.equal(spawns, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a live local claim is reused without spawning, and claim parsing is strict", async () => {
  const home = fixture("kxm-autostart-claim-home-");
  const workdir = fixture("kxm-autostart-claim-work-");
  try {
    writeClaim(workdir, process.pid);
    let spawns = 0;
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env: workspaceEnv(home, workdir),
      fetchImpl: (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch,
      spawner: () => {
        spawns += 1;
        throw new Error("must not spawn");
      },
    });
    assert.deepEqual(res, { status: "claim-alive", pid: process.pid });
    assert.equal(spawns, 0);

    const stateDir = join(workdir, ".kxm", "state");
    assert.equal(readLiveHubClaim(stateDir)?.pid, process.pid);
    assert.equal(readLiveHubClaim(stateDir, () => false), undefined, "dead pid is not live");
    writeFileSync(join(stateDir, "hub.pid"), "{not json");
    assert.equal(readLiveHubClaim(stateDir), undefined, "malformed claim is not live");
    writeFileSync(join(stateDir, "hub.pid"), JSON.stringify({ version: 1, pid: process.pid, role: "worker" }));
    assert.equal(readLiveHubClaim(stateDir), undefined, "non-hub role is not live");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("no hub found spawns a detached wrapper and generates + persists a new admin key", async () => {
  const home = fixture("kxm-autostart-start-home-");
  const workdir = fixture("kxm-autostart-start-work-");
  try {
    const claimPid = 424242;
    let captured: HubSpawnOptions | undefined;
    let capturedArgs: readonly string[] = [];
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env: workspaceEnv(home, workdir),
      fetchImpl: (() => Promise.reject(new Error("unreachable"))) as unknown as typeof fetch,
      processExists: () => true,
      sleep: () => Promise.resolve(),
      now: (() => {
        let t = 1000;
        return () => (t += 1000);
      })(),
      spawner: (_command, args, opts) => {
        capturedArgs = args;
        captured = opts;
        writeClaim(workdir, claimPid);
        return { pid: claimPid, once: () => undefined };
      },
    });
    assert.equal(res.status, "started");
    if (res.status !== "started") throw new Error("unreachable");
    assert.equal(res.pid, claimPid);
    assert.equal(res.authTokenSource, "generated");
    assert.ok(res.authToken?.startsWith("kxm_admin_"));

    assert.ok(captured, "wrapper spawned");
    assert.equal(captured!.cwd, resolve(workdir));
    assert.equal(captured!.env.KXM_WORKDIR, resolve(workdir));
    assert.equal(captured!.env.KXM_WORKSPACE_DIR, resolve(join(workdir, ".kxm")));
    assert.equal(captured!.env.KXM_STATE_DIR, resolve(join(workdir, ".kxm", "state")));
    assert.equal(captured!.env.KXM_LOGS_DIR, resolve(join(workdir, ".kxm", "logs")));
    assert.equal(captured!.env.KXM_AUTH_TOKEN, res.authToken);
    assert.equal(captured!.stdio[0], "ignore");
    assert.equal(typeof captured!.stdio[1], "number");
    assert.equal(capturedArgs.length, 1);

    const logPath = join(workdir, ".kxm", "logs", HUB_AUTOSTART_LOG_NAME);
    assert.equal(res.logPath, logPath);
    assert.ok(existsSync(logPath), "auto-start log created");

    const envFile = join(home, "hub-env.json");
    assert.equal(statSync(envFile).mode & 0o777, 0o600, "generated key persisted with 0600");
    const persisted = JSON.parse(readFileSync(envFile, "utf8")) as { schema?: string; authToken?: string };
    assert.equal(persisted.schema, HUB_ENV_SCHEMA);
    assert.equal(persisted.authToken, res.authToken);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a persisted key is reused and never regenerated or rewritten", async () => {
  const home = fixture("kxm-autostart-reuse-home-");
  const workdir = fixture("kxm-autostart-reuse-work-");
  try {
    const env = workspaceEnv(home, workdir);
    const record = {
      schema: HUB_ENV_SCHEMA,
      createdAt: "2026-09-11T00:00:00.000Z",
      authToken: "kxm_admin_persisted-token",
    };
    writeHubEnvRecord(record, env);

    const claimPid = 515151;
    let captured: HubSpawnOptions | undefined;
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env,
      fetchImpl: (() => Promise.reject(new Error("unreachable"))) as unknown as typeof fetch,
      processExists: () => true,
      sleep: () => Promise.resolve(),
      now: (() => {
        let t = 1000;
        return () => (t += 1000);
      })(),
      spawner: (_command, _args, opts) => {
        captured = opts;
        writeClaim(workdir, claimPid);
        return { pid: claimPid, once: () => undefined };
      },
    });
    assert.equal(res.status, "started");
    if (res.status !== "started") throw new Error("unreachable");
    assert.equal(res.authTokenSource, "file");
    assert.equal(res.authToken, "kxm_admin_persisted-token");
    assert.equal(captured!.env.KXM_AUTH_TOKEN, "kxm_admin_persisted-token");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "hub-env.json"), "utf8")), record, "persisted file untouched");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a wrapper that exits before claiming is a failure with the log path, unless a race claimed first", async () => {
  const home = fixture("kxm-autostart-fail-home-");
  const workdir = fixture("kxm-autostart-fail-work-");
  try {
    let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env: workspaceEnv(home, workdir),
      fetchImpl: (() => Promise.reject(new Error("unreachable"))) as unknown as typeof fetch,
      processExists: () => false,
      sleep: () => Promise.resolve(),
      now: (() => {
        let t = 1000;
        return () => (t += 1000);
      })(),
      spawner: () => {
        queueMicrotask(() => exitListener?.(1, null));
        return {
          pid: 626262,
          once: (_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
            exitListener = listener;
          },
        };
      },
    });
    assert.equal(res.status, "failed");
    if (res.status !== "failed") throw new Error("unreachable");
    assert.match(res.reason, /exited before claiming/);
    assert.ok(res.logPath.endsWith(HUB_AUTOSTART_LOG_NAME));
    assert.ok(existsSync(res.logPath));

    // Race: the losing wrapper exits, but a live claim appeared meanwhile.
    const racedHome = fixture("kxm-autostart-race-home-");
    const racedWork = fixture("kxm-autostart-race-work-");
    try {
      const raced = await ensureHubRunning({
        config: { hub: { autoStart: "background" } },
        cwd: racedWork,
        env: workspaceEnv(racedHome, racedWork),
        fetchImpl: (() => Promise.reject(new Error("unreachable"))) as unknown as typeof fetch,
        processExists: () => true,
        sleep: () => Promise.resolve(),
        now: (() => {
          let t = 1000;
          return () => (t += 1000);
        })(),
        spawner: () => {
          queueMicrotask(() => exitListener?.(1, null));
          queueMicrotask(() => writeClaim(racedWork, 737373));
          return {
            pid: 626262,
            once: (_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => {
              exitListener = listener;
            },
          };
        },
      });
      assert.deepEqual(raced, { status: "claim-alive", pid: 737373 });
    } finally {
      rmSync(racedHome, { recursive: true, force: true });
      rmSync(racedWork, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a malformed claim is left for the wrapper to fail closed on; a spawn is still attempted", async () => {
  const home = fixture("kxm-autostart-malformed-home-");
  const workdir = fixture("kxm-autostart-malformed-work-");
  try {
    const stateDir = join(workdir, ".kxm", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "hub.pid"), "this is not a claim");
    let spawns = 0;
    const res = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env: workspaceEnv(home, workdir),
      fetchImpl: (() => Promise.reject(new Error("unreachable"))) as unknown as typeof fetch,
      processExists: () => true,
      sleep: () => Promise.resolve(),
      now: (() => {
        let t = 1000;
        return () => (t += 1000);
      })(),
      spawner: () => {
        spawns += 1;
        writeClaim(workdir, 848484);
        return { pid: 848484, once: () => undefined };
      },
    });
    assert.equal(spawns, 1);
    assert.equal(res.status, "started");
    assert.equal(readFileSync(join(stateDir, "hub.pid"), "utf8").includes("848484"), true, "wrapper-owned claim replaced the malformed file");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
