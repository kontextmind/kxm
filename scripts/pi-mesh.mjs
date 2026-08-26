#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../plugins/pi-mesh-comms/src/cli.ts", import.meta.url));
const child = spawn(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  "--experimental-strip-types",
  cli,
  ...process.argv.slice(2),
], {
  stdio: "inherit",
  env: process.env,
});

child.once("error", (error) => {
  process.stderr.write(`Failed to start pi-mesh: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
