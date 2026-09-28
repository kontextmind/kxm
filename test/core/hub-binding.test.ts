import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CloudTokenError,
  HubBindingError,
  effectiveHubBindingScope,
  hubBindingCloudFile,
  hubBindingFile,
  loadHubBinding,
  probeHubHealth,
  readHubBinding,
  readLegacyV1HubBinding,
  removeHubBinding,
  resolveCloudHubToken,
  validateHubUrl,
  writeHubBinding,
} from "../../plugins/kxm/src/hub-binding.ts";

function stateEnv(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "kxm-hub-binding-"));
  return { env: { KXM_STATE_HOME: root }, root };
}

test("hub binding validates, persists, and probes health", async () => {
  const { env, root } = stateEnv();
  try {
    assert.equal(validateHubUrl("http://127.0.0.1:7331/"), "http://127.0.0.1:7331");
    assert.throws(() => validateHubUrl("ftp://x"), HubBindingError);
    assert.throws(() => validateHubUrl("http://user:pass@127.0.0.1:7331"), HubBindingError);
    assert.throws(() => validateHubUrl("http://127.0.0.1:7331/?q=1"), HubBindingError);
    assert.throws(() => validateHubUrl("http://127.0.0.1:7331/?"), HubBindingError);
    assert.throws(() => validateHubUrl("http://127.0.0.1:7331/#"), HubBindingError);
    const record = { schema: "kxm.hub-binding.v1" as const, url: "http://127.0.0.1:7331", boundAt: "2026-09-04T12:00:00.000Z" };
    assert.equal(writeHubBinding(record, env), hubBindingFile(env));
    assert.deepEqual(readHubBinding(env), record);
    writeHubBinding({ ...record, url: "http://127.0.0.1:7331/" }, env);
    assert.deepEqual(readHubBinding(env), record);
    writeFileSync(join(root, "hub-binding.json"), JSON.stringify({ ...record, extra: true }));
    const newer = loadHubBinding(env);
    assert.equal(newer.record, undefined);
    assert.match(newer.warning ?? "", /falling back to the local hub/);
    writeFileSync(join(root, "hub-binding.json"), JSON.stringify({ ...record, boundAt: "garbage" }));
    assert.throws(() => readHubBinding(env), HubBindingError);
    const cloud = {
      schema: "kxm.hub-binding.v1" as const,
      url: "http://127.0.0.1:17331",
      boundAt: "2026-09-04T12:00:00.000Z",
      cloud: true as const,
      tokenEnv: "KXMD_HUB_TOKEN",
    };
    writeHubBinding(cloud, env);
    assert.deepEqual(readHubBinding(env), cloud);
    assert.equal(existsSync(hubBindingFile(env)), false);
    assert.equal(readLegacyV1HubBinding(env), undefined);
    assert.equal(existsSync(hubBindingCloudFile(env)), true);
    assert.equal(effectiveHubBindingScope("http://127.0.0.1:17331", env), "remote");
    assert.equal(effectiveHubBindingScope("http://127.0.0.1:7331", env), "loopback");
    assert.equal(resolveCloudHubToken(cloud, { KXMD_HUB_TOKEN: " remote-token " }), "remote-token");
    assert.throws(() => resolveCloudHubToken(cloud, {}), (error: unknown) => {
      assert.ok(error instanceof CloudTokenError);
      assert.equal(error.code, "cloud_token_missing");
      assert.match(error.message, /local hub-env token was not used/);
      return true;
    });
    rmSync(hubBindingCloudFile(env), { force: true });
    writeFileSync(join(root, "hub-binding.json"), JSON.stringify({ ...cloud, authToken: "must-not-store" }));
    const poisoned = loadHubBinding(env);
    assert.equal(poisoned.record, undefined);
    assert.equal(JSON.stringify(poisoned).includes("must-not-store"), false);
    assert.match(poisoned.warning ?? "", /falling back to the local hub/);
    assert.equal(removeHubBinding(env), true);
    assert.equal(readHubBinding(env), undefined);
    const on = await probeHubHealth("http://127.0.0.1:7331", async () => new Response(JSON.stringify({ ok: true, agents: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    assert.equal(on.health, "on");
    assert.equal(on.kind, "hub");
    const bare = await probeHubHealth("http://127.0.0.1:7331", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    assert.equal(bare.health, "unknown");
    assert.equal(bare.kind, "not_hub");
    const off = await probeHubHealth("http://127.0.0.1:7331", async () => { throw new TypeError("fetch failed"); });
    assert.equal(off.health, "off");
    const unknown = await probeHubHealth("http://127.0.0.1:7331", async () => new Response("nope", { status: 500 }));
    assert.equal(unknown.health, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
