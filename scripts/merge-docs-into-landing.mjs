// Merges the built VitePress docs into the Astro landing output so the combined
// site serves the documentation at /docs/.
//
// Order matters: the landing site must be built first (Astro cleans landing/dist on
// build, which would wipe a previously copied docs/ folder). Run via:
//   npm run build:site      (build:landing -> build:docs, correct order)
// or in CI: npm run build:landing && npm run build:docs
//
// Cross-platform (Node fs) — replaces the previous `cp -r`, which is not available
// in the Windows shell used for local development.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "docs/.vitepress/dist");
const landingDist = resolve(root, "landing/dist");
const dest = resolve(landingDist, "docs");

if (!existsSync(src)) {
  console.error(`[merge-docs] VitePress build not found at ${src}\n  Run "npm run docs:build" first.`);
  process.exit(1);
}
if (!existsSync(landingDist)) {
  console.error(`[merge-docs] landing/dist not found at ${landingDist}\n  Build the landing site first ("npm run build:landing"). Run "npm run build:site" to do both in order.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[merge-docs] Copied VitePress docs -> ${dest}`);
