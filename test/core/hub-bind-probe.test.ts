import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import {
  hubBindingCloudFile,
  hubBindingFile,
  loadHubBinding,
  readHubBinding,
  readLegacyV1HubBinding,
  writeHubBinding,
  type HubBindingRecord,
} from "../../plugins/kxm/src/hub-binding.ts";

function capture(): CliIo & { read(): { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

test("hub view and bind reject an HTML 200 login page and a 302", async () => {
  const html = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><form>Authentik login</form></body></html>");
  });
  const redirect = await listen((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1/login", "content-type": "text/html" });
    res.end("<html>redirect</html>");
  });
  const state = mkdtempSync(join(tmpdir(), "kxm-hub-probe-state-"));
  const project = mkdtempSync(join(tmpdir(), "kxm-hub-probe-project-"));
  const env: NodeJS.ProcessEnv = { KXM_STATE_HOME: state, PATH: process.env.PATH, HOME: process.env.HOME };
  try {
    const view = capture();
    assert.equal(await runCli(["hub", "--json", "view"], { ...env, KXM_SERVER_URL: html.url }, view, project), 1);
    const viewed = JSON.parse(view.read().stderr) as { ok?: boolean; health?: { error?: string; detail?: string } };
    assert.equal(viewed.ok, false);
    assert.equal(viewed.health?.error, "auth_proxy");
    assert.match(viewed.health?.detail ?? "", /HTML login page/);
    assert.equal(view.read().stderr.includes("<!doctype"), false);
    assert.equal(view.read().stderr.includes("Authentik"), false);

    const bind = capture();
    assert.equal(await runCli(
      ["hub", "--json", "bind", "--cloud", "--token-command", "op read op://Private/kxmd/admin-token", html.url],
      env,
      bind,
      project,
    ), 2);
    const refused = JSON.parse(bind.read().stderr) as { error?: string; detail?: string; kind?: string };
    assert.equal(refused.error, "hub_not_kxm");
    assert.equal(refused.kind, "auth_proxy");
    assert.match(refused.detail ?? "", /auth proxy/);
    assert.equal(existsSync(hubBindingFile(env)), false);
    assert.equal(existsSync(hubBindingCloudFile(env)), false);

    const redirectView = capture();
    assert.equal(await runCli(["hub", "--json", "view"], { ...env, KXM_SERVER_URL: redirect.url }, redirectView, project), 1);
    const redirected = JSON.parse(redirectView.read().stderr) as { health?: { error?: string; detail?: string } };
    assert.equal(redirected.health?.error, "auth_proxy");
    assert.match(redirected.health?.detail ?? "", /HTTP 302/);
    assert.equal(redirectView.read().stderr.includes("<html>"), false);

    const redirectBind = capture();
    assert.equal(await runCli(["hub", "--json", "bind", redirect.url], env, redirectBind, project), 2);
    const redirectRefused = JSON.parse(redirectBind.read().stderr) as { error?: string; kind?: string; detail?: string };
    assert.equal(redirectRefused.error, "hub_not_kxm");
    assert.equal(redirectRefused.kind, "redirect");
    assert.match(redirectRefused.detail ?? "", /redirect/);
    assert.equal(existsSync(hubBindingFile(env)), false);

    const forced = capture();
    assert.equal(await runCli(["hub", "bind", "--force", html.url], env, forced, project), 0);
    assert.equal(existsSync(hubBindingFile(env)), true);
    assert.match(forced.read().stdout, /auth proxy/);
    assert.match(forced.read().stdout, /--force/);
  } finally {
    await html.close();
    await redirect.close();
    rmSync(state, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("a cloud bind stays readable by a 0.7.159 three-key reader and a newer schema falls back", () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-hub-legacy-"));
  const env: NodeJS.ProcessEnv = { KXM_STATE_HOME: root };
  const local: HubBindingRecord = {
    schema: "kxm.hub-binding.v1",
    url: "http://127.0.0.1:7331",
    boundAt: "2026-09-04T12:00:00.000Z",
  };
  const cloud: HubBindingRecord = {
    schema: "kxm.hub-binding.v1",
    url: "http://127.0.0.1:17331",
    boundAt: "2026-09-28T00:00:00.000Z",
    cloud: true,
    tokenCommand: "op read op://Private/kxmd/admin-token",
  };
  try {
    writeHubBinding(local, env);
    writeHubBinding(cloud, env);
    const legacy = readLegacyV1HubBinding(env);
    assert.deepEqual(legacy, local);
    assert.deepEqual(
      Object.keys(JSON.parse(readFileSync(hubBindingFile(env), "utf8")) as object).sort(),
      ["boundAt", "schema", "url"],
    );
    assert.deepEqual(readHubBinding(env), cloud);
    assert.equal(readFileSync(hubBindingCloudFile(env), "utf8").includes("admin-token-value"), false);

    writeFileSync(hubBindingFile(env), JSON.stringify({
      schema: "kxm.hub-binding.v2",
      url: "http://127.0.0.1:7331",
      boundAt: "2026-09-28T00:00:00.000Z",
    }));
    rmSync(hubBindingCloudFile(env), { force: true });
    assert.throws(() => readLegacyV1HubBinding(env), /malformed hub binding/);
    const newer = loadHubBinding(env);
    assert.equal(newer.record, undefined);
    assert.match(newer.warning ?? "", /newer than this build/);
    assert.match(newer.warning ?? "", /Restart the Runtime supervisor/);

    writeFileSync(hubBindingFile(env), `${JSON.stringify(cloud)}\n`);
    const migrated = loadHubBinding(env);
    assert.equal(migrated.record?.cloud, true);
    assert.equal(migrated.record?.tokenCommand, cloud.tokenCommand);
    assert.equal(existsSync(hubBindingFile(env)), false);
    assert.equal(existsSync(hubBindingCloudFile(env)), true);
    assert.match(migrated.warning ?? "", /pre-0\.7\.160/);
    assert.equal(readLegacyV1HubBinding(env), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
