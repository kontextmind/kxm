import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { KxmHubConfigError, loadKxmConfig } from "../../plugins/kxm/src/config.ts";
import {
  describeHubConnection,
  resolveConfiguredHubProjectTokens,
  resolveKeyReference,
  resolveProjectIdentity,
  selectHubProjectTokenMap,
} from "../../plugins/kxm/src/hub-identity.ts";
import { defaultProjectName } from "../../plugins/kxm/src/project-name.ts";

const OP = "op://Private/kxm/local-project-token";
const SECRET = "resolved-token-value";

function fixture(): { dir: string; home: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "kxm-hub-identity-"));
  const home = mkdtempSync(join(tmpdir(), "kxm-hub-identity-home-"));
  mkdirSync(join(dir, ".kxm"), { recursive: true });
  return { dir, home, env: { KXM_USER_CONFIG_DIR: home } };
}

function cleanup(paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

test("project id resolution order is flag, env, config, project.yaml, package, directory", () => {
  const { dir, home, env } = fixture();
  try {
    assert.deepEqual(resolveProjectIdentity(dir, env), {
      project: basename(dir),
      source: "directory",
      sourceLabel: "directory name",
    });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/legacy" }));
    assert.equal(resolveProjectIdentity(dir, env).source, "package.json");
    assert.equal(defaultProjectName(dir, env), "@acme/legacy");

    writeFileSync(join(dir, ".kxm", "project.yaml"), "schema: kxm.project.v1\nid: prj_yamlidentity0001\n");
    assert.deepEqual(resolveProjectIdentity(dir, env), {
      project: "prj_yamlidentity0001",
      source: "project.yaml",
      sourceLabel: ".kxm/project.yaml id",
    });

    writeFileSync(join(dir, ".kxm", "config.yaml"), [
      "hub:",
      "  mode: local",
      "  local:",
      "    project: prj_configidentity01",
      "  cloud:",
      "    project: prj_cloudidentity001",
      "",
    ].join("\n"));
    assert.deepEqual(resolveProjectIdentity(dir, env), {
      project: "prj_configidentity01",
      source: "config",
      sourceLabel: ".kxm/config.yaml hub.local.project",
    });
    writeFileSync(join(dir, ".kxm", "config.yaml"), [
      "hub:",
      "  mode: cloud",
      "  local:",
      "    project: prj_configidentity01",
      "  cloud:",
      "    project: prj_cloudidentity001",
      "",
    ].join("\n"));
    assert.equal(resolveProjectIdentity(dir, env).project, "prj_cloudidentity001");
    assert.equal(resolveProjectIdentity(dir, env).sourceLabel, ".kxm/config.yaml hub.cloud.project");

    assert.equal(resolveProjectIdentity(dir, { ...env, KXM_PROJECT: "env-id" }).source, "env");
    assert.equal(resolveProjectIdentity(dir, env, "flag-id").source, "flag");
    assert.equal(defaultProjectName(dir, { ...env, KXM_PROJECT: "env-id" }, "flag-id"), "flag-id");
  } finally {
    cleanup([dir, home]);
  }
});

test("hub config rejects a literal token and accepts op and env references", () => {
  const { dir, home } = fixture();
  try {
    const cases = [
      "hub:\n  local:\n    key: literal-token-value\n",
      "hub:\n  local:\n    key:\n      token: literal-token-value\n",
      "hub:\n  cloud:\n    key:\n      op: not-a-reference\n",
      "hub:\n  local:\n    key:\n      env: not a name\n",
      "hub:\n  projects:\n    prj_example:\n      secret: literal-token-value\n",
      "hub:\n  mode: sideways\n",
    ];
    for (const yaml of cases) {
      writeFileSync(join(dir, ".kxm", "config.yaml"), yaml);
      assert.throws(() => loadKxmConfig(dir, { userConfigDir: home }), KxmHubConfigError);
    }
    writeFileSync(join(dir, ".kxm", "config.yaml"), "hub:\n  local:\n    key: literal-token-value\n");
    assert.throws(
      () => loadKxmConfig(dir, { userConfigDir: home }),
      /refusing literal hub token at hub\.local\.key: store an op:\/\/ reference \(key\.op\) or an environment variable name \(key\.env\), never the token/,
    );
    writeFileSync(join(dir, ".kxm", "config.yaml"), [
      "hub:",
      "  mode: local",
      "  local:",
      "    url: http://127.0.0.1:7331",
      "    project: prj_example",
      "    key:",
      `      op: ${OP}`,
      "      env: KXM_LOCAL_PROJECT_TOKEN",
      "  projects:",
      "    prj_example:",
      `      op: ${OP}`,
      "      env: KXM_LOCAL_PROJECT_TOKEN",
      "",
    ].join("\n"));
    const hub = loadKxmConfig(dir, { userConfigDir: home }).hub;
    assert.equal(hub.local?.key?.op, OP);
    assert.equal(hub.local?.key?.env, "KXM_LOCAL_PROJECT_TOKEN");
    assert.equal(hub.projects?.prj_example?.op, OP);
    assert.equal(JSON.stringify(hub).includes(SECRET), false);
  } finally {
    cleanup([dir, home]);
  }
});

test("op references resolve at use time and a non-empty env var wins", () => {
  const { dir, home, env } = fixture();
  try {
    let reads = 0;
    const opRead = (reference: string): string => {
      reads += 1;
      assert.equal(reference, OP);
      return `${SECRET}\n`;
    };
    const fromEnv = resolveKeyReference(
      { op: OP, env: "KXM_LOCAL_PROJECT_TOKEN" },
      { ...env, KXM_LOCAL_PROJECT_TOKEN: SECRET },
      () => {
        throw new Error("op read must not run when the env var is set");
      },
    );
    assert.deepEqual(fromEnv, { value: SECRET, source: "env:KXM_LOCAL_PROJECT_TOKEN" });

    const fromOp = resolveKeyReference({ op: OP, env: "KXM_LOCAL_PROJECT_TOKEN" }, env, opRead);
    assert.deepEqual(fromOp, { value: SECRET, source: `op:${OP}` });
    assert.equal(reads, 1);

    writeFileSync(join(dir, ".kxm", "config.yaml"), [
      "hub:",
      "  projects:",
      "    prj_example:",
      `      op: ${OP}`,
      "    \"@acme/legacy\":",
      "      env: KXM_LEGACY_PROJECT_TOKEN",
      "",
    ].join("\n"));
    const before = readFileSync(join(dir, ".kxm", "config.yaml"), "utf8");
    const tokens = resolveConfiguredHubProjectTokens(dir, { ...env, KXM_LEGACY_PROJECT_TOKEN: "legacy-token-value" }, opRead);
    assert.deepEqual(tokens, { prj_example: SECRET, "@acme/legacy": "legacy-token-value" });
    assert.equal(readFileSync(join(dir, ".kxm", "config.yaml"), "utf8"), before);
    assert.equal(before.includes(SECRET), false);
    assert.equal(before.includes("legacy-token-value"), false);
  } finally {
    cleanup([dir, home]);
  }
});

test("hub project token map prefers an explicit env map, then config, then the file", () => {
  assert.deepEqual(selectHubProjectTokenMap({
    explicit: { prj_env: "from-env" },
    configured: { prj_config: "from-config" },
    file: { prj_file: "from-file" },
  }), { tokens: { prj_env: "from-env" }, source: "env" });
  assert.equal(selectHubProjectTokenMap({
    explicit: undefined,
    configured: { prj_config: "from-config" },
    file: { prj_file: "from-file" },
  }).source, "config");
  assert.equal(selectHubProjectTokenMap({
    explicit: undefined,
    configured: undefined,
    file: { prj_file: "from-file" },
  }).source, "file");
  assert.equal(selectHubProjectTokenMap({
    explicit: undefined,
    configured: {},
    file: undefined,
  }).source, "none");
});

test("describeHubConnection names the key source and treats cloud mode as remote", () => {
  const { dir, home, env } = fixture();
  try {
    writeFileSync(join(dir, ".kxm", "project.yaml"), "id: prj_yamlidentity0001\n");
    writeFileSync(join(dir, ".kxm", "config.yaml"), [
      "hub:",
      "  mode: cloud",
      "  cloud:",
      "    url: http://127.0.0.1:17331",
      "    project: prj_cloudidentity001",
      "    key:",
      `      op: ${OP}`,
      "      env: KXMD_HUB_TOKEN",
      "",
    ].join("\n"));
    const cloud = describeHubConnection(dir, { ...env, KXMD_HUB_TOKEN: SECRET });
    assert.equal(cloud.mode, "cloud");
    assert.equal(cloud.scope, "remote");
    assert.equal(cloud.url, "http://127.0.0.1:17331");
    assert.equal(cloud.project, "prj_cloudidentity001");
    assert.equal(cloud.keySource, "env:KXMD_HUB_TOKEN");
    assert.equal(JSON.stringify(cloud).includes(SECRET), false);

    const override = describeHubConnection(dir, {
      ...env,
      KXM_SERVER_URL: "http://127.0.0.1:7331",
      KXMD_HUB_TOKEN: SECRET,
    });
    assert.equal(override.url, "http://127.0.0.1:7331");
    assert.equal(override.scope, "loopback");
    assert.equal(override.urlSource, "env");
  } finally {
    cleanup([dir, home]);
  }
});
