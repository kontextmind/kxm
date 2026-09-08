#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SHA256_DIGEST = /^sha256:([0-9a-fA-F]{64})$/i;

export class KxmPublishNpmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "KxmPublishNpmError";
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

export function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function bufferSha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function interpretPublishedReleaseLookup(result) {
  if (result?.error === "network") {
    return { ok: false, code: "lookup_network", message: "release lookup network failure" };
  }
  if (result?.error === "auth") {
    return { ok: false, code: "lookup_auth", message: "release lookup auth failure" };
  }
  const status = result?.status;
  if (status === 404) {
    return { ok: false, code: "release_not_found", message: "release for tag not found" };
  }
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
  if (body.draft === true) {
    return {
      ok: false,
      code: "release_still_draft",
      id: body.id,
      message: "GitHub release is still a draft; must be published (draft: false) before npm publish",
    };
  }
  const assets = Array.isArray(body.assets) ? body.assets : [];
  return { ok: true, id: body.id, draft: false, assets };
}

export async function fetchPublishedRelease(api, tag) {
  const lookupRaw = await api.getReleaseByTag(tag);
  const lookup = interpretPublishedReleaseLookup(lookupRaw);
  if (lookup.ok) return lookup;
  if (lookup.code === "release_not_found" && typeof api.listReleases === "function") {
    const listRaw = await api.listReleases(1);
    if (Array.isArray(listRaw?.body)) {
      const match = listRaw.body.find((item) => item?.tag_name === tag);
      if (match?.draft === true) {
        return {
          ok: false,
          code: "release_still_draft",
          id: match.id,
          message: "GitHub release is still a draft; must be published (draft: false) before npm publish",
        };
      }
    }
  }
  return lookup;
}

export function findPublishedAsset(assets, assetName) {
  if (!Array.isArray(assets)) {
    return { ok: false, code: "asset_not_found", message: "assets must be an array" };
  }
  const found = assets.find((item) => item && typeof item === "object" && item.name === assetName);
  if (!found || typeof found.id !== "number") {
    return { ok: false, code: "asset_not_found", message: `asset ${assetName} not found on release` };
  }
  return { ok: true, asset: found };
}

export function createGithubReleaseApi({ token, repo }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "kxm-publish-npm",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return {
    async getReleaseByTag(tag) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers });
        const body = res.status === 204 ? null : await res.json().catch(() => null);
        return { status: res.status, body };
      } catch (err) {
        return { error: "network", cause: err };
      }
    },
    async listReleases(page = 1) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
        const body = res.status === 204 ? null : await res.json().catch(() => null);
        return { status: res.status, body };
      } catch (err) {
        return { error: "network", cause: err };
      }
    },
    async downloadReleaseAsset(assetId) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${assetId}`, {
          headers: {
            ...headers,
            Accept: "application/octet-stream",
          },
          redirect: "follow",
        });
        if (!res.ok) {
          return { status: res.status, buffer: null };
        }
        const arrayBuffer = await res.arrayBuffer();
        return { status: res.status, buffer: Buffer.from(arrayBuffer) };
      } catch (err) {
        return { error: "network", cause: err };
      }
    },
  };
}

export async function defaultNpmPublish({ assetPath, npmToken, access = "public" }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = ["publish", assetPath, "--access", access, `--//registry.npmjs.org/:_authToken=${npmToken}`];
    const env = { ...process.env, NODE_AUTH_TOKEN: npmToken };
    execFile("npm", args, { env }, (error, stdout, stderr) => {
      if (error) {
        const err = new KxmPublishNpmError("npm_publish_failed", stderr || stdout || error.message, {
          exitCode: typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        });
        rejectPromise(err);
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

export async function runKxmNpmPublish(input) {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token) {
    throw new KxmPublishNpmError("lookup_auth", "GITHUB_TOKEN is required");
  }
  const npmToken = typeof input.npmToken === "string" ? input.npmToken.trim() : "";
  if (!npmToken) {
    throw new KxmPublishNpmError("npm_auth_missing", "NODE_AUTH_TOKEN (or NPM_TOKEN) is required");
  }
  const tag = typeof input.tag === "string" ? input.tag.trim() : "";
  if (!tag) {
    throw new KxmPublishNpmError("input_missing", "tag is required");
  }
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  if (!repo) {
    throw new KxmPublishNpmError("input_missing", "repository is required");
  }
  const assetName = typeof input.assetName === "string" ? input.assetName.trim() : "";
  if (!assetName) {
    throw new KxmPublishNpmError("input_missing", "assetName is required");
  }

  const api = input.api ?? createGithubReleaseApi({ token, repo });
  const publishFn = input.publishFn ?? defaultNpmPublish;

  const waitMs = typeof input.waitMs === "number" ? Math.max(0, input.waitMs) : 0;
  const pollIntervalMs = typeof input.pollIntervalMs === "number" ? Math.max(500, input.pollIntervalMs) : 5000;
  const deadline = Date.now() + waitMs;

  // Step 1: Verify release is published (draft: false), with optional polling window
  let lookup;
  while (true) {
    lookup = await fetchPublishedRelease(api, tag);
    if (lookup.ok) break;
    if (lookup.code === "release_still_draft" && Date.now() + pollIntervalMs <= deadline) {
      if (typeof input.onWait === "function") {
        input.onWait({ tag, remainingMs: Math.max(0, deadline - Date.now()) });
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }
    throw new KxmPublishNpmError(lookup.code, lookup.message, lookup);
  }

  // Step 2: Find asset on published release
  const assetLookup = findPublishedAsset(lookup.assets, assetName);
  if (!assetLookup.ok) {
    throw new KxmPublishNpmError(assetLookup.code, assetLookup.message, assetLookup);
  }
  const remoteAsset = assetLookup.asset;
  const remoteDigest = normalizeSha256Digest(remoteAsset.digest);

  // Step 3: Acquire asset and verify SHA-256
  let assetPath = input.assetPath;
  let computedSha256;

  if (assetPath && existsSync(assetPath)) {
    computedSha256 = fileSha256(assetPath);
  } else {
    // Download asset via API
    const downloadRaw = await api.downloadReleaseAsset(remoteAsset.id);
    if (downloadRaw?.error || !downloadRaw?.buffer || downloadRaw.status < 200 || downloadRaw.status >= 300) {
      const status = downloadRaw?.status ?? "unknown";
      throw new KxmPublishNpmError("download_failed", `failed to download asset ${assetName} (${status})`);
    }
    const tempDir = input.tempDir ?? tmpdir();
    assetPath = join(tempDir, assetName);
    writeFileSync(assetPath, downloadRaw.buffer);
    computedSha256 = bufferSha256(downloadRaw.buffer);
  }

  // Verify against remote digest if present
  if (remoteDigest && computedSha256 !== remoteDigest) {
    throw new KxmPublishNpmError("digest_mismatch", `asset digest mismatch: computed ${computedSha256}, release has ${remoteDigest}`, {
      computed: computedSha256,
      expected: remoteDigest,
    });
  }

  // Verify against declared SHA-256 if passed
  const declaredSha256 = typeof input.declaredSha256 === "string" ? input.declaredSha256.trim().toLowerCase() : undefined;
  if (declaredSha256 && computedSha256 !== declaredSha256) {
    throw new KxmPublishNpmError("digest_mismatch", `asset digest mismatch with declared: computed ${computedSha256}, expected ${declaredSha256}`, {
      computed: computedSha256,
      expected: declaredSha256,
    });
  }

  // Step 4: Execute publish
  const publishResult = await publishFn({
    assetPath,
    npmToken,
    access: "public",
  });

  return {
    ok: true,
    published: true,
    tag,
    assetName,
    digest: `sha256:${computedSha256}`,
    stdout: publishResult?.stdout,
  };
}

export async function main(env = process.env, stdout = process.stdout, stderr = process.stderr) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const npmToken = env.NODE_AUTH_TOKEN || env.NPM_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const tag = env.GITHUB_REF_NAME || env.TAG;
  const assetName = env.KXM_ASSET;
  const assetPath = env.KXM_ASSET_PATH;
  const declaredSha256 = env.KXM_ASSET_SHA256;
  const tempDir = env.RUNNER_TEMP || tmpdir();
  const waitMs = env.KXM_PUBLISH_WAIT_MS ? Number(env.KXM_PUBLISH_WAIT_MS) : 180000; // default 3 min in CI

  if (!repo || !tag || !assetName) {
    stderr.write("npm publish requires GITHUB_REPOSITORY, tag (GITHUB_REF_NAME), and KXM_ASSET\n");
    return 1;
  }
  if (!token) {
    stderr.write("lookup_auth: GITHUB_TOKEN is required\n");
    return 1;
  }
  if (!npmToken) {
    stderr.write("npm_auth_missing: NODE_AUTH_TOKEN (or NPM_TOKEN) is required\n");
    return 1;
  }

  try {
    const result = await runKxmNpmPublish({
      token,
      npmToken,
      repo,
      tag,
      assetName,
      assetPath,
      declaredSha256,
      tempDir,
      waitMs,
      onWait: ({ remainingMs }) => {
        const sec = Math.round(remainingMs / 1000);
        stdout.write(`release ${tag} is currently a draft; waiting for publish (${sec}s remaining)...\n`);
      },
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof KxmPublishNpmError ? error.code : "publish_failed";
    const message = error instanceof Error ? error.message : "npm publish failed";
    stderr.write(`${code}: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== 0) process.exitCode = code;
}
