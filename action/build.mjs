// Bundles the Action into bundle/index.js (GitHub runs it without npm install) and copies the
// retirement catalog next to it, because the catalog reads ../data/*.json relative to its own file.
import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const here = new URL(".", import.meta.url);
await rm(new URL("bundle", here), { recursive: true, force: true });
await rm(new URL("data", here), { recursive: true, force: true });
await build({
  entryPoints: [new URL("src/main.ts", here).pathname],
  outfile: new URL("bundle/index.js", here).pathname,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
});
await mkdir(new URL("data", here));
await cp(new URL("../packages/catalog/data", here), new URL("data", here), { recursive: true });
console.log("action/bundle/index.js and action/data/ written");
