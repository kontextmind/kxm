import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["plugins/kxm-mesh/src/cli.ts", "plugins/kxm-mesh/src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "plugins/kxm-mesh/dist",
  entryNames: "[name]",
  banner: { js: "#!/usr/bin/env node" },
});

const cliPath = "plugins/kxm-mesh/dist/cli.js";
const shebang = "#!/usr/bin/env node\n";
const createRequire = "import { createRequire as __kxmCreateRequire } from 'node:module'; const require = __kxmCreateRequire(import.meta.url);\n";
const bundled = readFileSync(cliPath, "utf8");
if (!bundled.startsWith(shebang)) throw new Error("runtime bundle is missing its executable shebang");
writeFileSync(cliPath, `${shebang}${createRequire}${bundled.slice(shebang.length)}`);
