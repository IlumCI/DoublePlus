// Bundles each web/api/<name>.ts into a Vercel Build Output API serverless
// function at .vercel/output/functions/api/<name>.func/. Run from repo root
// after the static build; the deploy step ships static/ + functions/ together.
import { build } from "esbuild";
import { mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webDir, "..");
const apiDir = join(webDir, "api");
const outBase = join(repoRoot, ".vercel/output/functions/api");

rmSync(outBase, { recursive: true, force: true });

const entries = readdirSync(apiDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"));

for (const file of entries) {
  const name = file.replace(/\.ts$/, "");
  const funcDir = join(outBase, `${name}.func`);
  mkdirSync(funcDir, { recursive: true });

  await build({
    entryPoints: [join(apiDir, file)],
    outfile: join(funcDir, "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: true,
    // ESM output needs these shims for any CJS deps that reference them.
    banner: {
      js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
    },
  });

  writeFileSync(
    join(funcDir, ".vc-config.json"),
    JSON.stringify({ runtime: "nodejs20.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false }, null, 2),
  );
  console.log(`built function: /api/${name}`);
}

console.log(`\n${entries.length} function(s) → ${outBase}`);
