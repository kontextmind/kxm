import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { kxmReleaseAssetName } from "../plugins/kxm/src/kxm-update.ts";
// @ts-expect-error The helper is a workflow script with no declaration artifact.
import { createGithubReleaseApi, fileSha256, interpretReleaseLookup, main, planDraftAssetAction, runKxmReleasePublish, verifyListedAssetDigest } from "../scripts/kxm-release-github.mjs";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const ASSET = kxmReleaseAssetName("0.5.2");

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code);
}

function mockApi(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Array<[string, ...unknown[]]> = [];
  const wrap = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected ${name}`);
    return handler(...args);
  };
  return {
    calls,
    getReleaseByTag: wrap("getReleaseByTag"),
    createDraftRelease: wrap("createDraftRelease"),
    uploadReleaseAsset: wrap("uploadReleaseAsset"),
    listReleaseAssets: wrap("listReleaseAssets"),
  };
}

test("lookup only treats HTTP 404 as missing; auth, 5xx, and network fail closed", () => {
  assert.deepEqual(interpretReleaseLookup({ status: 404 }), { ok: true, state: "missing" });
  assert.equal(interpretReleaseLookup({ error: "network" }).code, "lookup_network");
  assert.equal(interpretReleaseLookup({ status: 401 }).code, "lookup_auth");
  assert.equal(interpretReleaseLookup({ status: 403 }).code, "lookup_auth");
  assert.equal(interpretReleaseLookup({ status: 500 }).code, "lookup_http");
  assert.equal(interpretReleaseLookup({ status: 200, body: { id: 1, draft: false } }).code, "published_release");
  assert.equal(interpretReleaseLookup({ status: 200, body: "nope" }).code, "lookup_http");
  const draft = interpretReleaseLookup({
    status: 200,
    body: { id: 9, draft: true, assets: [{ name: ASSET, digest: `sha256:${HEX_A}` }] },
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.state, "draft");
});

test("draft plan uploads when absent, skips matching digest, and never replaces a mismatch", () => {
  const missing = planDraftAssetAction({ ok: true, state: "missing" }, { assetName: ASSET, localSha256: HEX_A });
  assert.equal(missing.action, "create_and_upload");

  const upload = planDraftAssetAction({
    ok: true,
    state: "draft",
    id: 3,
    assets: [{ name: "other.tgz", digest: `sha256:${HEX_A}` }],
  }, { assetName: ASSET, localSha256: HEX_A });
  assert.equal(upload.action, "upload");
  assert.equal(upload.releaseId, 3);

  const skip = planDraftAssetAction({
    ok: true,
    state: "draft",
    id: 3,
    assets: [{ id: 44, name: ASSET, digest: `sha256:${HEX_A}` }],
  }, { assetName: ASSET, localSha256: HEX_A });
  assert.equal(skip.action, "skip_idempotent");
  assert.equal(skip.assetId, 44);

  const mismatch = planDraftAssetAction({
    ok: true,
    state: "draft",
    id: 3,
    assets: [{ id: 44, name: ASSET, digest: `sha256:${HEX_B}` }],
  }, { assetName: ASSET, localSha256: HEX_A });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "existing_digest_mismatch");

  const noDigest = planDraftAssetAction({
    ok: true,
    state: "draft",
    id: 3,
    assets: [{ id: 44, name: ASSET }],
  }, { assetName: ASSET, localSha256: HEX_A });
  assert.equal(noDigest.code, "existing_digest_missing");
});

test("listed GitHub asset digest is the proof; missing or mismatch fail", () => {
  const ok = verifyListedAssetDigest(
    [{ name: ASSET, id: 8, digest: `sha256:${HEX_A}` }],
    { assetName: ASSET, localSha256: HEX_A },
  );
  assert.equal(ok.ok, true);
  assert.equal(verifyListedAssetDigest([], { assetName: ASSET, localSha256: HEX_A }).code, "uploaded_digest_missing");
  assert.equal(verifyListedAssetDigest(
    [{ name: ASSET, id: 8, digest: `sha256:${HEX_B}` }],
    { assetName: ASSET, localSha256: HEX_A },
  ).code, "uploaded_digest_mismatch");
});

test("publish fails closed on missing token, published release, and lookup errors without mutation", async () => {
  const unused = mockApi({});
  await assert.rejects(
    () => runKxmReleasePublish({
      token: "",
      tag: "v0.5.2",
      assetName: ASSET,
      assetPath: "x",
      localSha256: HEX_A,
      api: unused,
    }),
    (error: unknown) => hasCode(error, "lookup_auth"),
  );
  assert.equal(unused.calls.length, 0);

  const published = mockApi({
    getReleaseByTag: () => ({ status: 200, body: { id: 1, draft: false, assets: [] } }),
  });
  await assert.rejects(
    () => runKxmReleasePublish({
      token: "tok",
      tag: "v0.5.2",
      assetName: ASSET,
      assetPath: "x",
      localSha256: HEX_A,
      api: published,
    }),
    (error: unknown) => hasCode(error, "published_release"),
  );
  assert.deepEqual(published.calls.map((call) => call[0]), ["getReleaseByTag"]);

  const serverError = mockApi({
    getReleaseByTag: () => ({ status: 503, body: { message: "unavailable" } }),
  });
  await assert.rejects(
    () => runKxmReleasePublish({
      token: "tok",
      tag: "v0.5.2",
      assetName: ASSET,
      assetPath: "x",
      localSha256: HEX_A,
      api: serverError,
    }),
    (error: unknown) => hasCode(error, "lookup_http"),
  );
  assert.deepEqual(serverError.calls.map((call) => call[0]), ["getReleaseByTag"]);

  const net = mockApi({
    getReleaseByTag: () => {
      throw new Error("ECONNRESET");
    },
  });
  await assert.rejects(
    () => runKxmReleasePublish({
      token: "tok",
      tag: "v0.5.2",
      assetName: ASSET,
      assetPath: "x",
      localSha256: HEX_A,
      api: net,
    }),
    (error: unknown) => hasCode(error, "lookup_network"),
  );
});

test("matching draft digest is idempotent and does not upload or create", async () => {
  const api = mockApi({
    getReleaseByTag: () => ({
      status: 200,
      body: { id: 11, draft: true, assets: [{ id: 99, name: ASSET, digest: `sha256:${HEX_A}` }] },
    }),
  });
  const result = await runKxmReleasePublish({
    token: "tok",
    tag: "v0.5.2",
    assetName: ASSET,
    assetPath: "x",
    localSha256: HEX_A,
    api,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.assetId, 99);
  assert.deepEqual(api.calls.map((call) => call[0]), ["getReleaseByTag"]);
});

test("create-and-upload proves the listed GitHub digest, not the upload response", async () => {
  const api = mockApi({
    getReleaseByTag: () => ({ status: 404 }),
    createDraftRelease: () => ({ status: 201, body: { id: 70, draft: true } }),
    uploadReleaseAsset: () => ({ status: 201, body: { id: 1, name: ASSET, digest: `sha256:${HEX_B}` } }),
    listReleaseAssets: () => ({
      status: 200,
      body: [{ id: 81, name: ASSET, digest: `sha256:${HEX_A}` }],
    }),
  });
  const result = await runKxmReleasePublish({
    token: "tok",
    tag: "v0.5.2",
    assetName: ASSET,
    assetPath: "/tmp/kxm-0.5.2.tgz",
    localSha256: HEX_A,
    api,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.releaseId, 70);
  assert.equal(result.assetId, 81);
  assert.equal(result.digest, `sha256:${HEX_A}`);
  assert.deepEqual(api.calls.map((call) => call[0]), [
    "getReleaseByTag",
    "createDraftRelease",
    "uploadReleaseAsset",
    "listReleaseAssets",
  ]);
});

test("upload is refused when the listed GitHub digest is missing or different", async () => {
  const mismatch = mockApi({
    getReleaseByTag: () => ({ status: 200, body: { id: 4, draft: true, assets: [] } }),
    uploadReleaseAsset: () => ({ status: 201, body: { digest: `sha256:${HEX_A}` } }),
    listReleaseAssets: () => ({
      status: 200,
      body: [{ id: 1, name: ASSET, digest: `sha256:${HEX_B}` }],
    }),
  });
  await assert.rejects(
    () => runKxmReleasePublish({
      token: "tok",
      tag: "v0.5.2",
      assetName: ASSET,
      assetPath: "x",
      localSha256: HEX_A,
      api: mismatch,
    }),
    (error: unknown) => hasCode(error, "uploaded_digest_mismatch"),
  );

  const missing = mockApi({
    getReleaseByTag: () => ({ status: 200, body: { id: 4, draft: true, assets: [] } }),
    uploadReleaseAsset: () => ({ status: 201, body: { digest: `sha256:${HEX_A}` } }),
    listReleaseAssets: () => ({ status: 200, body: [{ id: 1, name: ASSET }] }),
  });
  await assert.rejects(
    () => runKxmReleasePublish({
      token: "tok",
      tag: "v0.5.2",
      assetName: ASSET,
      assetPath: "x",
      localSha256: HEX_A,
      api: missing,
    }),
    (error: unknown) => hasCode(error, "uploaded_digest_missing"),
  );
});

test("GitHub client sends auth, creates drafts only, and uploads to the uploads host", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (String(url).includes("/releases/tags/")) {
      return new Response("{\"message\":\"Not Found\"}", { status: 404 });
    }
    if (String(url) === "https://api.github.com/repos/kontextmind/kxm/releases" && init.method === "POST") {
      return new Response("{\"id\":5,\"draft\":true}", { status: 201 });
    }
    if (String(url).startsWith("https://uploads.github.com/") && init.method === "POST") {
      return new Response("{\"id\":9}", { status: 201 });
    }
    if (String(url).includes("/assets?per_page=100")) {
      return new Response(JSON.stringify([{ id: 9, name: ASSET, digest: `sha256:${HEX_A}` }]), { status: 200 });
    }
    return new Response("", { status: 500 });
  };
  const root = mkdtempSync(join(tmpdir(), "kxm-release-api-"));
  try {
    const path = join(root, ASSET);
    writeFileSync(path, "tarball");
    const api = createGithubReleaseApi({
      token: "secret-token",
      repo: "kontextmind/kxm",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await runKxmReleasePublish({
      token: "secret-token",
      tag: "v0.5.2",
      assetName: ASSET,
      assetPath: path,
      localSha256: HEX_A,
      api,
    });
    assert.equal(result.releaseId, 5);
    assert.match(String(requests[0]?.init.headers && (requests[0].init.headers as Record<string, string>).Authorization), /Bearer secret-token/);
    const created = requests.find((row) => row.init.method === "POST" && row.url.endsWith("/releases"));
    assert.equal(JSON.parse(String(created?.init.body)).draft, true);
    assert.ok(requests.some((row) => row.url.startsWith("https://uploads.github.com/") && row.url.includes(ASSET)));
    assert.equal(JSON.stringify(requests).includes("--clobber"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI refuses to run without env and never prints the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "kxm-release-cli-"));
  try {
    const path = join(root, ASSET);
    writeFileSync(path, "packed");
    const digest = fileSha256(path);
    let out = "";
    let err = "";
    const stdout = { write(chunk: string) { out += chunk; return true; } };
    const stderr = { write(chunk: string) { err += chunk; return true; } };
    const missing = await main({ GITHUB_TOKEN: "secret-token" }, stdout, stderr);
    assert.equal(missing, 1);
    assert.match(err, /requires repository/);
    assert.equal(out.includes("secret-token"), false);
    assert.equal(err.includes("secret-token"), false);

    out = "";
    err = "";
    const mismatch = await main({
      GITHUB_TOKEN: "secret-token",
      GITHUB_REPOSITORY: "kontextmind/kxm",
      GITHUB_REF_NAME: "v0.5.2",
      KXM_ASSET: ASSET,
      KXM_ASSET_PATH: path,
      KXM_ASSET_SHA256: HEX_B,
    }, stdout, stderr);
    assert.equal(mismatch, 1);
    assert.match(err, /does not match/);
    assert.equal(digest.length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
