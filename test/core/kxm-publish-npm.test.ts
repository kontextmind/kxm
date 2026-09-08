import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bufferSha256,
  fileSha256,
  findPublishedAsset,
  interpretPublishedReleaseLookup,
  main,
  normalizeSha256Digest,
  runKxmNpmPublish,
  // @ts-expect-error The helper is a workflow script with no declaration artifact.
} from "../../scripts/kxm-publish-npm.mjs";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const ASSET = "kxm-0.6.0.tgz";

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === code);
}

test("normalizeSha256Digest extracts valid sha256 or undefined", () => {
  assert.equal(normalizeSha256Digest(`sha256:${HEX_A}`), HEX_A);
  assert.equal(normalizeSha256Digest(`SHA256:${HEX_A.toUpperCase()}`), HEX_A);
  assert.equal(normalizeSha256Digest("invalid"), undefined);
  assert.equal(normalizeSha256Digest(null as unknown as string), undefined);
});

test("interpretPublishedReleaseLookup fails closed on network, auth, and 404", () => {
  assert.equal(interpretPublishedReleaseLookup({ error: "network" }).code, "lookup_network");
  assert.equal(interpretPublishedReleaseLookup({ error: "auth" }).code, "lookup_auth");
  assert.equal(interpretPublishedReleaseLookup({ status: 401 }).code, "lookup_auth");
  assert.equal(interpretPublishedReleaseLookup({ status: 403 }).code, "lookup_auth");
  assert.equal(interpretPublishedReleaseLookup({ status: 404 }).code, "release_not_found");
  assert.equal(interpretPublishedReleaseLookup({ status: 500 }).code, "lookup_http");
  assert.equal(interpretPublishedReleaseLookup({ status: 200, body: "not an object" }).code, "lookup_http");
});

test("interpretPublishedReleaseLookup rejects draft releases", () => {
  const result = interpretPublishedReleaseLookup({
    status: 200,
    body: { id: 123, draft: true, assets: [] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "release_still_draft");
});

test("interpretPublishedReleaseLookup accepts published releases", () => {
  const result = interpretPublishedReleaseLookup({
    status: 200,
    body: { id: 123, draft: false, assets: [{ id: 456, name: ASSET }] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 123);
  assert.equal(result.draft, false);
  assert.equal(result.assets?.length, 1);
});

test("findPublishedAsset finds asset by name or fails closed", () => {
  const asset = { id: 10, name: ASSET, digest: `sha256:${HEX_A}` };
  assert.deepEqual(findPublishedAsset([asset], ASSET), { ok: true, asset });
  assert.equal(findPublishedAsset([], ASSET).code, "asset_not_found");
  assert.equal(findPublishedAsset([{ id: "not-a-number", name: ASSET }], ASSET).code, "asset_not_found");
  assert.equal(findPublishedAsset(null as unknown as unknown[], ASSET).code, "asset_not_found");
});

test("runKxmNpmPublish requires all mandatory inputs", async () => {
  await assert.rejects(
    () => runKxmNpmPublish({ token: "", npmToken: "npm_test", tag: "v0.6.0", repo: "org/repo", assetName: ASSET }),
    (err) => hasCode(err, "lookup_auth"),
  );
  await assert.rejects(
    () => runKxmNpmPublish({ token: "gh_test", npmToken: "", tag: "v0.6.0", repo: "org/repo", assetName: ASSET }),
    (err) => hasCode(err, "npm_auth_missing"),
  );
  await assert.rejects(
    () => runKxmNpmPublish({ token: "gh_test", npmToken: "npm_test", tag: "", repo: "org/repo", assetName: ASSET }),
    (err) => hasCode(err, "input_missing"),
  );
  await assert.rejects(
    () => runKxmNpmPublish({ token: "gh_test", npmToken: "npm_test", tag: "v0.6.0", repo: "", assetName: ASSET }),
    (err) => hasCode(err, "input_missing"),
  );
  await assert.rejects(
    () => runKxmNpmPublish({ token: "gh_test", npmToken: "npm_test", tag: "v0.6.0", repo: "org/repo", assetName: "" }),
    (err) => hasCode(err, "input_missing"),
  );
});

test("runKxmNpmPublish fails closed when release is draft", async () => {
  const mockApi = {
    getReleaseByTag: async () => ({
      status: 200,
      body: { id: 1, draft: true, assets: [] },
    }),
    downloadReleaseAsset: async () => ({ status: 200, buffer: Buffer.from("test") }),
  };
  await assert.rejects(
    () =>
      runKxmNpmPublish({
        token: "gh_test",
        npmToken: "npm_test",
        tag: "v0.6.0",
        repo: "org/repo",
        assetName: ASSET,
        api: mockApi,
      }),
    (err) => hasCode(err, "release_still_draft"),
  );
});

test("runKxmNpmPublish fails closed when asset not on release", async () => {
  const mockApi = {
    getReleaseByTag: async () => ({
      status: 200,
      body: { id: 1, draft: false, assets: [{ id: 99, name: "other.tgz" }] },
    }),
    downloadReleaseAsset: async () => ({ status: 200, buffer: Buffer.from("test") }),
  };
  await assert.rejects(
    () =>
      runKxmNpmPublish({
        token: "gh_test",
        npmToken: "npm_test",
        tag: "v0.6.0",
        repo: "org/repo",
        assetName: ASSET,
        api: mockApi,
      }),
    (err) => hasCode(err, "asset_not_found"),
  );
});

test("runKxmNpmPublish downloads and verifies asset then calls publish", async () => {
  const content = Buffer.from("test package tarball bytes");
  const digest = bufferSha256(content);
  const tempDir = mkdtempSync(join(tmpdir(), "kxm-publish-test-"));
  let publishedPath: string | undefined;

  try {
    const mockApi = {
      getReleaseByTag: async () => ({
        status: 200,
        body: {
          id: 1,
          draft: false,
          assets: [{ id: 42, name: ASSET, digest: `sha256:${digest}` }],
        },
      }),
      downloadReleaseAsset: async (id: number) => {
        assert.equal(id, 42);
        return { status: 200, buffer: content };
      },
    };

    const mockPublish = async ({ assetPath, npmToken }: { assetPath: string; npmToken: string }) => {
      assert.equal(npmToken, "npm_secret_key");
      publishedPath = assetPath;
      return { stdout: "+ @kontextmind/kxm@0.6.0" };
    };

    const result = await runKxmNpmPublish({
      token: "gh_test",
      npmToken: "npm_secret_key",
      tag: "v0.6.0",
      repo: "kontextmind/kxm",
      assetName: ASSET,
      tempDir,
      api: mockApi,
      publishFn: mockPublish,
    });

    assert.equal(result.ok, true);
    assert.equal(result.published, true);
    assert.equal(result.tag, "v0.6.0");
    assert.equal(result.digest, `sha256:${digest}`);
    assert.equal(publishedPath, join(tempDir, ASSET));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runKxmNpmPublish detects SHA-256 digest mismatch", async () => {
  const content = Buffer.from("different bytes");
  const tempDir = mkdtempSync(join(tmpdir(), "kxm-publish-mismatch-"));

  try {
    const mockApi = {
      getReleaseByTag: async () => ({
        status: 200,
        body: {
          id: 1,
          draft: false,
          assets: [{ id: 42, name: ASSET, digest: `sha256:${HEX_A}` }],
        },
      }),
      downloadReleaseAsset: async () => ({ status: 200, buffer: content }),
    };

    await assert.rejects(
      () =>
        runKxmNpmPublish({
          token: "gh_test",
          npmToken: "npm_secret_key",
          tag: "v0.6.0",
          repo: "kontextmind/kxm",
          assetName: ASSET,
          tempDir,
          api: mockApi,
        }),
      (err) => hasCode(err, "digest_mismatch"),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runKxmNpmPublish uses existing assetPath if valid", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "kxm-publish-existing-"));
  const existingFile = join(tempDir, ASSET);
  const content = Buffer.from("existing tarball");
  writeFileSync(existingFile, content);
  const digest = fileSha256(existingFile);

  try {
    const mockApi = {
      getReleaseByTag: async () => ({
        status: 200,
        body: {
          id: 1,
          draft: false,
          assets: [{ id: 42, name: ASSET, digest: `sha256:${digest}` }],
        },
      }),
      downloadReleaseAsset: async () => {
        throw new Error("should not download when assetPath exists");
      },
    };

    let publishCalled = false;
    const result = await runKxmNpmPublish({
      token: "gh_test",
      npmToken: "npm_test",
      tag: "v0.6.0",
      repo: "kontextmind/kxm",
      assetName: ASSET,
      assetPath: existingFile,
      api: mockApi,
      publishFn: async () => {
        publishCalled = true;
        return { stdout: "ok" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(publishCalled, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main() fails closed with exit code 1 when required env vars are missing", async () => {
  let stderr = "";
  const errStream = {
    write(chunk: string) {
      stderr += chunk;
      return true;
    },
  };
  const outStream = {
    write() {
      return true;
    },
  };

  const code1 = await main({}, outStream as unknown as NodeJS.WriteStream, errStream as unknown as NodeJS.WriteStream);
  assert.equal(code1, 1);
  assert.match(stderr, /npm publish requires/);

  stderr = "";
  const code2 = await main(
    { GITHUB_REPOSITORY: "org/repo", GITHUB_REF_NAME: "v0.6.0", KXM_ASSET: ASSET },
    outStream as unknown as NodeJS.WriteStream,
    errStream as unknown as NodeJS.WriteStream,
  );
  assert.equal(code2, 1);
  assert.match(stderr, /lookup_auth/);

  stderr = "";
  const code3 = await main(
    { GITHUB_REPOSITORY: "org/repo", GITHUB_REF_NAME: "v0.6.0", KXM_ASSET: ASSET, GITHUB_TOKEN: "token" },
    outStream as unknown as NodeJS.WriteStream,
    errStream as unknown as NodeJS.WriteStream,
  );
  assert.equal(code3, 1);
  assert.match(stderr, /npm_auth_missing/);
});
