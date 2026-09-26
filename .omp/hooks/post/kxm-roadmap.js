// The agent host must be restarted once for this hook to load.
// This hook regenerates pages. It never reanalyzes the roadmap.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function regenerate(ctx) {
  const root = ctx && ctx.cwd ? ctx.cwd : process.cwd();
  const script = `${root}/plans/kxm-roadmap/update-dashboard.mjs`;
  if (!existsSync(script)) return;
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 && ctx && ctx.ui) {
    ctx.ui.notify("roadmap refresh failed", "error");
  }
}

function watched(input) {
  if (!input || typeof input !== "object") return false;
  const raw = input.path || input.file_path || input.filePath || "";
  const path = String(raw).replaceAll("\\", "/");
  return path.endsWith("plans/kxm-roadmap/state.json")
    || path.includes("/docs/architecture/")
    || path.startsWith("docs/architecture/");
}

export default function kxmRoadmapHook(pi) {
  const run = {
    description: "Regenerate roadmap pages and the docs site. Does not reanalyze.",
    handler: async (_args, ctx) => {
      regenerate(ctx);
    },
  };
  pi.registerCommand("update-dashboard", run);
  pi.registerCommand("refresh-docs", { ...run });
  pi.on("session_start", (_event, ctx) => {
    regenerate(ctx);
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (!watched(event.input)) return;
    regenerate(ctx);
  });
}
