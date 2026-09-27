#!/usr/bin/env node
// Fail when this project's workforce ids drift: a route at a non-admitted
// model, a roster entry with no route file, a route no role uses, or an id
// that breaks the workforce convention. An admitted model with no route is a
// warning and does not fail the process.

import { lintWorkforce } from "./workforce-names.mjs";

const root = process.argv[2] ?? process.cwd();
const report = lintWorkforce(root);
for (const item of [...report.errors, ...report.warnings]) {
  process.stderr.write(`${item.severity} ${item.file}: ${item.code}: ${item.message}\n`);
}
if (report.errors.length > 0) {
  process.stderr.write(`workforce lint failed: ${report.errors.length} error(s), ${report.warnings.length} warning(s)\n`);
  process.exit(1);
}
process.stdout.write(`workforce lint passed (${report.warnings.length} warning(s))\n`);
