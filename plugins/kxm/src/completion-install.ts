import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { generateShellCompletion, type SupportedShell } from "./autocomplete.ts";

export const COMPLETION_MARKER = "# kxm completion";
export const PATH_MARKER = "# kxm path";
export interface CompletionInstallOptions {
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
  configDir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  isTty?: boolean | undefined;
  shell?: string | undefined;
  dryRun?: boolean | undefined;
  overwrite?: boolean | undefined;
}

export interface CompletionInstallReport {
  ok: boolean;
  shell: SupportedShell | "unknown";
  scriptPath: string;
  rcFile: string | undefined;
  rcModified: boolean;
  alreadyInstalled: boolean;
  reason?: string | undefined;
}

export function detectShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SupportedShell | "unknown" {
  const shellPath = env.SHELL?.trim() || (process.platform === "win32" ? undefined : env.SHELL?.trim());
  const name = shellPath ? basename(shellPath).toLowerCase() : "";
  if (name === "bash" || name === "zsh" || name === "fish") return name;
  if (name.endsWith("bash") || name.includes("bash")) return "bash";
  if (name.endsWith("zsh")) return "zsh";
  if (name.endsWith("fish")) return "fish";
  return "unknown";
}

function effectiveHome(options: Pick<CompletionInstallOptions, "env" | "homeDir">): string {
  const env = options.env ?? process.env;
  if (options.homeDir) return options.homeDir;
  const envHome = env.HOME?.trim() ?? env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? resolve(envHome) : homedir();
}

export function completionScriptPath(shell: SupportedShell, options: Pick<CompletionInstallOptions, "env" | "homeDir" | "configDir"> = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.configDir ?? env.KXM_USER_CONFIG_DIR?.trim();
  const base = explicit && explicit.length > 0 ? resolve(explicit) : resolve(effectiveHome(options), ".config", "kxm");
  return join(base, "completions", `kxm.${shell}`);
}

function bashRcCandidate(options: Pick<CompletionInstallOptions, "env" | "homeDir">): string | undefined {
  const home = effectiveHome(options);
  const candidates = [join(home, ".bashrc"), join(home, ".bash_profile")];
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0];
}

function zshRcCandidate(options: Pick<CompletionInstallOptions, "env" | "homeDir">): string | undefined {
  const env = options.env ?? process.env;
  const home = effectiveHome(options);
  if (env.ZDOTDIR?.trim()) return join(resolve(env.ZDOTDIR.trim()), ".zshrc");
  return join(home, ".zshrc");
}

function fishCompletionTarget(shell: SupportedShell, options: Pick<CompletionInstallOptions, "env" | "homeDir">): string {
  const env = options.env ?? process.env;
  const home = effectiveHome(options);
  if (env.XDG_CONFIG_HOME?.trim()) return join(resolve(env.XDG_CONFIG_HOME.trim()), "fish", "completions", "kxm.fish");
  return join(home, ".config", "fish", "completions", "kxm.fish");
}

export function completionRcTarget(shell: SupportedShell, options: Pick<CompletionInstallOptions, "env" | "homeDir"> = {}): { rcFile?: string | undefined } {
  if (shell === "fish") {
    return { rcFile: undefined }; // fish auto-loads ~/.config/fish/completions
  }
  if (shell === "zsh") {
    return { rcFile: zshRcCandidate(options) };
  }
  return { rcFile: bashRcCandidate(options) };
}

function sourceLine(shell: SupportedShell, scriptPath: string): string {
  if (shell === "fish") return `source ${scriptPath}`;
  if (shell === "zsh") return `[[ -f ${scriptPath} ]] && source ${scriptPath}`;
  return `[[ -f ${scriptPath} ]] && source ${scriptPath}`;
}

export function installShellCompletion(
  shellInput: string | undefined,
  options: CompletionInstallOptions = {},
): CompletionInstallReport {
  const shell = shellInput?.trim() && shellInput !== "auto" ? shellInput.trim() as SupportedShell : detectShell(options.env ?? process.env, options.platform ?? process.platform);
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    return {
      ok: false,
      shell: "unknown",
      scriptPath: "",
      rcFile: undefined,
      rcModified: false,
      alreadyInstalled: false,
      reason: "shell_not_detected",
    };
  }

  const scriptPath = completionScriptPath(shell, options);
  const { rcFile } = completionRcTarget(shell, options);
  const script = generateShellCompletion(shell);

  const existingScript = existsSync(scriptPath);
  const existingScriptMatches = existingScript && readFileSync(scriptPath, "utf8") === script;

  let rcModified = false;
  let alreadyInstalled = false;

  if (shell === "fish") {
    // fish auto-loads files in ~/.config/fish/completions by filename; no rc edit needed
    const fishTarget = fishCompletionTarget(shell, options);
    const fishInstalled = existsSync(fishTarget) && readFileSync(fishTarget, "utf8") === script;
    alreadyInstalled = fishInstalled;
    if (!options.dryRun && (!fishInstalled || options.overwrite)) {
      mkdirSync(resolve(fishTarget, ".."), { recursive: true });
      writeFileSync(fishTarget, script, { encoding: "utf8" });
    }
    return {
      ok: true,
      shell,
      scriptPath: fishTarget,
      rcFile: undefined,
      rcModified: !fishInstalled,
      alreadyInstalled,
    };
  }

  if (rcFile) {
    const line = sourceLine(shell, scriptPath);
    const rcContent = existsSync(rcFile) ? readFileSync(rcFile, "utf8") : "";
    alreadyInstalled = rcContent.includes(line) || rcContent.includes(`${COMPLETION_MARKER}`);
  }

  if (!options.dryRun) {
    if (!existingScriptMatches || options.overwrite) {
      mkdirSync(resolve(scriptPath, ".."), { recursive: true });
      writeFileSync(scriptPath, script, { encoding: "utf8" });
    }
    if (rcFile && !alreadyInstalled) {
      const line = sourceLine(shell, scriptPath);
      const marker = `${COMPLETION_MARKER} (${new Date().toISOString()})`;
      const stanza = `\n${marker}\n${line}\n`;
      mkdirSync(resolve(rcFile, ".."), { recursive: true });
      writeFileSync(rcFile, (existsSync(rcFile) ? readFileSync(rcFile, "utf8") : "") + stanza, { encoding: "utf8" });
      rcModified = true;
    }
  }

  return {
    ok: true,
    shell,
    scriptPath,
    rcFile,
    rcModified,
    alreadyInstalled,
  };
}

export interface PathInstallReport {
  ok: boolean;
  binDir: string | undefined;
  rcFile: string | undefined;
  rcModified: boolean;
  alreadyInstalled: boolean;
  reason?: string | undefined;
}

/** Locate the directory containing the kxm entrypoint (global npm bin or clone scripts dir). */
export function kxmBinDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const argv1 = env.KXM_ENTRY ?? process.argv[1];
  if (argv1 && isAbsolute(argv1)) {
    const dir = dirname(argv1);
    if (existsSync(join(dir, process.platform === "win32" ? "kxm.cmd" : "kxm"))) return dir;
  }
  // fall back to PATH lookup
  const pathEnv = env.PATH ?? "";
  for (const part of pathEnv.split(delimiter)) {
    if (!part) continue;
    const candidate = resolve(part, process.platform === "win32" ? "kxm.cmd" : "kxm");
    if (existsSync(candidate)) return resolve(part);
  }
  return undefined;
}

export function kxmOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return kxmBinDir(env) !== undefined;
}

function pathLine(binDir: string): string {
  return `export PATH="${binDir}:$PATH" # kxm`;
}

/** Append a PATH export for the kxm bin dir to the shell rc (bash/zsh). */
export function installPathEntry(
  shellInput: string | undefined,
  options: CompletionInstallOptions & { binDir?: string } = {},
): PathInstallReport {
  const shell = shellInput?.trim() && shellInput !== "auto" ? shellInput.trim() as SupportedShell : detectShell(options.env ?? process.env, options.platform ?? process.platform);
  if (shell !== "bash" && shell !== "zsh") {
    return { ok: false, binDir: undefined, rcFile: undefined, rcModified: false, alreadyInstalled: false, reason: "shell_not_supported" };
  }
  const binDir = options.binDir ?? kxmBinDir(options.env ?? process.env);
  if (!binDir) {
    return { ok: false, binDir: undefined, rcFile: undefined, rcModified: false, alreadyInstalled: false, reason: "kxm_not_found" };
  }
  const { rcFile } = completionRcTarget(shell, options);
  const line = pathLine(binDir);
  const rcContent = existsSync(rcFile ?? "") ? readFileSync(rcFile!, "utf8") : "";
  const alreadyInstalled = rcContent.includes(binDir) || (options.env?.PATH ?? process.env.PATH ?? "").split(delimiter).includes(binDir);
  if (!options.dryRun && rcFile && !alreadyInstalled) {
    mkdirSync(dirname(rcFile), { recursive: true });
    writeFileSync(rcFile, rcContent + `\n${PATH_MARKER}\n${line}\n`, { encoding: "utf8" });
  }
  return { ok: true, binDir, rcFile, rcModified: !alreadyInstalled && !options.dryRun, alreadyInstalled };
}
