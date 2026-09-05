#!/usr/bin/env node
// Capture argv + stdin for just recipe transport tests. No model spawn.
import { readFileSync, writeFileSync } from "node:fs";

const stdin = readFileSync(0, "utf8");
const payload = {
  argv: process.argv.slice(2),
  stdin,
};
const dest = process.env.KXM_CAPTURE;
if (dest) writeFileSync(dest, `${JSON.stringify(payload)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, captured: true })}\n`);
