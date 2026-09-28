import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HubClient, RuntimeHubClient } from "../../plugins/kxm/src/client.ts";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { createMeshHub, type MeshHub } from "../../plugins/kxm/src/hub.ts";
import { readHubBinding } from "../../plugins/kxm/src/hub-binding.ts";
import {
  agentSessionEnv,
  resolveAgentHubAuthToken,
  resolveClientAdminAuthToken,
  resolveClientHubAuthToken,
  writeHubEnvRecord,
} from "../../plugins/kxm/src/hub-env.ts";
import { workflowWebhookHeaders } from "../../plugins/kxm/src/workflow.ts";

const REMOTE = "remote-admin-token-value";
const LOCAL = "local-admin-token-value";
const PROJECT = "prj_unifiedcheckout01";
const EXPLICIT = "prj_explicitoverride01";

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

function gitRoot(root: string): void {
  const initialized = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", root], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
}

test("cloud hub bind uses one project id and the remote token for every hub work type", async () => {
  const hub: MeshHub = createMeshHub({
    port: 0,
    host: "127.0.0.1",
    authToken: REMOTE,
    shutdownGraceMs: 50,
    webhookWorkflows: [{
      id: "cloud-review",
      source: "generic",
      project: PROJECT,
      target: "reviewer",
      secret: "cloud-webhook-secret-value",
      delivery: "followUp",
      promptTemplate: "Review {{task}}",
      stages: [{ id: "review", label: "Review", instructions: "Review the change", requiredEvidence: [], maxAttempts: 1 }],
    }],
  });
  const address = await hub.start();
  const cwd = mkdtempSync(join(tmpdir(), "kxm-cloud-project-"));
  const state = mkdtempSync(join(tmpdir(), "kxm-cloud-state-"));
  const extras: string[] = [];
  const watch = watchFetch();
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KXM_STATE_HOME: state,
    KXM_AGENT_NAME: "reviewer",
    KXMD_HUB_TOKEN: REMOTE,
    KXM_AUTH_TOKEN: LOCAL,
  };
  const inbox = new HubClient({
    serverUrl: address.url,
    authToken: REMOTE,
    name: "inbox",
    purpose: "inbox",
    project: PROJECT,
    heartbeatMs: 60_000,
  });
  try {
    gitRoot(cwd);
    const init = capture();
    assert.equal(await runCli(["init", "--json", "--name", "Unified", "--project-id", PROJECT], baseEnv, init, cwd), 0, init.read().stderr);
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "@kontextmind/kxm" })}\n`);
    writeHubEnvRecord({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-27T00:00:00.000Z",
      authToken: LOCAL,
    }, baseEnv);

    const bind = capture();
    assert.equal(await runCli(
      ["hub", "--json", "bind", "--cloud", "--token-env", "KXMD_HUB_TOKEN", address.url],
      baseEnv,
      { ...bind, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, bind.read().stderr);
    const bound = JSON.parse(bind.read().stdout) as { scope?: string; cloud?: boolean; tokenEnv?: string };
    assert.equal(bound.scope, "remote");
    assert.equal(bound.cloud, true);
    assert.equal(bound.tokenEnv, "KXMD_HUB_TOKEN");
    const bindingText = readFileSync(join(state, "hub-binding.json"), "utf8");
    assert.equal(bindingText.includes(REMOTE), false);
    assert.equal(bindingText.includes(LOCAL), false);
    assert.equal(readHubBinding(baseEnv)?.cloud, true);

    const view = capture();
    watch.reset();
    assert.equal(await runCli(["hub", "--json", "view"], baseEnv, { ...view, fetchImpl: watch.fetchImpl }, cwd), 0, view.read().stderr);
    const viewed = JSON.parse(view.read().stdout) as { target?: { scope?: string } };
    assert.equal(viewed.target?.scope, "remote");
    assertOnlyBearer(watch.reset().auth, REMOTE);

    await inbox.start(() => undefined);

    const listed = capture();
    assert.equal(await runCli(["peer", "--json", "list"], baseEnv, { ...listed, fetchImpl: watch.fetchImpl }, cwd), 0, listed.read().stderr);
    const listSnap = watch.reset();
    assertOnlyBearer(listSnap.auth, REMOTE);
    const register = listSnap.bodies.map((body) => JSON.parse(body) as { project?: string }).find((body) => body.project);
    assert.equal(register?.project, PROJECT);
    assert.equal(listed.read().stdout.includes("@kontextmind/kxm"), false);
    assert.match(listed.read().stdout, new RegExp(PROJECT));

    const sent = capture();
    assert.equal(await runCli(
      ["peer", "--json", "send", "--target", "inbox", "--content", "cloud ping"],
      baseEnv,
      { ...sent, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, sent.read().stderr);
    assertOnlyBearer(watch.reset().auth, REMOTE);
    assert.match(sent.read().stdout, /"target":"inbox"/);
    assert.match(sent.read().stdout, /"status":"queued"/);

    const payload = JSON.stringify({ task: "cloud-review" });
    const webhook = await fetch(`${address.url}/v1/webhooks/cloud-review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...workflowWebhookHeaders({
          secret: "cloud-webhook-secret-value",
          scope: { definitionId: "cloud-review" },
          deliveryId: "cloud-delivery-1",
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
      "workflow", "--json", "record", started.runId, "observation", "cloud review noted",
      "--stage-id", "review", "--area", "workflow",
    ], baseEnv, { ...recorded, fetchImpl: watch.fetchImpl }, cwd), 0, recorded.read().stderr);
    assertOnlyBearer(watch.reset().auth, REMOTE);

    const checkpoint = capture();
    assert.equal(await runCli([
      "workflow", "--json", "checkpoint", started.runId, "review", "passed", "cloud review passed",
    ], baseEnv, { ...checkpoint, fetchImpl: watch.fetchImpl }, cwd), 0, checkpoint.read().stderr);
    assertOnlyBearer(watch.reset().auth, REMOTE);

    const context = capture();
    assert.equal(await runCli([
      "context", "--json", "get", PROJECT, "--role", "implementer", "--task", "status",
    ], baseEnv, { ...context, fetchImpl: watch.fetchImpl }, cwd), 0, context.read().stderr);
    assertOnlyBearer(watch.reset().auth, REMOTE);

    const tenant = capture();
    assert.equal(await runCli(["tenant", "--json", "status"], baseEnv, { ...tenant, fetchImpl: watch.fetchImpl }, cwd), 0, tenant.read().stderr);
    const tenantBody = JSON.parse(tenant.read().stdout) as { project?: string; bindingScope?: string };
    assert.equal(tenantBody.project, PROJECT);
    assert.equal(tenantBody.bindingScope, "remote");
    assertOnlyBearer(watch.reset().auth, REMOTE);

    const flagged = capture();
    assert.equal(await runCli(
      ["peer", "--json", "list", "--project", EXPLICIT],
      baseEnv,
      { ...flagged, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, flagged.read().stderr);
    const flaggedRegister = watch.reset().bodies.map((body) => JSON.parse(body) as { project?: string }).find((body) => body.project);
    assert.equal(flaggedRegister?.project, EXPLICIT);
    const flaggedTenant = capture();
    assert.equal(await runCli(
      ["tenant", "--json", "status", "--project", EXPLICIT],
      baseEnv,
      { ...flaggedTenant, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, flaggedTenant.read().stderr);
    assert.equal((JSON.parse(flaggedTenant.read().stdout) as { project?: string }).project, EXPLICIT);
    watch.reset();

    const leaseToken = resolveAgentHubAuthToken(baseEnv, PROJECT);
    assert.equal(leaseToken, REMOTE);
    const leaseClient = new HubClient({
      serverUrl: address.url,
      authToken: leaseToken!,
      name: "leaseholder",
      purpose: "leases",
      project: PROJECT,
      heartbeatMs: 60_000,
    });
    await leaseClient.start(() => undefined);
    const lease = await leaseClient.acquireLease("cloud-bind-resource", 30_000);
    assert.equal(typeof lease.lease.fencingToken, "number");
    await leaseClient.stop();

    const reportClient = new HubClient({
      serverUrl: address.url,
      authToken: resolveAgentHubAuthToken(baseEnv, PROJECT)!,
      name: "reporter",
      purpose: "improvements",
      project: PROJECT,
      heartbeatMs: 60_000,
    });
    await reportClient.start(() => undefined);
    const report = await reportClient.improvementReport();
    assert.ok(report.entries >= 1);
    await reportClient.stop();

    const presenceToken = resolveClientHubAuthToken(baseEnv, PROJECT);
    assert.ok(presenceToken);
    assert.equal(presenceToken, REMOTE);
    const presence = await new RuntimeHubClient({
      serverUrl: address.url,
      project: PROJECT,
      runtimeId: "rtm_cloudbind00000000000001",
      authToken: presenceToken,
    }).heartbeat();
    assert.equal(presence.presence, "online");
    assert.equal(presence.runtimeId, "rtm_cloudbind00000000000001");

    const metricsToken = resolveClientAdminAuthToken(baseEnv);
    assert.equal(metricsToken, REMOTE);
    const metrics = await fetch(`${address.url}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
    assert.equal(metrics.status, 200);

    const session = agentSessionEnv(cwd, baseEnv);
    assert.equal(session.KXM_PROJECT, PROJECT);
    assert.equal(session.KXM_SERVER_URL, address.url);
    assert.equal(session.KXM_AUTH_TOKEN, REMOTE);
    assert.equal(readFileSync(join(state, "hub-binding.json"), "utf8").includes(REMOTE), false);

    const localCalls: string[] = [];
    const localFetch: NonNullable<CliIo["fetchImpl"]> = async (input, init) => {
      localCalls.push(String(input));
      return watch.fetchImpl(input, init);
    };
    const harness = capture();
    assert.equal(await runCli(["harness", "--json", "list"], baseEnv, { ...harness, fetchImpl: localFetch }, cwd), 0, harness.read().stderr);
    const roles = capture();
    assert.equal(await runCli(["role", "--json", "list"], baseEnv, { ...roles, fetchImpl: localFetch }, cwd), 0, roles.read().stderr);
    assert.equal(localCalls.some((url) => url.startsWith(address.url)), false);

    const wrongEnv = { ...baseEnv, KXMD_HUB_TOKEN: "wrong-token-value" };
    const wrong = capture();
    watch.reset();
    const wrongCode = await runCli(["peer", "--json", "list"], wrongEnv, { ...wrong, fetchImpl: watch.fetchImpl }, cwd);
    const wrongSnap = watch.reset();
    assert.notEqual(wrongCode, 0);
    assert.equal(wrongSnap.statuses.includes(401), true, JSON.stringify(wrongSnap.statuses));
    assertOnlyBearer(wrongSnap.auth, "wrong-token-value");
    assert.equal(wrongSnap.auth.includes(`Bearer ${LOCAL}`), false);

    const missingEnv = { ...baseEnv };
    delete missingEnv.KXMD_HUB_TOKEN;
    const missing = capture();
    watch.reset();
    assert.equal(await runCli(["peer", "--json", "list"], missingEnv, { ...missing, fetchImpl: watch.fetchImpl }, cwd), 2);
    const missingText = `${missing.read().stderr}${missing.read().stdout}`;
    assert.match(missingText, /cloud_token_missing/);
    assert.match(missingText, /local hub-env token was not used/);
    assert.equal(watch.reset().auth.includes(`Bearer ${LOCAL}`), false);
    assert.equal(watch.seen.auth.includes(`Bearer ${REMOTE}`), false);

    const script = join(state, "print-hub-token.mjs");
    const secretFile = join(state, "secret-file");
    writeFileSync(secretFile, `${REMOTE}\n`, { mode: 0o600 });
    writeFileSync(script, `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(process.argv[2], "utf8"));\n`);
    const command = `node ${script} ${secretFile}`;
    const rebound = capture();
    assert.equal(await runCli(["hub", "unbind"], baseEnv, rebound, cwd), 0);
    const commandBind = capture();
    assert.equal(await runCli(
      ["hub", "--json", "bind", "--cloud", "--token-command", command, address.url],
      baseEnv,
      { ...commandBind, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, commandBind.read().stderr);
    const commandBinding = readFileSync(join(state, "hub-binding.json"), "utf8");
    assert.equal(commandBinding.includes(REMOTE), false);
    assert.match(commandBinding, /print-hub-token\.mjs/);
    const commandEnv = { ...baseEnv };
    delete commandEnv.KXMD_HUB_TOKEN;
    const commandList = capture();
    watch.reset();
    assert.equal(await runCli(["peer", "--json", "list"], commandEnv, { ...commandList, fetchImpl: watch.fetchImpl }, cwd), 0, commandList.read().stderr);
    assertOnlyBearer(watch.reset().auth, REMOTE);

    const plain = mkdtempSync(join(tmpdir(), "kxm-plain-state-"));
    extras.push(plain);
    const plainEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KXM_STATE_HOME: plain,
      KXM_AGENT_NAME: "reviewer",
      KXMD_HUB_TOKEN: REMOTE,
    };
    writeHubEnvRecord({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-27T00:00:00.000Z",
      authToken: LOCAL,
    }, plainEnv);
    const plainBind = capture();
    assert.equal(await runCli(["hub", "--json", "bind", address.url], plainEnv, { ...plainBind, fetchImpl: watch.fetchImpl }, cwd), 0, plainBind.read().stderr);
    const plainRecord = JSON.parse(readFileSync(join(plain, "hub-binding.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(plainRecord).sort(), ["boundAt", "schema", "url"]);
    assert.match(plainBind.read().stdout, /loopback/);
    const plainTenant = capture();
    watch.reset();
    const plainTenantCode = await runCli(["tenant", "--json", "status"], plainEnv, { ...plainTenant, fetchImpl: watch.fetchImpl }, cwd);
    const plainSnap = watch.reset();
    assert.equal(plainTenantCode, 1);
    assert.match(plainTenant.read().stdout + plainTenant.read().stderr, /hub_unauthorized/);
    assertOnlyBearer(plainSnap.auth, LOCAL);
    assert.equal(plainSnap.auth.includes(`Bearer ${REMOTE}`), false);
    const plainPeer = capture();
    watch.reset();
    assert.equal(await runCli(["peer", "--json", "list"], plainEnv, { ...plainPeer, fetchImpl: watch.fetchImpl }, cwd), 2);
    assert.match(plainPeer.read().stderr, /project_token_missing/);
    assert.equal(watch.reset().auth.includes(`Bearer ${REMOTE}`), false);

    const broken = mkdtempSync(join(tmpdir(), "kxm-broken-local-"));
    extras.push(broken);
    writeFileSync(join(broken, "hub-env.json"), "{malformed");
    const brokenIo = capture();
    assert.equal(await runCli(
      ["hub", "bind", address.url],
      { KXM_STATE_HOME: broken },
      { ...brokenIo, fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) },
      cwd,
    ), 0);
    assert.match(brokenIo.read().stdout, /loopback/);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(broken, "hub-binding.json"), "utf8")) as object).length, 3);
  } finally {
    await inbox.stop().catch(() => undefined);
    await hub.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    for (const extra of extras) rmSync(extra, { recursive: true, force: true });
  }
});
