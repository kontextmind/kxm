import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli, type CliIo } from "../../plugins/kxm/src/cli.ts";
import { createMeshHub, type MeshHub } from "../../plugins/kxm/src/hub.ts";
import { writeHubEnvRecord } from "../../plugins/kxm/src/hub-env.ts";

const YAML_ID = "prj_yamlidentity0001";
const CONFIG_ID = "prj_configkey0000001";
const LEGACY = "@acme/legacy";
const CONFIG_TOKEN = "config-project-token-value";
const LEGACY_TOKEN = "legacy-package-token-value";
const ADMIN = "local-admin-token-value";
const OP = "op://Private/kxm/local-project-token";
const CLOUD_OP = "op://Private/kxmd/project-token";

function capture(): CliIo & { read(): { stdout: string; stderr: string } } {
  let stdout = "";
  let stderr = "";
  return {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    read: () => ({ stdout, stderr }),
  };
}

function watchFetch(): { auth: string[]; bodies: string[]; fetchImpl: NonNullable<CliIo["fetchImpl"]>; reset(): void } {
  const auth: string[] = [];
  const bodies: string[] = [];
  return {
    auth,
    bodies,
    reset() {
      auth.length = 0;
      bodies.length = 0;
    },
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      auth.push(headers.get("authorization") ?? "");
      if (init?.body !== undefined) bodies.push(String(init.body));
      return fetch(input, init);
    },
  };
}

async function startHub(tokens: Record<string, string>, authToken = ADMIN): Promise<{ hub: MeshHub; url: string }> {
  const hub = createMeshHub({
    port: 0,
    host: "127.0.0.1",
    authToken,
    projectTokens: tokens,
    shutdownGraceMs: 50,
  });
  const address = await hub.start();
  return { hub, url: address.url };
}

function checkout(url: string): { cwd: string; state: string; home: string; env: NodeJS.ProcessEnv } {
  const cwd = mkdtempSync(join(tmpdir(), "kxm-hub-config-project-"));
  const state = mkdtempSync(join(tmpdir(), "kxm-hub-config-state-"));
  const home = mkdtempSync(join(tmpdir(), "kxm-hub-config-home-"));
  mkdirSync(join(cwd, ".kxm"), { recursive: true });
  writeFileSync(join(cwd, ".kxm", "project.yaml"), `schema: kxm.project.v1\nid: ${YAML_ID}\n`);
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: LEGACY })}\n`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    KXM_STATE_HOME: state,
    KXM_USER_CONFIG_DIR: home,
    KXM_SERVER_URL: url,
    KXM_AGENT_NAME: "reviewer",
  };
  return { cwd, state, home, env };
}

test("local mode uses the config project and a legacy package key via override", async () => {
  const { hub, url } = await startHub({
    [CONFIG_ID]: CONFIG_TOKEN,
    [LEGACY]: LEGACY_TOKEN,
    [YAML_ID]: "yaml-project-token-value",
  });
  const { cwd, state, home, env } = checkout(url);
  const watch = watchFetch();
  try {
    writeHubEnvRecord({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-28T00:00:00.000Z",
      authToken: ADMIN,
      projectTokens: { [LEGACY]: LEGACY_TOKEN },
    }, env);

    const missing = capture();
    const missingCode = await runCli(["peer", "--json", "list"], env, { ...missing, fetchImpl: watch.fetchImpl }, cwd);
    assert.equal(missingCode, 2, missing.read().stderr);
    const refusal = JSON.parse(missing.read().stderr) as { error?: string; project?: string; projectSource?: string; nextAction?: string; detail?: string };
    assert.equal(refusal.error, "project_token_missing");
    assert.equal(refusal.project, YAML_ID);
    assert.equal(refusal.projectSource, "project.yaml");
    assert.equal(refusal.nextAction, "configure_hub_project");
    assert.match(refusal.detail ?? "", new RegExp(`no project token for project ${YAML_ID}`));
    assert.match(refusal.detail ?? "", /hub\.local\.project/);
    assert.match(refusal.detail ?? "", /never the token/);
    assert.equal(watch.auth.length, 0);

    const legacy = capture();
    watch.reset();
    assert.equal(await runCli(
      ["peer", "--json", "list"],
      { ...env, KXM_PROJECT: LEGACY },
      { ...legacy, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, legacy.read().stderr);
    assert.equal(watch.auth.includes(`Bearer ${LEGACY_TOKEN}`), true);
    assert.equal(watch.auth.includes(`Bearer ${ADMIN}`), false);
    const legacyBody = watch.bodies.map((body) => JSON.parse(body) as { project?: string }).find((body) => body.project);
    assert.equal(legacyBody?.project, LEGACY);

    writeFileSync(join(cwd, ".kxm", "config.yaml"), [
      "hub:",
      "  mode: local",
      "  local:",
      `    project: ${CONFIG_ID}`,
      "",
    ].join("\n"));
    const bound = capture();
    assert.equal(await runCli(
      ["hub", "--json", "bind", "--token-env", "KXM_LOCAL_PROJECT_TOKEN", "--key-op", OP, url],
      { ...env, KXM_LOCAL_PROJECT_TOKEN: CONFIG_TOKEN },
      { ...bound, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, bound.read().stderr);
    const configText = readFileSync(join(cwd, ".kxm", "config.yaml"), "utf8");
    const bindingText = readFileSync(join(state, "hub-binding.json"), "utf8");
    assert.match(configText, new RegExp(`project: ${CONFIG_ID}`));
    assert.match(configText, /env: KXM_LOCAL_PROJECT_TOKEN/);
    assert.match(configText, new RegExp(OP.replaceAll("/", "\\/")));
    assert.equal(configText.includes(CONFIG_TOKEN), false);
    assert.equal(configText.includes(LEGACY_TOKEN), false);
    assert.equal(bindingText.includes(CONFIG_TOKEN), false);
    assert.equal(JSON.parse(bindingText).tokenEnv, undefined);

    const listed = capture();
    watch.reset();
    assert.equal(await runCli(
      ["peer", "--json", "list"],
      { ...env, KXM_LOCAL_PROJECT_TOKEN: CONFIG_TOKEN },
      { ...listed, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, listed.read().stderr);
    const localPresented = watch.auth.filter((value) => value.length > 0);
    assert.ok(localPresented.length > 0);
    for (const value of localPresented) assert.equal(value, `Bearer ${CONFIG_TOKEN}`);
    const registered = watch.bodies.map((body) => JSON.parse(body) as { project?: string }).find((body) => body.project);
    assert.equal(registered?.project, CONFIG_ID);

    const viewed = capture();
    assert.equal(await runCli(
      ["hub", "--json", "view"],
      { ...env, KXM_LOCAL_PROJECT_TOKEN: CONFIG_TOKEN },
      { ...viewed, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, viewed.read().stderr);
    const view = JSON.parse(viewed.read().stdout) as { identity?: { mode?: string; project?: string; keySource?: string } };
    assert.equal(view.identity?.mode, "local");
    assert.equal(view.identity?.project, CONFIG_ID);
    assert.equal(view.identity?.keySource, "env:KXM_LOCAL_PROJECT_TOKEN");
    assert.equal(`${viewed.read().stdout}${viewed.read().stderr}`.includes(CONFIG_TOKEN), false);
  } finally {
    await hub.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("cloud mode binds a key reference and does not fall back to the local token", async () => {
  const { hub, url } = await startHub({ [CONFIG_ID]: CONFIG_TOKEN }, ADMIN);
  const { cwd, state, home, env } = checkout(url);
  const watch = watchFetch();
  try {
    writeFileSync(join(cwd, ".kxm", "config.yaml"), `hub:\n  local:\n    project: ${CONFIG_ID}\n`);
    writeHubEnvRecord({
      schema: "kxm.hub-env.v1",
      createdAt: "2026-09-28T00:00:00.000Z",
      authToken: ADMIN,
      projectTokens: { [CONFIG_ID]: CONFIG_TOKEN },
    }, env);

    const bound = capture();
    assert.equal(await runCli(
      ["hub", "--json", "bind", "--cloud", "--token-env", "KXMD_HUB_TOKEN", "--key-op", CLOUD_OP, url],
      { ...env, KXM_AUTH_TOKEN: ADMIN, KXMD_HUB_TOKEN: CONFIG_TOKEN },
      { ...bound, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, bound.read().stderr);
    const configText = readFileSync(join(cwd, ".kxm", "config.yaml"), "utf8");
    const bindingText = readFileSync(join(state, "hub-binding.cloud.json"), "utf8");
    assert.match(configText, /mode: cloud/);
    assert.match(configText, /env: KXMD_HUB_TOKEN/);
    assert.match(configText, new RegExp(CLOUD_OP.replaceAll("/", "\\/")));
    assert.equal(configText.includes(CONFIG_TOKEN), false);
    assert.equal(configText.includes(ADMIN), false);
    assert.equal(bindingText.includes(CONFIG_TOKEN), false);
    assert.equal(bindingText.includes(ADMIN), false);
    assert.match(bindingText, /op read op:\/\/Private\/kxmd\/project-token/);

    const viewed = capture();
    watch.reset();
    assert.equal(await runCli(
      ["hub", "--json", "view"],
      { ...env, KXM_AUTH_TOKEN: ADMIN, KXMD_HUB_TOKEN: CONFIG_TOKEN },
      { ...viewed, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, viewed.read().stderr);
    const view = JSON.parse(viewed.read().stdout) as { target?: { scope?: string }; identity?: { mode?: string; project?: string; keySource?: string } };
    assert.equal(view.target?.scope, "remote");
    assert.equal(view.identity?.mode, "cloud");
    assert.equal(view.identity?.project, CONFIG_ID);
    assert.equal(view.identity?.keySource, "env:KXMD_HUB_TOKEN");
    assert.equal(watch.auth.includes(`Bearer ${CONFIG_TOKEN}`), true);
    assert.equal(watch.auth.includes(`Bearer ${ADMIN}`), false);

    const listed = capture();
    watch.reset();
    assert.equal(await runCli(
      ["peer", "--json", "list"],
      { ...env, KXM_AUTH_TOKEN: ADMIN, KXMD_HUB_TOKEN: CONFIG_TOKEN },
      { ...listed, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, listed.read().stderr);
    const cloudPresented = watch.auth.filter((value) => value.length > 0);
    assert.ok(cloudPresented.length > 0);
    for (const value of cloudPresented) assert.equal(value, `Bearer ${CONFIG_TOKEN}`);
    const registered = watch.bodies.map((body) => JSON.parse(body) as { project?: string }).find((body) => body.project);
    assert.equal(registered?.project, CONFIG_ID);

    const unbound = capture();
    assert.equal(await runCli(["hub", "unbind"], { ...env, KXM_AUTH_TOKEN: ADMIN, KXMD_HUB_TOKEN: CONFIG_TOKEN }, unbound, cwd), 0);
    const after = readFileSync(join(cwd, ".kxm", "config.yaml"), "utf8");
    assert.equal(after.includes("mode:"), false);
    assert.match(after, /KXMD_HUB_TOKEN/);

    const localView = capture();
    assert.equal(await runCli(
      ["hub", "--json", "view"],
      { ...env, KXMD_HUB_TOKEN: CONFIG_TOKEN },
      { ...localView, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, localView.read().stderr);
    const localIdentity = JSON.parse(localView.read().stdout) as { identity?: { mode?: string; keySource?: string } };
    assert.equal(localIdentity.identity?.mode, "local");
    assert.equal(localIdentity.identity?.keySource, "hub-env");

    const local = capture();
    watch.reset();
    assert.equal(await runCli(
      ["peer", "--json", "list"],
      { ...env, KXMD_HUB_TOKEN: CONFIG_TOKEN },
      { ...local, fetchImpl: watch.fetchImpl },
      cwd,
    ), 0, local.read().stderr);
    assert.equal(watch.auth.includes(`Bearer ${CONFIG_TOKEN}`), true);
    assert.equal(watch.auth.includes(`Bearer ${ADMIN}`), false);
  } finally {
    await hub.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
