import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubClient, RuntimeHubClient } from "../../plugins/kxm/src/client.ts";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { createMeshHub, type MeshHub } from "../../plugins/kxm/src/hub.ts";
import { ensureHubRunning, type HubSpawnOptions } from "../../plugins/kxm/src/hub-autostart.ts";
import { readHubBinding } from "../../plugins/kxm/src/hub-binding.ts";
import {
  agentSessionEnv,
  resolveAgentHubAuthToken,
  resolveClientAdminAuthToken,
  resolveClientHubAuthToken,
  writeHubEnvRecord,
} from "../../plugins/kxm/src/hub-env.ts";
import { workflowWebhookHeaders } from "../../plugins/kxm/src/workflow.ts";

const ADMIN = "local-admin-token-value";
const PROJECT_TOKEN = "local-project-token-value";
const EXPLICIT_TOKEN = "local-explicit-token-value";
const CLOUD = "remote-admin-token-value";
const PROJECT = "prj_localcheckout0001";
const EXPLICIT = "prj_localexplicit0001";

function capture(): CliIo & { read(): { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

interface Seen {
  auth: string[];
  statuses: number[];
  bodies: string[];
  urls: string[];
}

function watchFetch(): { seen: Seen; fetchImpl: NonNullable<CliIo["fetchImpl"]>; reset(): Seen } {
  const seen: Seen = { auth: [], statuses: [], bodies: [], urls: [] };
  return {
    seen,
    reset() {
      const snap: Seen = {
        auth: [...seen.auth],
        statuses: [...seen.statuses],
        bodies: [...seen.bodies],
        urls: [...seen.urls],
      };
      seen.auth.length = 0;
      seen.statuses.length = 0;
      seen.bodies.length = 0;
      seen.urls.length = 0;
      return snap;
    },
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.auth.push(headers.get("authorization") ?? "");
      seen.urls.push(String(input));
      if (init?.body !== undefined) seen.bodies.push(String(init.body));
      const response = await fetch(input, init);
      seen.statuses.push(response.status);
      return response;
    },
  };
}

function assertOnlyBearer(auth: string[], token: string): void {
  const presented = auth.filter((value) => value.length > 0);
  assert.ok(presented.length > 0, `expected a bearer, saw ${JSON.stringify(auth)}`);
  for (const value of presented) assert.equal(value, `Bearer ${token}`);
}

function assertNoBearer(auth: string[], token: string): void {
  assert.equal(auth.includes(`Bearer ${token}`), false, `sent ${token}`);
}

function gitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
}

function localEnv(state: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KXM_STATE_HOME: state,
    KXM_AGENT_NAME: "reviewer",
    // Present on purpose. Local mode must ignore a cloud token variable.
    KXMD_HUB_TOKEN: CLOUD,
  };
}

function writeLocalHubEnv(env: NodeJS.ProcessEnv): void {
  writeHubEnvRecord({
    schema: "kxm.hub-env.v1",
    createdAt: "2026-09-27T00:00:00.000Z",
    authToken: ADMIN,
    projectTokens: {
      [PROJECT]: PROJECT_TOKEN,
      [EXPLICIT]: EXPLICIT_TOKEN,
    },
  }, env);
}

async function startLocalHub(): Promise<{ hub: MeshHub; url: string }> {
  const hub = createMeshHub({
    port: 0,
    host: "127.0.0.1",
    authToken: ADMIN,
    projectTokens: {
      [PROJECT]: PROJECT_TOKEN,
      [EXPLICIT]: EXPLICIT_TOKEN,
    },
    shutdownGraceMs: 50,
    webhookWorkflows: [{
      id: "local-review",
      source: "generic",
      project: PROJECT,
      target: "reviewer",
      secret: "local-webhook-secret-value",
      delivery: "followUp",
      promptTemplate: "Review {{task}}",
      stages: [{ id: "review", label: "Review", instructions: "Review the change", requiredEvidence: [], maxAttempts: 1 }],
    }],
  });
  const address = await hub.start();
  return { hub, url: address.url };
}

async function initCheckout(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  gitRoot(cwd);
  const init = capture();
  assert.equal(await runCli(["init", "--json", "--name", "Local", "--project-id", PROJECT], env, init, cwd), 0, init.read().stderr);
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm" })}\n`);
}

/** Every hub work type against a loopback hub with no cloud binding.
 * Operator calls use the hub-env admin token. Agent calls use the project
 * token. Nothing reads KXMD_HUB_TOKEN. */
async function exerciseLocalWork(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  url: string;
  watch: ReturnType<typeof watchFetch>;
  deliveryId: string;
}): Promise<void> {
  const { cwd, env, url, watch } = input;
  const inbox = new HubClient({
    serverUrl: url,
    authToken: PROJECT_TOKEN,
    name: "inbox",
    purpose: "inbox",
    project: PROJECT,
    heartbeatMs: 60_000,
  });
  await inbox.start(() => undefined);
  try {
    const viewed = capture();
    watch.reset();
    assert.equal(await runCli(["hub", "--json", "view"], env, { ...viewed, fetchImpl: watch.fetchImpl }, cwd), 0, viewed.read().stderr);
    const viewBody = JSON.parse(viewed.read().stdout) as { target?: { scope?: string } };
    assert.equal(viewBody.target?.scope, "loopback");
    const viewSnap = watch.reset();
    assert.deepEqual(viewSnap.auth.filter((value) => value.length > 0), []);
    assertNoBearer(viewSnap.auth, CLOUD);
    assertNoBearer(viewSnap.auth, ADMIN);

    const listed = capture();
    assert.equal(await runCli(["peer", "--json", "list"], env, { ...listed, fetchImpl: watch.fetchImpl }, cwd), 0, listed.read().stderr);
    const listSnap = watch.reset();
    assertOnlyBearer(listSnap.auth, PROJECT_TOKEN);
    assertNoBearer(listSnap.auth, ADMIN);
    assertNoBearer(listSnap.auth, CLOUD);
    const register = listSnap.bodies.map((body) => JSON.parse(body) as { project?: string }).find((body) => body.project);
    assert.equal(register?.project, PROJECT);
    assert.equal(listed.read().stdout.includes("@kontextmind/kxm"), false);

    const sent = capture();
    assert.equal(await runCli(
      ["peer", "--json", "send", "--target", "inbox", "--content", "local ping"],
      env,
      { ...sent, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, sent.read().stderr);
    assertOnlyBearer(watch.reset().auth, PROJECT_TOKEN);
    assert.match(sent.read().stdout, /"target":"inbox"/);
    assert.match(sent.read().stdout, /"status":"queued"/);

    const payload = JSON.stringify({ task: "local-review" });
    const webhook = await fetch(`${url}/v1/webhooks/local-review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...workflowWebhookHeaders({
          secret: "local-webhook-secret-value",
          scope: { definitionId: "local-review" },
          deliveryId: input.deliveryId,
          body: payload,
        }),
      },
      body: payload,
    });
    const webhookText = await webhook.text();
    assert.equal(webhook.status, 202, webhookText);
    const started = JSON.parse(webhookText) as { runId: string };
    assert.ok(started.runId);

    const recorded = capture();
    assert.equal(await runCli([
      "workflow", "--json", "record", started.runId, "observation", "local review noted",
      "--stage-id", "review", "--area", "workflow",
    ], env, { ...recorded, fetchImpl: watch.fetchImpl }, cwd), 0, recorded.read().stderr);
    assertOnlyBearer(watch.reset().auth, PROJECT_TOKEN);

    const checkpoint = capture();
    assert.equal(await runCli([
      "workflow", "--json", "checkpoint", started.runId, "review", "passed", "local review passed",
    ], env, { ...checkpoint, fetchImpl: watch.fetchImpl }, cwd), 0, checkpoint.read().stderr);
    assertOnlyBearer(watch.reset().auth, PROJECT_TOKEN);

    const contextMissing = capture();
    watch.reset();
    const contextMissingCode = await runCli([
      "context", "--json", "get", PROJECT, "--role", "implementer", "--task", "status",
    ], env, { ...contextMissing, fetchImpl: watch.fetchImpl }, cwd);
    const contextMissingSnap = watch.reset();
    assert.equal(contextMissingCode, 1);
    assert.equal(contextMissingSnap.statuses.includes(401), true);
    assert.deepEqual(contextMissingSnap.auth.filter((value) => value.length > 0), []);

    const contextEnv = { ...env, KXM_AUTH_TOKEN: ADMIN };
    const context = capture();
    assert.equal(await runCli([
      "context", "--json", "get", PROJECT, "--role", "implementer", "--task", "status",
    ], contextEnv, { ...context, fetchImpl: watch.fetchImpl }, cwd), 0, context.read().stderr);
    assertOnlyBearer(watch.reset().auth, ADMIN);

    const tenant = capture();
    assert.equal(await runCli(["tenant", "--json", "status"], env, { ...tenant, fetchImpl: watch.fetchImpl }, cwd), 0, tenant.read().stderr);
    const tenantBody = JSON.parse(tenant.read().stdout) as { project?: string; bindingScope?: string };
    assert.equal(tenantBody.project, PROJECT);
    assert.equal(tenantBody.bindingScope, "loopback");
    assertOnlyBearer(watch.reset().auth, ADMIN);

    const flagged = capture();
    assert.equal(await runCli(
      ["peer", "--json", "list", "--project", EXPLICIT],
      env,
      { ...flagged, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, flagged.read().stderr);
    const flaggedSnap = watch.reset();
    assertOnlyBearer(flaggedSnap.auth, EXPLICIT_TOKEN);
    const flaggedRegister = flaggedSnap.bodies.map((body) => JSON.parse(body) as { project?: string }).find((body) => body.project);
    assert.equal(flaggedRegister?.project, EXPLICIT);
    const flaggedTenant = capture();
    assert.equal(await runCli(
      ["tenant", "--json", "status", "--project", EXPLICIT],
      env,
      { ...flaggedTenant, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, flaggedTenant.read().stderr);
    assert.equal((JSON.parse(flaggedTenant.read().stdout) as { project?: string }).project, EXPLICIT);
    assertOnlyBearer(watch.reset().auth, ADMIN);

    const leaseToken = resolveAgentHubAuthToken(env, PROJECT);
    assert.equal(leaseToken, PROJECT_TOKEN);
    const leaseClient = new HubClient({
      serverUrl: url,
      authToken: leaseToken!,
      name: "leaseholder",
      purpose: "leases",
      project: PROJECT,
      heartbeatMs: 60_000,
    });
    await leaseClient.start(() => undefined);
    const lease = await leaseClient.acquireLease("local-bind-resource", 30_000);
    assert.equal(typeof lease.lease.fencingToken, "number");
    await leaseClient.stop();

    const reportToken = resolveAgentHubAuthToken(env, PROJECT);
    assert.equal(reportToken, PROJECT_TOKEN);
    const reportClient = new HubClient({
      serverUrl: url,
      authToken: reportToken!,
      name: "reporter",
      purpose: "improvements",
      project: PROJECT,
      heartbeatMs: 60_000,
    });
    await reportClient.start(() => undefined);
    const report = await reportClient.improvementReport();
    assert.ok(report.entries >= 1);
    await reportClient.stop();

    const presenceToken = resolveClientHubAuthToken(env, PROJECT);
    assert.ok(presenceToken);
    assert.equal(presenceToken, PROJECT_TOKEN);
    const presence = await new RuntimeHubClient({
      serverUrl: url,
      project: PROJECT,
      runtimeId: "rtm_localbind00000000000001",
      authToken: presenceToken,
    }).heartbeat();
    assert.equal(presence.presence, "online");
    assert.equal(presence.runtimeId, "rtm_localbind00000000000001");

    const metricsToken = resolveClientAdminAuthToken(env);
    assert.equal(metricsToken, ADMIN);
    const metrics = await fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
    assert.equal(metrics.status, 200);

    const session = agentSessionEnv(cwd, env);
    assert.equal(session.KXM_PROJECT, PROJECT);
    assert.equal(session.KXM_SERVER_URL, url);
    assert.equal(session.KXM_AUTH_TOKEN, undefined);

    const localCalls: string[] = [];
    const localFetch: NonNullable<CliIo["fetchImpl"]> = async (input, init) => {
      localCalls.push(String(input));
      return watch.fetchImpl(input, init);
    };
    const harness = capture();
    assert.equal(await runCli(["harness", "--json", "list"], env, { ...harness, fetchImpl: localFetch }, cwd), 0, harness.read().stderr);
    const roles = capture();
    assert.equal(await runCli(["role", "--json", "list"], env, { ...roles, fetchImpl: localFetch }, cwd), 0, roles.read().stderr);
    assert.equal(localCalls.some((called) => called.startsWith(url)), false);
  } finally {
    await inbox.stop().catch(() => undefined);
  }
}

test("local hub bind keeps every work type on the local credential and project id", async () => {
  const { hub, url } = await startLocalHub();
  const cwd = mkdtempSync(join(tmpdir(), "kxm-local-project-"));
  const state = mkdtempSync(join(tmpdir(), "kxm-local-state-"));
  const watch = watchFetch();
  const env = localEnv(state);
  try {
    writeLocalHubEnv(env);
    await initCheckout(cwd, env);
    const bound = capture();
    assert.equal(
      await runCli(["hub", "--json", "bind", url], env, { ...bound, fetchImpl: watch.fetchImpl }, cwd),
      0,
      bound.read().stderr,
    );
    const record = JSON.parse(readFileSync(join(state, "hub-binding.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ["boundAt", "schema", "url"]);
    assert.equal(record.cloud, undefined);
    assert.match(bound.read().stdout, /loopback/);
    assert.equal(readFileSync(join(state, "hub-binding.json"), "utf8").includes(ADMIN), false);
    assert.equal(readFileSync(join(state, "hub-binding.json"), "utf8").includes(CLOUD), false);
    assert.equal(readHubBinding(env)?.cloud, undefined);

    await exerciseLocalWork({ cwd, env, url, watch, deliveryId: "local-delivery-1" });
  } finally {
    await hub.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("hub unbind after --cloud restores local credentials, project id, and auto-start", async () => {
  const { hub, url } = await startLocalHub();
  const cwd = mkdtempSync(join(tmpdir(), "kxm-unbind-project-"));
  const state = mkdtempSync(join(tmpdir(), "kxm-unbind-state-"));
  const watch = watchFetch();
  const env = { ...localEnv(state), KXM_SERVER_URL: url };
  try {
    writeLocalHubEnv(env);
    await initCheckout(cwd, env);

    const bound = capture();
    assert.equal(await runCli(
      ["hub", "--json", "bind", "--cloud", "--token-env", "KXMD_HUB_TOKEN", url],
      env,
      { ...bound, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, bound.read().stderr);
    assert.equal(readHubBinding(env)?.cloud, true);

    const cloudPeer = capture();
    watch.reset();
    const cloudCode = await runCli(["peer", "--json", "list"], env, { ...cloudPeer, fetchImpl: watch.fetchImpl }, cwd);
    const cloudSnap = watch.reset();
    assert.notEqual(cloudCode, 0);
    assert.equal(cloudSnap.statuses.includes(401), true);
    assertOnlyBearer(cloudSnap.auth, CLOUD);
    assertNoBearer(cloudSnap.auth, ADMIN);
    assertNoBearer(cloudSnap.auth, PROJECT_TOKEN);

    let spawns = 0;
    const cloudStart = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd,
      env,
      fetchImpl: (async () => {
        throw new Error("forward down");
      }) as typeof fetch,
      spawner: () => {
        spawns += 1;
        return { once: () => undefined };
      },
    });
    assert.equal(cloudStart.status, "failed");
    if (cloudStart.status === "failed") assert.equal(cloudStart.reason, "cloud_hub_unreachable");
    assert.equal(spawns, 0);

    const unbound = capture();
    assert.equal(await runCli(["hub", "unbind"], env, unbound, cwd), 0);
    assert.equal(readHubBinding(env), undefined);

    await exerciseLocalWork({ cwd, env, url, watch, deliveryId: "local-delivery-2" });

    const workdir = mkdtempSync(join(tmpdir(), "kxm-unbind-autostart-"));
    let captured: HubSpawnOptions | undefined;
    const claimPid = 424242;
    const started = await ensureHubRunning({
      config: { hub: { autoStart: "background" } },
      cwd: workdir,
      env: { ...env, KXM_SERVER_URL: "http://127.0.0.1:9", KXM_WORKDIR: workdir },
      fetchImpl: (async () => {
        throw new Error("no local hub yet");
      }) as typeof fetch,
      processExists: () => true,
      sleep: () => Promise.resolve(),
      now: (() => {
        let clock = 1000;
        return () => (clock += 1000);
      })(),
      spawner: (_command, _args, options) => {
        spawns += 1;
        captured = options;
        const stateDir = join(workdir, ".kxm", "state");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "hub.pid"), `${JSON.stringify({ version: 1, pid: claimPid, role: "hub", startedAt: "2026-09-27T00:00:00.000Z" })}\n`);
        return { pid: claimPid, once: () => undefined };
      },
    });
    assert.equal(started.status, "started");
    assert.equal(spawns, 1);
    assert.ok(captured);
    assert.equal(captured.env.KXM_AUTH_TOKEN, ADMIN);
    assert.notEqual(captured.env.KXM_AUTH_TOKEN, CLOUD);
    rmSync(workdir, { recursive: true, force: true });
  } finally {
    await hub.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
