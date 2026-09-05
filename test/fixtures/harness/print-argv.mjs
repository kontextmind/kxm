#!/usr/bin/env node
// Echo argv as JSON. Used to prove shell:false keeps metacharacters literal.
process.stdout.write(`${JSON.stringify({
  execPath: process.execPath,
  argv: process.argv.slice(2),
  shell: process.env.KXM_PRINT_SHELL ?? null,
})}\n`);
