import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const KXM_UPDATE_SCHEMA = "kxm.update.v1" as const;
export const KXM_UPDATE_CACHE = "update-check.json";
const CHECK_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SHA256_DIGEST = /^sha256:([0-9a-fA-F]{64})$/;

export type KxmUpdateSource = "npm" | "github";

export interface KxmReleaseAsset {
  name: string;
  sha256: string;
}

export interface KxmUpdateConfig {
  schema: typeof KXM_UPDATE_SCHEMA;
  auto: boolean;
  source: KxmUpdateSource;
}

export interface KxmUpdateNotice {
  current: string;
  latest?: string;
  available: boolean;
  auto: boolean;
  source: KxmUpdateSource;
  message: string;
  asset?: KxmReleaseAsset;
}

export class KxmUpdateConfigError extends Error {
  readonly code = "kxm_update_config_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "KxmUpdateConfigError";
  }
}

export function kxmReleaseAssetName(version: string): string {
  return `kxm-${version}.tgz`;
}

export function readInstalledKxmVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !parseSemver(pkg.version)) {
    throw new KxmUpdateConfigError("package.json version is missing or not a semver");
  }
  return pkg.version;
}

export function parseSemver(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: string, right: string): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

export function formatKxmUpdateNotice(notice: KxmUpdateNotice): string {
  if (!notice.available) return notice.message;
  const apply = notice.auto ? "kxm update --kxm (auto)" : "kxm update --kxm";
  return `kxm ${notice.current} → ${notice.latest} available · ${apply}`;
}

function withAsset(notice: KxmUpdateNotice, asset?: KxmReleaseAsset): KxmUpdateNotice {
  return asset ? { ...notice, asset } : notice;
}

export function noticeFromVersions(
  current: string,
  latest: string | undefined,
  config: KxmUpdateConfig,
  checkError?: string,
  asset?: KxmReleaseAsset,
): KxmUpdateNotice {
  if (checkError || !latest) {
    return withAsset({
      current,
      auto: config.auto,
      source: config.source,
      available: false,
      message: checkError ? `kxm update check unavailable (${checkError})` : `kxm ${current}`,
    }, asset);
  }
  const cmp = compareSemver(current, latest);
  if (cmp === undefined) {
    return withAsset({
      current,
      latest,
      auto: config.auto,
      source: config.source,
      available: false,
      message: "kxm update check unavailable (non-semver)",
    }, asset);
  }
  if (cmp >= 0) {
    return withAsset({
      current,
      latest,
      auto: config.auto,
      source: config.source,
      available: false,
      message: `kxm ${current}`,
    }, asset);
  }
  const available: KxmUpdateNotice = {
    current,
    latest,
    auto: config.auto,
    source: config.source,
    available: true,
    message: "",
    ...(asset ? { asset } : {}),
  };
  available.message = formatKxmUpdateNotice(available);
  return available;
}

export function readUpdateCache(stateDir: string, now = Date.now()): KxmUpdateNotice | undefined {
  const path = join(stateDir, KXM_UPDATE_CACHE);
  if (!existsSync(path)) return undefined;
  try {
    const row = JSON.parse(readFileSync(path, "utf8")) as {
      checkedAt?: unknown;
      notice?: KxmUpdateNotice;
    };
    if (typeof row.checkedAt !== "number" || !row.notice || now - row.checkedAt > CACHE_TTL_MS) return undefined;
    if (typeof row.notice.current !== "string" || typeof row.notice.available !== "boolean") return undefined;
    return row.notice;
  } catch {
    return undefined;
  }
}

export function writeUpdateCache(stateDir: string, notice: KxmUpdateNotice, now = Date.now()): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, KXM_UPDATE_CACHE), `${JSON.stringify({ checkedAt: now, notice })}\n`, { encoding: "utf8" });
}

function githubReleaseAsset(assets: unknown, version: string): KxmReleaseAsset | undefined {
  if (!Array.isArray(assets)) return undefined;
  const name = kxmReleaseAssetName(version);
  const match = assets.find((item) => item && typeof item === "object" && (item as { name?: unknown }).name === name);
  if (!match || typeof match !== "object") return undefined;
  const digest = (match as { digest?: unknown }).digest;
  if (typeof digest !== "string") return undefined;
  const parsed = SHA256_DIGEST.exec(digest.trim());
  if (!parsed) return undefined;
  return { name, sha256: parsed[1]!.toLowerCase() };
}

export async function fetchLatestKxmVersion(
  source: KxmUpdateSource,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ latest?: string; error?: string; asset?: KxmReleaseAsset }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    if (source === "npm") {
      const response = await fetchImpl("https://registry.npmjs.org/@kontextmind/kxm/latest", { signal: controller.signal });
      if (!response.ok) return { error: `npm_http_${response.status}` };
      const body = await response.json() as { version?: unknown };
      if (typeof body.version !== "string" || !parseSemver(body.version)) return { error: "npm_version_invalid" };
      return { latest: body.version };
    }
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl("https://api.github.com/repos/kontextmind/kxm/releases/latest", {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) return { error: `github_http_${response.status}` };
    const body = await response.json() as { tag_name?: unknown; assets?: unknown };
    if (typeof body.tag_name !== "string") return { error: "github_tag_invalid" };
    const version = body.tag_name.replace(/^v/, "");
    if (!parseSemver(version)) return { error: "github_version_invalid" };
    const asset = githubReleaseAsset(body.assets, version);
    return asset ? { latest: version, asset } : { latest: version };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { error: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export type KxmPackageUpdateStep =
  | { kind: "download"; command: "gh"; args: string[] }
  | { kind: "verify"; path: string; sha256: string }
  | { kind: "install"; command: "npm"; args: string[] };

export function verifyReleaseAssetDigest(path: string, sha256: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    return actual === sha256.toLowerCase();
  } catch {
    return false;
  }
}

/** npm registry apply is for after the public package exists. npm verifies registry integrity itself; do not duplicate that check here. Git installs use GitHub release tarballs. */
export function planKxmPackageUpdate(
  source: KxmUpdateSource,
  latest: string,
  releaseDir: string,
  asset?: KxmReleaseAsset,
): KxmPackageUpdateStep[] {
  if (source === "npm") {
    return [{ kind: "install", command: "npm", args: ["install", "--global", "--omit=peer", `@kontextmind/kxm@${latest}`] }];
  }
  const name = asset?.name ?? kxmReleaseAssetName(latest);
  const steps: KxmPackageUpdateStep[] = [
    {
      kind: "download",
      command: "gh",
      args: ["release", "download", `v${latest}`, "--repo", "kontextmind/kxm", "--pattern", name, "--dir", releaseDir, "--clobber"],
    },
  ];
  if (asset?.sha256) {
    steps.push({ kind: "verify", path: join(releaseDir, name), sha256: asset.sha256 });
  }
  steps.push({ kind: "install", command: "npm", args: ["install", "--global", "--omit=peer", join(releaseDir, name)] });
  return steps;
}
