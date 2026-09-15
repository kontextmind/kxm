#!/usr/bin/env node
// Deterministic Claude stand-in: write only if the read-only argv profile is weakened.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const probeName = process.env.KXM_WRITE_PROBE_NAME ?? "WRITE_PROBE.txt";
const probe = join(process.cwd(), probeName);
const WRITE_TOOLS = /(?:^|,)(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|REPL)(?:,|$)/i;

function argValue(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function profileAllowsWrite() {
  if (argv.includes("--dangerously-skip-permissions") || argv.includes("--allow-dangerously-skip-permissions")) return true;
  if (argv.includes("--allowedTools") || argv.includes("--allowed-tools")) return true;
  if (!argv.includes("--restricted") || !argv.includes("--safe-mode")) return true;
  if (argValue("--permission-mode") !== "plan") return true;
  if (argValue("--permission-prompts") !== "none") return true;
  const tools = argValue("--tools");
  if (tools === undefined || tools === "default") return true;
  return WRITE_TOOLS.test(tools);
}

try {
  readFileSync(0, "utf8");
} catch {
  // stdin may be empty
}

if (profileAllowsWrite()) {
  writeFileSync(probe, "kxm-write-probe\n");
  process.stdout.write(`${JSON.stringify({
    result: JSON.stringify({ outcome: "passed", summary: `Wrote ${probeName}` }),
    usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })}\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify({
  is_error: true,
  error: "Write tool is not available in this permission profile",
  result: JSON.stringify({ outcome: "passed", summary: `Wrote ${probeName}` }),
  usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})}\n`);
process.exit(0);
