#!/usr/bin/env node
/**
 * Assembles the `ctrlyoke` npm package in dist/npm/ from an existing build.
 *
 * Usage:
 *   node scripts/build-npm-package.mjs [outDir]
 *
 * Run after a production build (`npm run build:extension`, or `npm run package`
 * in release.yml). The package reuses the extension's `out/` layout because the
 * CLI finds its runtime assets relative to the package root
 * (`CliAdapter.getExtensionPath()`). It gets a generated package.json with no
 * dependencies; the root package.json is extension-only and is never published.
 * See dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.2.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export const NPM_PACKAGE_NAME = "ctrlyoke";
export const DEFAULT_OUT_DIR = path.join(ROOT_DIR, "dist", "npm");
const NPM_README_SOURCE = path.join(
  ROOT_DIR,
  "scripts",
  "npm-package",
  "README.md"
);

/**
 * Everything the CLI and MCP server load at runtime, relative to the package
 * root. A trailing "/" copies the directory. Keep this in step with the
 * `out/` entries in .vscodeignore; the packaging test checks both.
 */
export const NPM_PACKAGE_ENTRIES = [
  "out/cli.js",
  "out/server/",
  "out/ui/webview-react/",
  "out/runtime-deps/",
  "out/mcp-server.js",
  "out/historySearchRebuildWorker.js",
  "out/historySearchMatcherWorker.js",
  "out/workspaceFileIndexWorker.js",
  "out/scriptRegexWorker.js",
  "out/templates/",
  "out/schemas/",
  "out/scripts/",
  "bin/ctrlyoke",
  "bin/ctrlyoke.cmd",
  "bin/ctrlyoke-mcp",
  "bin/ctrlyoke-mcp.cmd",
  "LICENSE.md",
  "THIRD_PARTY_NOTICES.md",
];

/** Build output that must not ship: source maps and dev-only sources. */
function isShippable(relativePath) {
  return !relativePath.endsWith(".map");
}

/** The published package.json, derived from the root one. */
export function buildNpmPackageJson(rootPackage) {
  return {
    name: NPM_PACKAGE_NAME,
    version: rootPackage.version,
    description:
      "Command-line runner and MCP server for ctrlyoke workflows across AI coding harnesses.",
    license: rootPackage.license,
    homepage: rootPackage.homepage,
    repository: rootPackage.repository,
    bugs: rootPackage.bugs,
    keywords: ["ctrlyoke", "ai", "cli", "workflow", "mcp", "agents"],
    bin: {
      ctrlyoke: "out/cli.js",
      "ctrlyoke-mcp": "out/mcp-server.js",
    },
    engines: { node: rootPackage.engines.node },
    files: ["out/", "bin/", "LICENSE.md", "THIRD_PARTY_NOTICES.md"],
  };
}

function copyEntry(rootDir, outDir, entry) {
  const source = path.join(rootDir, entry);
  if (!fs.existsSync(source)) {
    throw new Error(
      `build-npm-package: missing ${entry}. Run a production build first (npm run build:extension).`
    );
  }
  fs.cpSync(source, path.join(outDir, entry), {
    recursive: true,
    filter: (file) => isShippable(path.relative(rootDir, file)),
  });
}

/** Assemble the package into `outDir`, replacing whatever was there. */
export function buildNpmPackage({
  rootDir = ROOT_DIR,
  outDir = DEFAULT_OUT_DIR,
} = {}) {
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
  );
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const entry of NPM_PACKAGE_ENTRIES) {
    copyEntry(rootDir, outDir, entry);
  }
  fs.copyFileSync(NPM_README_SOURCE, path.join(outDir, "README.md"));

  const npmPackage = buildNpmPackageJson(rootPackage);
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    `${JSON.stringify(npmPackage, null, 2)}\n`
  );

  // A checkout on Windows has no executable bit to copy.
  for (const shim of ["bin/ctrlyoke", "bin/ctrlyoke-mcp"]) {
    fs.chmodSync(path.join(outDir, shim), 0o755);
  }
  return npmPackage;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_OUT_DIR;
  const { name, version } = buildNpmPackage({ outDir });
  console.log(`build-npm-package: ${name}@${version} -> ${outDir}`);
}
