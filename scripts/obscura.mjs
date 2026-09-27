#!/usr/bin/env node
/**
 * Download pinned Obscura v0.2.3 and serve CDP for Playwright.
 *
 *   node scripts/obscura.mjs            foreground serve (download if needed)
 *   node scripts/obscura.mjs --ensure   exit 0 once CDP /json/version answers
 *   node scripts/obscura.mjs --stop     stop the process recorded in the pidfile
 *
 * Binaries land in `.kxm/bin/` (gitignored) and stay side by side.
 * The pidfile and log live in `.kxm/run/`. Playwright browser downloads
 * stay out of this script.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const OBSCURA_VERSION = "v0.2.3";
const READY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Unsuffixed release assets include rendering (needed for screenshots). */
const ASSETS = {
  "linux-x64": {
    name: "obscura-x86_64-linux.tar.gz",
    sha256: "1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec",
  },
  "linux-arm64": {
    name: "obscura-aarch64-linux.tar.gz",
    sha256: "5ecf980bca3060236a7a86ec7ed83d943e6598ee87caa46d20325d90bc75f979",
  },
  "darwin-x64": {
    name: "obscura-x86_64-macos.tar.gz",
    sha256: "d7c48122debc2ad9b24842df44560860dba765ea928b3f636b7f053225245116",
  },
  "darwin-arm64": {
    name: "obscura-aarch64-macos.tar.gz",
    sha256: "45653cfad226f1c9b415603a2ed59477fcbd6335c742338ce133c05de0bdd056",
  },
  "win32-x64": {
    name: "obscura-x86_64-windows.zip",
    sha256: "781a1b8bd12b65ec5aba95842e75e6f56b3101d360397506c0e35fe3f78536e8",
  },
};

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(repoRoot, ".kxm", "bin");
const runDir = join(repoRoot, ".kxm", "run");
const pidPath = join(runDir, "obscura.pid");
const logPath = join(runDir, "obscura.log");
const stampPath = join(binDir, "obscura-release");

function executableNames() {
  if (platform() === "win32") return { main: "obscura.exe", worker: "obscura-worker.exe" };
  return { main: "obscura", worker: "obscura-worker" };
}

function assetForThisMachine() {
  const key = `${platform()}-${arch()}`;
  const asset = ASSETS[key];
  if (!asset) {
    const known = Object.keys(ASSETS).join(", ");
    throw new Error(`Obscura ${OBSCURA_VERSION} has no build for ${key}. Known targets: ${known}`);
  }
  return asset;
}

function parsePort(raw, label) {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${label} must be an integer from 1 to 65535 (received ${JSON.stringify(raw)})`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535 (received ${JSON.stringify(raw)})`);
  }
  return port;
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function versionUrlFrom(cdpUrl) {
  const url = new URL(cdpUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported OBSCURA_CDP_URL protocol ${url.protocol}`);
  }
  const port = url.port
    ? parsePort(url.port, "OBSCURA_CDP_URL port")
    : url.protocol === "https:" ? 443 : 80;
  url.pathname = "/json/version";
  url.search = "";
  url.hash = "";
  return { versionUrl: url.href, port, loopback: isLoopback(url.hostname) };
}

function resolveLaunch() {
  const explicit = process.env.OBSCURA_CDP_URL?.trim() ?? "";
  const portRaw = process.env.OBSCURA_PORT?.trim() ?? "";
  const envPort = portRaw === "" ? null : parsePort(portRaw, "OBSCURA_PORT");
  if (explicit !== "") {
    const parsed = versionUrlFrom(explicit);
    if (envPort !== null && envPort !== parsed.port) {
      throw new Error(`OBSCURA_PORT=${envPort} does not match the port in OBSCURA_CDP_URL (${parsed.port})`);
    }
    return { cdpUrl: explicit, ...parsed };
  }
  const port = envPort ?? 9222;
  const cdpUrl = `http://127.0.0.1:${port}`;
  return { cdpUrl, versionUrl: `${cdpUrl}/json/version`, port, loopback: true };
}

function assertGlibc() {
  if (platform() !== "linux") return;
  const result = spawnSync("ldd", ["--version"], { encoding: "utf8" });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = text.match(/(\d+)\.(\d+)/);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 35)) {
    throw new Error(`Obscura ${OBSCURA_VERSION} needs glibc >= 2.35; this machine reports ${major}.${minor}`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function download(url, dest) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "kxm-obscura-launcher" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Obscura download failed: HTTP ${response.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

async function findNamed(dir, name, depth = 0) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory() && depth < 2 && entry.name !== ".staging") {
      const found = await findNamed(path, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function ensureBinaries() {
  const asset = assetForThisMachine();
  const names = executableNames();
  const mainPath = join(binDir, names.main);
  const workerPath = join(binDir, names.worker);
  const stamp = `${OBSCURA_VERSION} ${asset.name}\n`;
  let current = "";
  try {
    current = await readFile(stampPath, "utf8");
  } catch {
    current = "";
  }
  if (current === stamp) {
    try {
      const mainStat = await stat(mainPath);
      const workerStat = await stat(workerPath);
      if (mainStat.size > 0 && workerStat.size > 0) {
        process.stderr.write(`Obscura ${OBSCURA_VERSION} already present in ${binDir}\n`);
        return mainPath;
      }
    } catch {
      // Re-download when a binary is missing.
    }
  }

  assertGlibc();
  await mkdir(binDir, { recursive: true });
  const staging = join(binDir, ".staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const archivePath = join(staging, asset.name);
  const url = `https://github.com/h4ckf0r0day/obscura/releases/download/${OBSCURA_VERSION}/${asset.name}`;
  process.stderr.write(`Downloading Obscura ${OBSCURA_VERSION} (${asset.name})\n`);
  try {
    await download(url, archivePath);
    const digest = await sha256File(archivePath);
    if (digest !== asset.sha256) {
      throw new Error(`Obscura archive checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${digest}`);
    }
    const tarArgs = asset.name.endsWith(".zip")
      ? ["-xf", archivePath, "-C", staging]
      : ["-xzf", archivePath, "-C", staging];
    const extracted = spawnSync("tar", tarArgs, { encoding: "utf8" });
    if (extracted.status !== 0) {
      throw new Error(`tar failed to extract ${asset.name}: ${(extracted.stderr || extracted.stdout || "").trim()}`);
    }
    const mainFound = await findNamed(staging, names.main);
    const workerFound = await findNamed(staging, names.worker);
    if (!mainFound || !workerFound) {
      throw new Error(`Archive ${asset.name} did not contain ${names.main} and ${names.worker} together`);
    }
    await copyFile(mainFound, mainPath);
    await copyFile(workerFound, workerPath);
    if (platform() !== "win32") {
      await chmod(mainPath, 0o755);
      await chmod(workerPath, 0o755);
    }
    await writeFile(stampPath, stamp);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  process.stderr.write(`Installed Obscura ${OBSCURA_VERSION} into ${binDir}\n`);
  return mainPath;
}

async function isReady(versionUrl) {
  try {
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes("webSocketDebuggerUrl") || text.includes("Browser");
  } catch {
    return false;
  }
}

async function readPid() {
  try {
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function clearPid(pid) {
  const current = await readPid();
  if (current === pid) await rm(pidPath, { force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilReady(versionUrl, shouldStop = () => false) {
  const start = Date.now();
  while (!shouldStop() && Date.now() - start < READY_TIMEOUT_MS) {
    if (await isReady(versionUrl)) return true;
    await sleep(200);
  }
  if (shouldStop()) return false;
  let tail = "";
  try {
    const log = await readFile(logPath, "utf8");
    tail = log.split("\n").slice(-40).join("\n");
  } catch {
    tail = "(no Obscura log)";
  }
  throw new Error(`Obscura did not become ready at ${versionUrl} within ${READY_TIMEOUT_MS}ms.\n${tail}`);
}

async function stop() {
  const pid = await readPid();
  if (!pid || !alive(pid)) {
    await rm(pidPath, { force: true });
    process.stdout.write("Obscura is not running\n");
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && alive(pid)) await sleep(100);
  if (alive(pid)) process.kill(pid, "SIGKILL");
  await rm(pidPath, { force: true });
  process.stdout.write(`Stopped Obscura process ${pid}\n`);
}

function serveArgs(port) {
  return ["serve", "--port", String(port), "--allow-private-network"];
}

async function startDetached(binary, port) {
  await mkdir(runDir, { recursive: true });
  const logFd = openSync(logPath, "w");
  const child = spawn(binary, serveArgs(port), {
    cwd: binDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  if (!child.pid) throw new Error("Failed to start Obscura (no pid)");
  await writeFile(pidPath, `${child.pid}\n`);
  return child.pid;
}

async function startForeground(binary, port, versionUrl) {
  await mkdir(runDir, { recursive: true });
  const child = spawn(binary, serveArgs(port), {
    cwd: binDir,
    stdio: "inherit",
  });
  if (!child.pid) throw new Error("Failed to start Obscura (no pid)");
  await writeFile(pidPath, `${child.pid}\n`);
  let childDone = false;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      childDone = true;
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      childDone = true;
      resolve({ error });
    });
  });
  const ready = await waitUntilReady(versionUrl, () => childDone);
  if (!ready) {
    const result = await exitPromise;
    await clearPid(child.pid);
    const detail = result.error ? result.error.message : `code ${result.code ?? "null"} signal ${result.signal ?? "null"}`;
    throw new Error(`Obscura exited before ${versionUrl} was ready (${detail})`);
  }
  process.stderr.write(`Obscura CDP ready at ${versionUrl}\n`);
  const shutdown = (signal) => {
    if (alive(child.pid)) {
      try { process.kill(child.pid, signal); } catch { /* already gone */ }
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  const result = await exitPromise;
  await clearPid(child.pid);
  if (result.error) throw result.error;
  process.exit(result.code ?? (result.signal ? 1 : 0));
}

function usage() {
  process.stdout.write(
    `Usage: node scripts/obscura.mjs [--ensure | --stop]\n` +
    `  (no flag)   download pinned ${OBSCURA_VERSION} if needed and serve in the foreground\n` +
    `  --ensure    start a detached server when CDP is not ready, then exit 0\n` +
    `  --stop      stop the pidfile process\n`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--ensure", "--stop", "--help", "-h"].includes(args[0]))) {
    usage();
    throw new Error(`Unexpected argument ${JSON.stringify(args.join(" "))}`);
  }
  const mode = args[0] ?? "foreground";
  if (mode === "--help" || mode === "-h") {
    usage();
    return;
  }
  if (mode === "--stop") {
    await stop();
    return;
  }

  const launch = resolveLaunch();
  if (await isReady(launch.versionUrl)) {
    process.stdout.write(`Obscura CDP is ready at ${launch.versionUrl}\n`);
    return;
  }
  if (!launch.loopback) {
    throw new Error(`${launch.cdpUrl} is not ready and is not a loopback address, so this launcher will not start a local Obscura`);
  }
  const existing = await readPid();
  if (existing && alive(existing)) {
    await waitUntilReady(launch.versionUrl);
    process.stdout.write(`Obscura CDP is ready at ${launch.versionUrl}\n`);
    return;
  }
  await clearPid(existing ?? -1);

  const binary = await ensureBinaries();
  if (mode === "--ensure") {
    const pid = await startDetached(binary, launch.port);
    try {
      await waitUntilReady(launch.versionUrl);
    } catch (error) {
      if (alive(pid)) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      }
      await clearPid(pid);
      throw error;
    }
    process.stdout.write(`Obscura CDP is ready at ${launch.versionUrl} (pid ${pid})\n`);
    return;
  }
  await startForeground(binary, launch.port, launch.versionUrl);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
