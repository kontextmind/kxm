export type SupportedShell = "bash" | "zsh" | "fish";

const TOP_LEVEL_COMMANDS = [
  "init",
  "migrate",
  "backup",
  "restore",
  "run",
  "runs",
  "harness",
  "update",
  "runtime",
  "trust",
  "agent",
  "session",
  "peer",
  "workflow",
  "gate",
  "improve",
  "context",
  "skills",
  "memory",
  "routing",
  "hub",
  "dash",
  "config",
  "completion",
  "suggest",
  "goal",
  "task",
  "plan",
];

const SUBCOMMANDS: Record<string, string[]> = {
  runs: ["status", "cancel", "list"],
  migrate: ["plan", "apply", "verify"],
  harness: ["list"],
  runtime: ["start", "status", "stop"],
  trust: ["diff", "check"],
  agent: ["worker"],
  session: ["status", "brief", "start", "stop"],
  peer: ["list", "send", "get", "await", "cancel", "fanout", "inbox", "reply"],
  workflow: ["list", "get", "checkpoint", "record", "wait", "signal", "start", "export"],
  gate: ["validate", "artifacts-exist", "degrade", "signal", "github"],
  context: ["get", "recall", "state", "episode", "promote", "explain", "wiki-compile", "wiki-lint"],
  skills: ["create", "evaluate", "promote", "reject", "list", "verify"],
  memory: ["brief", "note", "sync"],
  routing: ["report"],
  hub: ["view", "start", "stop", "bind", "unbind"],
  config: ["get", "set", "list"],
  goal: ["create", "list", "get"],
  task: ["create", "list", "get", "run", "sync"],
};

export function generateShellCompletion(shell: SupportedShell): string {
  switch (shell) {
    case "bash":
      return generateBashCompletion();
    case "zsh":
      return generateZshCompletion();
    case "fish":
      return generateFishCompletion();
    default:
      throw new Error(`Unsupported shell: ${String(shell)}`);
  }
}

function generateBashCompletion(): string {
  const topList = TOP_LEVEL_COMMANDS.join(" ");
  let subcases = "";
  for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
    subcases += `
    ${cmd})
      COMPREPLY=( $(compgen -W "${subs.join(" ")}" -- "$cur") )
      return 0
      ;;`;
  }

  return `#!/usr/bin/env bash
# Bash completion for kxm

_kxm_completions() {
  local cur prev words cword
  _init_completion || return

  local top_commands="${topList}"

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$top_commands" -- "$cur") )
    return 0
  fi

  case "\${words[1]}" in${subcases}
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      return 0
      ;;
    dash)
      if [[ "$prev" == "--screen" ]]; then
        COMPREPLY=( $(compgen -W "agents tasks workflows plans inbox procs spend" -- "$cur") )
        return 0
      fi
      ;;
    context)
      if [[ "$prev" == "--role" ]]; then
        COMPREPLY=( $(compgen -W "repro planner critic implementer verifier" -- "$cur") )
        return 0
      fi
      ;;
    *)
      ;;
  esac
}

complete -F _kxm_completions kxm
`;
}

function generateZshCompletion(): string {
  return `#compdef kxm

_kxm() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  local -a commands
  commands=(
    'init:Create or validate a vNext project'
    'migrate:Plan, apply, and verify legacy configuration migration'
    'backup:Create a verified SQLite backup manifest'
    'restore:Restore SQLite stores from a backup manifest'
    'run:Create a vNext workflow run'
    'runs:Inspect vNext runs'
    'harness:Detect coding-agent harnesses and auth'
    'update:Update kxm, harness CLIs, and model catalogs'
    'runtime:Manage the vNext Runtime supervisor'
    'trust:Permission-diff trust review'
    'agent:Run and supervise agents'
    'session:Create manifests and brief recent hub work'
    'peer:Peer agent messaging and coordination'
    'workflow:Start and inspect workflow runs'
    'gate:Validate definitions and operate evidence gates'
    'improve:Propose CLI or project improvements'
    'context:KXM context operating-system queries'
    'skills:Governed skill candidate lifecycle'
    'memory:Harness-agnostic Git memory operations'
    'routing:Routing telemetry and behavioral comparisons'
    'hub:Start, inspect, and stop the local KXM hub'
    'dash:Live terminal dashboard screens'
    'config:Inspect and configure personalization settings'
    'completion:Generate shell autocompletions (bash, zsh, fish)'
    'suggest:Recommend workflow, roles, and skills from a prompt'
    'goal:Internal project goal management'
    'task:Task management driving workflow runs'
  )

  _arguments -C \\
    '1: :->cmd' \\
    '*:: :->args'

  case "$state" in
    cmd)
      _describe 'kxm commands' commands
      ;;
    args)
      case "\${line[1]}" in
        dash)
          _arguments '--screen[Screen to view]:screen:(agents tasks workflows plans inbox procs spend)'
          ;;
        completion)
          _arguments '1:shell:(bash zsh fish)'
          ;;
        config)
          _arguments '1:action:(get set list)'
          ;;
        runs)
          _arguments '1:subcommand:(status cancel list)'
          ;;
        workflow)
          _arguments '1:subcommand:(list get checkpoint record wait signal start export)'
          ;;
        memory)
          _arguments '1:subcommand:(brief note sync)'
          ;;
        task)
          _arguments '1:subcommand:(create list get run sync)'
          ;;
        goal)
          _arguments '1:subcommand:(create list get)'
          ;;
        *)
          _files
          ;;
      esac
      ;;
  esac
}

_kxm "$@"
`;
}

function generateFishCompletion(): string {
  const topList = TOP_LEVEL_COMMANDS.join(" ");
  return `# Fish completion for kxm

complete -c kxm -f

# Top level commands
complete -c kxm -n "__fish_use_subcommand" -a "${topList}"

# Completion subcommand
complete -c kxm -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"

# Dash subcommand
complete -c kxm -n "__fish_seen_subcommand_from dash" -l screen -a "agents tasks workflows plans inbox procs spend"

# Config subcommand
complete -c kxm -n "__fish_seen_subcommand_from config" -a "get set list"

# Runs subcommand
complete -c kxm -n "__fish_seen_subcommand_from runs" -a "status cancel list"

# Workflow subcommand
complete -c kxm -n "__fish_seen_subcommand_from workflow" -a "list get checkpoint record wait signal start export"

# Memory subcommand
complete -c kxm -n "__fish_seen_subcommand_from memory" -a "brief note sync"

# Task subcommand
complete -c kxm -n "__fish_seen_subcommand_from task" -a "create list get run sync"

# Goal subcommand
complete -c kxm -n "__fish_seen_subcommand_from goal" -a "create list get"
`;
}
