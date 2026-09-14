/**
 * Multiplexed remote SSH execution, worker orchestration, and secure config discovery.
 *
 * Implements:
 * - Safe `~/.ssh/config` parsing and alias discovery without socket connections or credential leaks.
 * - OpenSSH `ControlMaster` connection reuse (.kxm/run/ssh-sockets/%C) for low-latency command execution.
 * - In-memory masked credential passing via `sshpass -e` (env) and `sudo -S -p ''` (stdin).
 * - Safety seatbelt validation and pinned host key verification.
 * - Output bounding and truncation (50KB / 2000 lines).
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertCommandSeatbelt, assertPinnedSshHostKeyPolicy } from "./safety-integrity.ts";

export const MAX_SSH_OUTPUT_BYTES = 50 * 1024; // 50KB
export const MAX_SSH_OUTPUT_LINES = 2000;
export const DEFAULT_SOCKET_DIR = ".kxm/run/ssh-sockets";
export const DEFAULT_CONTROL_PERSIST = "10m";

export interface SshHostInfo {
  alias: string;
  hostName?: string | undefined;
  user?: string | undefined;
  port?: number | undefined;
  proxyJump?: string | undefined;
  identityFiles?: string[] | undefined;
}

export interface SshRunParams {
  action: "info" | "command" | "file";
  host?: string | undefined;
  command?: string | undefined;
  sudo?: boolean | undefined;
  file_path?: string | undefined;
  file_content?: string | undefined;
  file_op?: "write" | "read" | "append" | undefined;
  reason?: string | undefined;
  password?: string | undefined;
  sudo_password?: string | undefined;
  socket_dir?: string | undefined;
  control_persist?: string | undefined;
  timeout_ms?: number | undefined;
  strict_host_key?: boolean | undefined;
  execFn?: ((cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
    status: number | null;
    stdout: string | Buffer;
    stderr: string | Buffer;
    error?: Error | undefined;
  }) | undefined;
}

export interface SshExecutionReceipt {
  ok: boolean;
  action: "info" | "command" | "file";
  host?: string | undefined;
  resolvedHost?: string | undefined;
  user?: string | undefined;
  port?: number | undefined;
  exitCode?: number | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  durationMs?: number | undefined;
  truncated?: boolean | undefined;
  socketReused?: boolean | undefined;
  fileProcessed?: string | undefined;
  bytesProcessed?: number | undefined;
  hosts?: SshHostInfo[] | undefined;
  error?: string | undefined;
}

/**
 * Truncates output to 50KB and 2000 lines max.
 */
export function truncateSshOutput(raw: string): { text: string; truncated: boolean } {
  let text = raw;
  let truncated = false;

  if (Buffer.byteLength(text, "utf-8") > MAX_SSH_OUTPUT_BYTES) {
    const buf = Buffer.from(text, "utf-8");
    text = buf.subarray(0, MAX_SSH_OUTPUT_BYTES).toString("utf-8");
    truncated = true;
  }

  const lines = text.split("\n");
  if (lines.length > MAX_SSH_OUTPUT_LINES) {
    text = lines.slice(0, MAX_SSH_OUTPUT_LINES).join("\n");
    truncated = true;
  }

  if (truncated) {
    text += `\n\n[kxm: ssh output truncated to ${MAX_SSH_OUTPUT_BYTES / 1024}KB / ${MAX_SSH_OUTPUT_LINES} lines]`;
  }

  return { text, truncated };
}

/**
 * Parses ~/.ssh/config safely to list host aliases and their configurations.
 * Does not read private key files or open network sockets.
 */
export function parseSshConfig(configPath?: string): SshHostInfo[] {
  const targetPath = configPath ?? join(homedir(), ".ssh", "config");
  if (!existsSync(targetPath)) {
    return [];
  }

  try {
    const content = readFileSync(targetPath, "utf-8");
    const lines = content.split("\n");
    const hosts: SshHostInfo[] = [];
    let currentHosts: SshHostInfo[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const spaceIdx = line.search(/\s/);
      if (spaceIdx === -1) continue;

      const key = line.slice(0, spaceIdx).trim().toLowerCase();
      const value = line.slice(spaceIdx + 1).trim();

      if (key === "host") {
        // Space-separated host patterns; skip wildcard-only matches like "*"
        const aliases = value.split(/\s+/).filter((a) => a !== "*");
        currentHosts = [];
        for (const alias of aliases) {
          const entry: SshHostInfo = { alias, identityFiles: [] };
          currentHosts.push(entry);
          hosts.push(entry);
        }
      } else if (currentHosts.length > 0) {
        for (const currentHost of currentHosts) {
          if (key === "hostname") {
            currentHost.hostName = value;
          } else if (key === "user") {
            currentHost.user = value;
          } else if (key === "port") {
            const p = Number.parseInt(value, 10);
            if (!Number.isNaN(p)) currentHost.port = p;
          } else if (key === "proxyjump") {
            currentHost.proxyJump = value;
          } else if (key === "identityfile") {
            currentHost.identityFiles = currentHost.identityFiles ?? [];
            currentHost.identityFiles.push(value);
          }
        }
      }
    }

    return hosts;
  } catch {
    return [];
  }
}

/**
 * Resolves effective SSH parameters for a specific host using `ssh -G <host>`.
 * Does not initiate any network connections.
 */
export function resolveSshHostG(
  host: string,
  execFn: typeof spawnSync = spawnSync,
): SshHostInfo {
  try {
    const result = execFn("ssh", ["-G", host], { encoding: "utf-8" });
    if (result.status !== 0 || !result.stdout) {
      return { alias: host, hostName: host };
    }

    const lines = String(result.stdout).split("\n");
    const info: SshHostInfo = { alias: host, identityFiles: [] };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;

      const key = line.slice(0, spaceIdx).toLowerCase();
      const value = line.slice(spaceIdx + 1).trim();

      if (key === "hostname") {
        info.hostName = value;
      } else if (key === "user") {
        info.user = value;
      } else if (key === "port") {
        const p = Number.parseInt(value, 10);
        if (!Number.isNaN(p)) info.port = p;
      } else if (key === "proxyjump") {
        if (value && value !== "none") info.proxyJump = value;
      } else if (key === "identityfile") {
        info.identityFiles = info.identityFiles ?? [];
        info.identityFiles.push(value);
      }
    }

    return info;
  } catch {
    return { alias: host, hostName: host };
  }
}

/**
 * Ensures control socket directory exists with secure permissions (0700).
 */
export function ensureSocketDir(socketDir: string = DEFAULT_SOCKET_DIR): string {
  const resolved = resolve(socketDir);
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  return resolved;
}

/**
 * Formats standard OpenSSH arguments including ControlMaster multiplexing
 * and safety invariants.
 */
export function buildSshArgs(options: {
  host: string;
  socketDir?: string | undefined;
  controlPersist?: string | undefined;
  batchMode?: boolean | undefined;
  strictHostKey?: boolean | undefined;
  extraArgs?: string[] | undefined;
}): string[] {
  const socketDir = ensureSocketDir(options.socketDir ?? DEFAULT_SOCKET_DIR);
  const controlPath = join(socketDir, "%C");
  const persist = options.controlPersist ?? DEFAULT_CONTROL_PERSIST;

  const args: string[] = [
    "-o", `ControlMaster=auto`,
    "-o", `ControlPath=${controlPath}`,
    "-o", `ControlPersist=${persist}`,
  ];

  if (options.batchMode !== false) {
    args.push("-o", "BatchMode=yes");
  }

  if (options.strictHostKey !== false) {
    args.push("-o", "StrictHostKeyChecking=yes");
  }

  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  // Validate that no insecure host key flags are present
  assertPinnedSshHostKeyPolicy(args);

  args.push(options.host);
  return args;
}

/**
 * Checks if a ControlMaster socket is active for the target host.
 */
export function checkControlSocket(
  host: string,
  socketDir: string = DEFAULT_SOCKET_DIR,
  execFn: typeof spawnSync = spawnSync,
): boolean {
  const resolvedDir = ensureSocketDir(socketDir);
  const controlPath = join(resolvedDir, "%C");
  try {
    const result = execFn("ssh", ["-O", "check", "-o", `ControlPath=${controlPath}`, host], {
      encoding: "utf-8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Closes an active ControlMaster socket for the target host.
 */
export function closeControlSocket(
  host: string,
  socketDir: string = DEFAULT_SOCKET_DIR,
  execFn: typeof spawnSync = spawnSync,
): boolean {
  const resolvedDir = ensureSocketDir(socketDir);
  const controlPath = join(resolvedDir, "%C");
  try {
    const result = execFn("ssh", ["-O", "stop", "-o", `ControlPath=${controlPath}`, host], {
      encoding: "utf-8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Cleans up all orphaned or expired ControlMaster sockets in the socket directory.
 */
export function pruneSocketDir(socketDir: string = DEFAULT_SOCKET_DIR): number {
  const resolvedDir = ensureSocketDir(socketDir);
  let removed = 0;
  try {
    const entries = readdirSync(resolvedDir);
    for (const entry of entries) {
      const fullPath = join(resolvedDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isSocket()) {
          rmSync(fullPath, { force: true });
          removed++;
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Ignore directory read errors
  }
  return removed;
}

/**
 * Main execution handler for `ssh_run` tool.
 */
export function executeSshRun(params: SshRunParams): SshExecutionReceipt {
  const startTime = Date.now();
  const execSyncFn = params.execFn ?? spawnSync;

  // 1. Action: "info"
  if (params.action === "info") {
    if (params.host) {
      const hostInfo = resolveSshHostG(params.host, execSyncFn as typeof spawnSync);
      return {
        ok: true,
        action: "info",
        host: params.host,
        resolvedHost: hostInfo.hostName ?? params.host,
        user: hostInfo.user,
        port: hostInfo.port,
        hosts: [hostInfo],
        durationMs: Date.now() - startTime,
      };
    }

    const discovered = parseSshConfig();
    return {
      ok: true,
      action: "info",
      hosts: discovered,
      durationMs: Date.now() - startTime,
    };
  }

  // Require host for command and file actions
  if (!params.host) {
    return {
      ok: false,
      action: params.action,
      error: 'Parameter "host" is required for command and file actions.',
      durationMs: Date.now() - startTime,
    };
  }

  const host = params.host;
  const socketDir = params.socket_dir ?? DEFAULT_SOCKET_DIR;
  const wasSocketActive = checkControlSocket(host, socketDir, execSyncFn as typeof spawnSync);

  // 2. Action: "command"
  if (params.action === "command") {
    if (!params.command) {
      return {
        ok: false,
        action: "command",
        host,
        error: 'Parameter "command" is required for command action.',
        durationMs: Date.now() - startTime,
      };
    }

    // Safety check: block destructive commands
    try {
      assertCommandSeatbelt(params.command);
    } catch (err: unknown) {
      return {
        ok: false,
        action: "command",
        host,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }

    let remoteCommand = params.command;
    let inputStdin: string | undefined = undefined;

    // Handle remote sudo via stdin pipe
    if (params.sudo) {
      const sudoPwd = params.sudo_password ?? params.password;
      if (sudoPwd) {
        inputStdin = `${sudoPwd}\n`;
        remoteCommand = `sudo -S -p '' -- sh -c ${JSON.stringify(params.command)}`;
      } else {
        remoteCommand = `sudo -- sh -c ${JSON.stringify(params.command)}`;
      }
    }

    const useSshPass = Boolean(params.password);
    const sshArgs = buildSshArgs({
      host,
      socketDir,
      controlPersist: params.control_persist,
      batchMode: !useSshPass,
      strictHostKey: params.strict_host_key,
    });
    sshArgs.push("--", remoteCommand);

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    let binary = "ssh";
    let finalArgs = sshArgs;

    // Masked credential security: SSH password via SSHPASS environment variable
    if (useSshPass && params.password) {
      binary = "sshpass";
      finalArgs = ["-e", "ssh", ...sshArgs];
      spawnEnv.SSHPASS = params.password;
    }

    try {
      const result = execSyncFn(binary, finalArgs, {
        encoding: "utf-8",
        env: spawnEnv,
        input: inputStdin,
        timeout: params.timeout_ms ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const stdoutRaw = String(result.stdout || "");
      const stderrRaw = String(result.stderr || "");

      // Sanitize stderr from potential sudo password echoes
      const sanitizedStderr = stderrRaw.replace(/\[sudo\] password for [^:]+:\s*/gi, "");

      const stdoutTrunc = truncateSshOutput(stdoutRaw);
      const stderrTrunc = truncateSshOutput(sanitizedStderr);

      return {
        ok: result.status === 0,
        action: "command",
        host,
        exitCode: result.status ?? 1,
        stdout: stdoutTrunc.text,
        stderr: stderrTrunc.text,
        truncated: stdoutTrunc.truncated || stderrTrunc.truncated,
        socketReused: wasSocketActive,
        durationMs: Date.now() - startTime,
        error: result.error ? result.error.message : undefined,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        action: "command",
        host,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // 3. Action: "file"
  if (params.action === "file") {
    if (!params.file_path) {
      return {
        ok: false,
        action: "file",
        host,
        error: 'Parameter "file_path" is required for file action.',
        durationMs: Date.now() - startTime,
      };
    }

    const filePath = params.file_path;
    const op = params.file_op ?? "write";

    if (op === "read") {
      const readCmd = params.sudo ? `sudo cat ${JSON.stringify(filePath)}` : `cat ${JSON.stringify(filePath)}`;
      return executeSshRun({
        ...params,
        action: "command",
        command: readCmd,
      });
    }

    const content = params.file_content ?? "";
    const redirectOp = op === "append" ? ">>" : ">";
    const writeCmd = params.sudo
      ? `sudo tee ${op === "append" ? "-a " : ""}${JSON.stringify(filePath)} > /dev/null`
      : `cat ${redirectOp} ${JSON.stringify(filePath)}`;

    const useSshPass = Boolean(params.password);
    const sshArgs = buildSshArgs({
      host,
      socketDir,
      controlPersist: params.control_persist,
      batchMode: !useSshPass,
      strictHostKey: params.strict_host_key,
    });
    sshArgs.push("--", writeCmd);

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    let binary = "ssh";
    let finalArgs = sshArgs;

    if (useSshPass && params.password) {
      binary = "sshpass";
      finalArgs = ["-e", "ssh", ...sshArgs];
      spawnEnv.SSHPASS = params.password;
    }

    try {
      const result = execSyncFn(binary, finalArgs, {
        encoding: "utf-8",
        env: spawnEnv,
        input: content,
        timeout: params.timeout_ms ?? 60_000,
      });

      return {
        ok: result.status === 0,
        action: "file",
        host,
        exitCode: result.status ?? 1,
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
        fileProcessed: filePath,
        bytesProcessed: Buffer.byteLength(content, "utf-8"),
        socketReused: wasSocketActive,
        durationMs: Date.now() - startTime,
        error: result.error ? result.error.message : undefined,
      };
    } catch (err: unknown) {
      return {
        ok: false,
        action: "file",
        host,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  return {
    ok: false,
    action: params.action,
    error: `Unknown action: ${(params as { action: string }).action}`,
    durationMs: Date.now() - startTime,
  };
}
