import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const KXM_UPDATE_SCHEMA = "kxm.update.v1" as const;
export const KXM_UPDATE_CACHE = "update-check.json";
const CHECK_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export type KxmUpdateSource = "npm" | "github";

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
}

export class KxmUpdateConfigError extends Error {
  readonly code = "kxm_update_config_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "KxmUpdateConfigError";
  }
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

export function noticeFromVersions(
  current: string,
  latest: string | undefined,
  config: KxmUpdateConfig,
  checkError?: string,
): KxmUpdateNotice {
  if (checkError || !latest) {
    return {
      current,
      auto: config.auto,
      source: config.source,
      available: false,
      message: checkError ? `kxm update check unavailable (${checkError})` : `kxm ${current}`,
    };
  }
  const cmp = compareSemver(current, latest);
  if (cmp === undefined) {
    return {
      current,
      latest,
      auto: config.auto,
      source: config.source,
      available: false,
      message: "kxm update check unavailable (non-semver)",
    };
  }
  if (cmp >= 0) {
    return { current, latest, auto: config.auto, source: config.source, available: false, message: `kxm ${current}` };
  }
  const available: KxmUpdateNotice = {
    current,
    latest,
    auto: config.auto,
    source: config.source,
    available: true,
    message: "",
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

export async function fetchLatestKxmVersion(
  source: KxmUpdateSource,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ latest?: string; error?: string }> {
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
    const body = await response.json() as { tag_name?: unknown };
    if (typeof body.tag_name !== "string") return { error: "github_tag_invalid" };
    const version = body.tag_name.replace(/^v/, "");
    if (!parseSemver(version)) return { error: "github_version_invalid" };
    return { latest: version };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { error: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export interface KxmPackageUpdateStep {
  command: string;
  args: string[];
}

/** npm registry apply is for after the public package exists. Git installs use GitHub release tarballs. */
export function planKxmPackageUpdate(source: KxmUpdateSource, latest: string, releaseDir: string): KxmPackageUpdateStep[] {
  if (source === "npm") {
    return [{ command: "npm", args: ["install", "--global", "--omit=peer", `@kontextmind/kxm@${latest}`] }];
  }
  const asset = `kxm-${latest}.tgz`;
  return [
    {
      command: "gh",
      args: ["release", "download", `v${latest}`, "--repo", "kontextmind/kxm", "--pattern", asset, "--dir", releaseDir, "--clobber"],
    },
    { command: "npm", args: ["install", "--global", "--omit=peer", join(releaseDir, asset)] },
  ];
}
