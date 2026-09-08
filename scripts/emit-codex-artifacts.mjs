#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_START = "<!-- kxm:codex:commands:start -->";
const MARKER_END = "<!-- kxm:codex:commands:end -->";

export const CODEX_COMMANDS_BLOCK = `${MARKER_START}
## KXM agent commands

The \`kxm\` CLI is the unified agent surface for peer collaboration and workflow stages. Every command supports \`--json\`.

### Peer messaging (\`kxm peer <verb> --json\`)

| Command | Purpose | Key options |
|---|---|---|
| \`kxm peer list\` | List online peer agents and purposes | \`--json\` |
| \`kxm peer send [target] [content]\` | Send a focused request to a peer | \`--target\`, \`--content\`, \`--delivery <steer\\|followUp\\|nextTurn>\`, \`--correlation-id\`, \`--idempotency-key\`, \`--workflow-context <json>\`, \`--ttl-ms\` |
| \`kxm peer get [messageId]\` | Check request status without blocking | \`--message-id\` |
| \`kxm peer await [messageId]\` | Wait for reply (capped at 60 seconds) | \`--message-id\`, \`--timeout-ms\` (max 60000) |
| \`kxm peer cancel [messageId]\` | Cancel a queued or delivered request | \`--message-id\` |
| \`kxm peer fanout\` | Send same request to 1–3 peers | \`--targets <t1,t2>\`, \`--content\`, \`--timeout-ms\`, \`--workflow-context <json>\` |
| \`kxm peer inbox\` | List inbound requests awaiting a reply | \`--json\` |
| \`kxm peer reply [messageId] [content]\` | Reply to an inbound request | \`--message-id\`, \`--content\` |

### Workflow lifecycle (\`kxm workflow <verb> --json\`)

| Command | Purpose | Key options |
|---|---|---|
| \`kxm workflow checkpoint [runId] [stageId] [status] [summary]\` | Record stage result with verified evidence | \`--run-id\`, \`--stage-id\`, \`--status <passed\\|warning\\|failed>\`, \`--summary\`, \`--evidence <json>\`, \`--evidence-refs <json>\` |
| \`kxm workflow record [runId] [category] [area] [summary]\` | Record plans, decisions, contradictions, errors, lessons | \`--run-id\`, \`--category <plan\\|decision\\|contradiction\\|error\\|lesson>\`, \`--area\`, \`--severity <info\\|warning\\|error>\`, \`--details\`, \`--evidence <items...>\` |
| \`kxm workflow wait [runId] [stageId] [signalKey] [summary]\` | Pause stage until an external signed signal arrives | \`--run-id\`, \`--stage-id\`, \`--signal-key\`, \`--summary\`, \`--evidence <json>\`, \`--evidence-refs <json>\`, \`--timeout-ms\` |
| \`kxm workflow signal <runId> <signalKey> <status> <summary>\` | Resume or unblock a waiting stage or vNext run | \`[evidence...]\`, \`--delivery-id\` |
| \`kxm workflow list\` | List local workflow runs | \`--json\` |
| \`kxm workflow get <runId>\` | Get stages and journal for a run | \`--json\` |

### Context operating system (\`kxm context <verb> --json\`)

| Command | Purpose | Key options |
|---|---|---|
| \`kxm context get <project>\` | Assemble role-aware context packet | \`--role\`, \`--task\`, \`--run\`, \`--stage\`, \`--budget\` |
| \`kxm context recall <project>\` | Search durable context metadata | \`--query\`, \`--kinds\`, \`--limit\` |
| \`kxm context state <project> <key>\` | Query authoritative temporal state | \`--as-of <timestamp>\` |
| \`kxm context episode <project>\` | Query workflow learning episodes | \`--run\` |
| \`kxm context promote <project> <key>\` | Propose temporal state change | \`--summary\`, \`--authority\`, \`--confidence\`, \`--evidence\` |
${MARKER_END}`;

export function emitCodexArtifacts(repoRoot = process.cwd()) {
  const root = resolve(repoRoot);
  const srcSkillsDir = join(root, "plugins", "kxm", "skills");
  const destSkillsDir = join(root, ".agents", "skills");

  // 1. Emit .agents/skills from authored skill tree
  if (existsSync(srcSkillsDir)) {
    mkdirSync(destSkillsDir, { recursive: true });
    cpSync(srcSkillsDir, destSkillsDir, { recursive: true });
  }

  // 2. Emit marker-delimited AGENTS.md block
  const agentsPath = join(root, "AGENTS.md");
  let agentsUpdated = false;
  if (existsSync(agentsPath)) {
    const original = readFileSync(agentsPath, "utf8");
    let updated;
    if (original.includes(MARKER_START) && original.includes(MARKER_END)) {
      const startIdx = original.indexOf(MARKER_START);
      const endIdx = original.indexOf(MARKER_END) + MARKER_END.length;
      updated = original.slice(0, startIdx) + CODEX_COMMANDS_BLOCK + original.slice(endIdx);
    } else {
      const doNotIdx = original.indexOf("## Do not");
      if (doNotIdx !== -1) {
        updated = `${original.slice(0, doNotIdx)}${CODEX_COMMANDS_BLOCK}\n\n${original.slice(doNotIdx)}`;
      } else {
        updated = `${original.trimEnd()}\n\n${CODEX_COMMANDS_BLOCK}\n`;
      }
    }
    if (updated !== original) {
      writeFileSync(agentsPath, updated);
      agentsUpdated = true;
    }
  }

  return { destSkillsDir, agentsPath, agentsUpdated };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = emitCodexArtifacts();
  process.stdout.write(`Codex artifacts emitted: skills -> ${result.destSkillsDir}, AGENTS.md updated -> ${result.agentsUpdated}\n`);
}
