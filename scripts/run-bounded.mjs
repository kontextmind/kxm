#!/usr/bin/env node

// Wall-clock guard for a test suite. Node's --test-timeout also bounds each
// file (each file is a test), so the suite scripts do not pass it. This
// bounds the process that runs them.

import { spawn } from "node:child_process";

const timeoutMs = Number(process.argv[2]);
const command = process.argv[3];
const args = process.argv.slice(4);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || command === undefined) {
  console.error("usage: run-bounded.mjs <timeout-ms> <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit", detached: true });
let timedOut = false;

function signalGroup(signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`wall clock ${timeoutMs}ms exceeded`);
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), 2000).unref();
}, timeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    signalGroup(signal);
  });
}

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(124);
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
