#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SHA256_DIGEST = /^sha256:([0-9a-fA-F]{64})$/i;

export class KxmReleaseGithubError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "KxmReleaseGithubError";
    this.code = code;
    for (const [key, value] of Object.entries(extra)) {
      if (key === "message" || key === "code") continue;
      this[key] = value;
    }
  }
}

export function normalizeSha256Digest(value) {
  if (typeof value !== "string") return undefined;
  const match = SHA256_DIGEST.exec(value.trim());
  return match ? match[1].toLowerCase() : undefined;
}

export function interpretReleaseLookup(result) {
  if (result?.error === "network") {
    return { ok: false, code: "lookup_network", message: "release lookup network failure" };
  }
  if (result?.error === "auth") {
    return { ok: false, code: "lookup_auth", message: "release lookup auth failure" };
  }
  const status = result?.status;
  if (status === 404) return { ok: true, state: "missing" };
  if (status === 401 || status === 403) {
    return { ok: false, code: "lookup_auth", status, message: `release lookup auth failure (${status})` };
  }
  if (typeof status !== "number" || status < 200 || status >= 300) {
    return { ok: false, code: "lookup_http", status, message: `release lookup failed (${status ?? "no status"})` };
  }
  const body = result.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "lookup_http", message: "release lookup returned invalid body" };
  }
  const id = body.id;
  if (typeof id !== "number") {
    return { ok: false, code: "lookup_http", message: "release lookup missing id" };
  }
  if (body.draft !== true) {
    return {
      ok: false,
      code: "published_release",
      id,
      message: "published release for tag must not be mutated",
    };
  }
  const assets = Array.isArray(body.assets) ? body.assets : [];
  return { ok: true, state: "draft", id, assets };
}

export function planDraftAssetAction(lookup, { assetName, localSha256 }) {
  if (!lookup?.ok) return lookup;
  if (typeof assetName !== "string" || assetName.length === 0) {
    return { ok: false, code: "asset_name_invalid", message: "asset name is required" };
  }
  const local = typeof localSha256 === "string" ? localSha256.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(local)) {
    return { ok: false, code: "local_digest_invalid", message: "local sha256 is not 64 hex chars" };
  }
  if (lookup.state === "missing") {
    return { ok: true, action: "create_and_upload" };
  }
  if (lookup.state !== "draft" || typeof lookup.id !== "number") {
    return { ok: false, code: "lookup_http", message: "release lookup is not a draft" };
  }
  const existing = lookup.assets.find((item) => item && typeof item === "object" && item.name === assetName);
  if (!existing) {
    return { ok: true, action: "upload", releaseId: lookup.id };
  }
  const hex = normalizeSha256Digest(existing.digest);
  if (!hex) {
    return {
      ok: false,
      code: "existing_digest_missing",
      assetId: existing.id,
      message: "existing asset digest missing",
    };
  }
  if (hex !== local) {
    return {
      ok: false,
      code: "existing_digest_mismatch",
      assetId: existing.id,
      message: "existing asset digest differs from local sha256",
    };
  }
  return {
    ok: true,
    action: "skip_idempotent",
    releaseId: lookup.id,
    assetId: existing.id,
    digest: `sha256:${hex}`,
  };
}

export function verifyListedAssetDigest(assets, { assetName, localSha256 }) {
  const found = Array.isArray(assets)
    ? assets.find((item) => item && typeof item === "object" && item.name === assetName)
    : undefined;
  if (!found) {
    return { ok: false, code: "uploaded_digest_missing", message: "GitHub release asset digest missing" };
  }
  const hex = normalizeSha256Digest(found.digest);
  if (!hex) {
    return {
      ok: false,
      code: "uploaded_digest_missing",
      assetId: found.id,
      message: "GitHub release asset digest missing",
    };
  }
  if (hex !== localSha256.toLowerCase()) {
    return {
      ok: false,
      code: "uploaded_digest_mismatch",
      assetId: found.id,
      message: "GitHub release asset digest does not match local sha256",
    };
  }
  return { ok: true, assetId: found.id, digest: `sha256:${hex}` };
}

function fail(result) {
  throw new KxmReleaseGithubError(result.code, result.message, result);
}

async function callApi(method, args) {
  try {
    return await method(...args);
  } catch (error) {
    if (error instanceof KxmReleaseGithubError) throw error;
    const err = new Error("network");
    err.cause = error;
    throw err;
  }
}

export async function runKxmReleasePublish(input) {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token) {
    throw new KxmReleaseGithubError("lookup_auth", "GITHUB_TOKEN is required");
  }
  const localSha256 = String(input.localSha256 ?? "").trim().toLowerCase();
  const assetName = input.assetName;
  const api = input.api;
  if (!api) {
    throw new KxmReleaseGithubError("lookup_http", "GitHub API client is required");
  }

  let lookupRaw;
  try {
    lookupRaw = await callApi(api.getReleaseByTag.bind(api), [input.tag]);
  } catch (error) {
    if (error instanceof KxmReleaseGithubError) throw error;
    throw new KxmReleaseGithubError("lookup_network", "release lookup network failure");
  }
  const lookup = interpretReleaseLookup(lookupRaw);
  const plan = planDraftAssetAction(lookup, { assetName, localSha256 });
  if (!plan.ok) fail(plan);

  if (plan.action === "skip_idempotent") {
    return {
      skipped: true,
      releaseId: plan.releaseId,
      assetId: plan.assetId,
      digest: plan.digest,
    };
  }

  let releaseId = plan.releaseId;
  if (plan.action === "create_and_upload") {
    let created;
    try {
      created = await callApi(api.createDraftRelease.bind(api), [{ tag: input.tag, name: input.tag }]);
    } catch (error) {
      if (error instanceof KxmReleaseGithubError) throw error;
      throw new KxmReleaseGithubError("create_network", "draft create network failure");
    }
    const status = created?.status;
    if (status === 401 || status === 403) {
      throw new KxmReleaseGithubError("lookup_auth", `draft create auth failure (${status})`);
    }
    if (typeof status !== "number" || status < 200 || status >= 300 || typeof created?.body?.id !== "number") {
      throw new KxmReleaseGithubError("create_http", `draft create failed (${status ?? "no status"})`);
    }
    releaseId = created.body.id;
  }

  let uploaded;
  try {
    uploaded = await callApi(api.uploadReleaseAsset.bind(api), [{
      releaseId,
      name: assetName,
      path: input.assetPath,
    }]);
  } catch (error) {
    if (error instanceof KxmReleaseGithubError) throw error;
    throw new KxmReleaseGithubError("upload_network", "asset upload network failure");
  }
  const uploadStatus = uploaded?.status;
  if (uploadStatus === 401 || uploadStatus === 403) {
    throw new KxmReleaseGithubError("lookup_auth", `asset upload auth failure (${uploadStatus})`);
  }
  if (typeof uploadStatus !== "number" || uploadStatus < 200 || uploadStatus >= 300) {
    throw new KxmReleaseGithubError("upload_http", `asset upload failed (${uploadStatus ?? "no status"})`);
  }

  let listed;
  try {
    listed = await callApi(api.listReleaseAssets.bind(api), [releaseId]);
  } catch (error) {
    if (error instanceof KxmReleaseGithubError) throw error;
    throw new KxmReleaseGithubError("verify_network", "asset list network failure");
  }
  const listStatus = listed?.status;
  if (typeof listStatus !== "number" || listStatus < 200 || listStatus >= 300 || !Array.isArray(listed?.body)) {
    throw new KxmReleaseGithubError("verify_http", `asset list failed (${listStatus ?? "no status"})`);
  }
  const match = verifyListedAssetDigest(listed.body, { assetName, localSha256 });
  if (!match.ok) fail(match);
  return {
    skipped: false,
    releaseId,
    assetId: match.assetId,
    digest: match.digest,
  };
}

export function createGithubReleaseApi({ token, repo, fetchImpl = fetch, readFile = readFileSync }) {
  const auth = `Bearer ${token}`;
  async function request(url, init = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: auth,
      "User-Agent": "kxm-release",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    };
    let response;
    try {
      response = await fetchImpl(url, { ...init, headers });
    } catch {
      const error = new Error("network");
      error.cause = undefined;
      throw error;
    }
    const text = await response.text();
    let body;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { status: response.status, body };
  }

  return {
    getReleaseByTag(tag) {
      return request(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    },
    createDraftRelease({ tag, name }) {
      return request(`https://api.github.com/repos/${repo}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tag,
          name,
          draft: true,
          generate_release_notes: false,
        }),
      });
    },
    uploadReleaseAsset({ releaseId, name, path }) {
      const bytes = readFile(path);
      return request(
        `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes,
        },
      );
    },
    listReleaseAssets(releaseId) {
      return request(`https://api.github.com/repos/${repo}/releases/${releaseId}/assets?per_page=100`);
    },
  };
}

export function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export async function main(env = process.env, stdout = process.stdout, stderr = process.stderr) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const tag = env.GITHUB_REF_NAME;
  const assetName = env.KXM_ASSET;
  const assetPath = env.KXM_ASSET_PATH;
  const declared = env.KXM_ASSET_SHA256;
  if (!repo || !tag || !assetName || !assetPath || !declared) {
    stderr.write("release publish requires repository, tag, asset name, path, and sha256\n");
    return 1;
  }
  const actual = fileSha256(assetPath);
  if (actual !== declared.trim().toLowerCase()) {
    stderr.write("local asset sha256 does not match KXM_ASSET_SHA256\n");
    return 1;
  }
  try {
    const result = await runKxmReleasePublish({
      repo,
      tag,
      assetName,
      assetPath,
      localSha256: actual,
      token,
      api: createGithubReleaseApi({ token, repo }),
    });
    stdout.write(`${JSON.stringify({
      ok: true,
      skipped: result.skipped,
      releaseId: result.releaseId,
      assetId: result.assetId,
      digest: result.digest,
    })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof KxmReleaseGithubError ? error.code : "release_failed";
    const message = error instanceof Error ? error.message : "release publish failed";
    stderr.write(`${code}: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== 0) process.exitCode = code;
}
