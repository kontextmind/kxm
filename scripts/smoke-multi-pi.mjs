#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const enabled = process.env.PI_MESH_SMOKE === "1" || process.argv.includes("--real-pi");
if (!enabled) {
  process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, reason: "PI_MESH_SMOKE is not 1" })}\n`);
  process.exitCode = 0;
} else {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" });
  const piAvailable = probe.status === 0;
  const reason = piAvailable
    ? "real Pi is present but model credentials are not part of ordinary smoke; use a labeled runner playbook"
    : "real Pi binary unavailable";
  process.stdout.write(`${JSON.stringify({ ok: true, skipped: true, realPi: piAvailable, reason })}\n`);
  process.exitCode = 0;
}
