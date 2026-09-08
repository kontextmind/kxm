import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HubBindingError,
  hubBindingFile,
  probeHubHealth,
  readHubBinding,
  removeHubBinding,
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
    assert.throws(() => readHubBinding(env), HubBindingError);
    writeFileSync(join(root, "hub-binding.json"), JSON.stringify({ ...record, boundAt: "garbage" }));
    assert.throws(() => readHubBinding(env), HubBindingError);
    assert.equal(removeHubBinding(env), true);
    assert.equal(readHubBinding(env), undefined);
    const on = await probeHubHealth("http://127.0.0.1:7331", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    assert.equal(on.health, "on");
    const off = await probeHubHealth("http://127.0.0.1:7331", async () => { throw new TypeError("fetch failed"); });
    assert.equal(off.health, "off");
    const unknown = await probeHubHealth("http://127.0.0.1:7331", async () => new Response("nope", { status: 500 }));
    assert.equal(unknown.health, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
