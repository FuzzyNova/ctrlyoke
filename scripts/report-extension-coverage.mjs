#!/usr/bin/env node
/**
 * Extension-host test coverage.
 *
 * The extension-host test suite (out/test/runTest.js) runs inside a separate
 * VS Code/Electron process spawned by @vscode/test-electron, so nyc/c8 can't
 * instrument it by wrapping the command (they only instrument the process
 * they directly spawn). Instead we set NODE_V8_COVERAGE so that process
 * writes raw V8 coverage itself, then run `c8 report` against those files.
 *
 * On Windows, Node always lowercases the drive letter in file:// coverage
 * URLs (e.g. file:///c:/dev/ctrlyoke/...), while c8 resolves the project
 * root using the OS-native casing (e.g. C:\dev\ctrlyoke). c8's --include
 * glob matching is case-sensitive, so every file silently reports 0%
 * without the fix-up below.
 *
 * c8's --include/--exclude match against the *executed* script path
 * (out/**\/*.js, since tests require() the tsc output directly) — not the
 * original src/**\/*.ts glob. The remap to .ts filenames for display happens
 * afterward via source maps, so filtering on src/**\/*.ts matches nothing.
 *
 * Usage: node scripts/report-extension-coverage.mjs
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const coverageTmpDir = path.join(root, ".coverage-tmp");
const reportsDir = path.join(root, "coverage", "extension");

const INCLUDE = "out/**/*.js";
const EXCLUDES = [
  "out/test/**",
  "out/extension.js",
  "out/mcp-server.js",
  "out/cli.js",
  // Webview/browser-only bundles: never execute under the Node-based
  // extension-host test suite, so they'd only add zero-coverage noise here.
  // The webview side has its own coverage via `npm run test:ui:coverage`.
  "out/ui/webview-scripts/**",
  "out/ui/webview-react/**",
  "out/runtime-deps/**",
  "out/server/standalone-shim.js",
  "out/server/ctrlyoke-service-worker.js",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

function normalizeDriveLetterCasing(dir) {
  if (process.platform !== "win32") return;
  const driveLetter = root[0];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const raw = fs.readFileSync(full, "utf8");
    const fixed = raw.replace(
      /file:\/\/\/[a-zA-Z]:/g,
      `file:///${driveLetter}:`
    );
    if (fixed !== raw) fs.writeFileSync(full, fixed);
  }
}

fs.rmSync(coverageTmpDir, { recursive: true, force: true });
fs.mkdirSync(coverageTmpDir, { recursive: true });

const testExitCode = run(process.execPath, ["./out/test/runTest.js"], {
  env: { ...process.env, NODE_V8_COVERAGE: coverageTmpDir },
});

normalizeDriveLetterCasing(coverageTmpDir);

const c8Bin = path.join(root, "node_modules", "c8", "bin", "c8.js");
const reportArgs = [
  c8Bin,
  "report",
  `--temp-directory=${coverageTmpDir}`,
  `--reports-dir=${reportsDir}`,
  "--reporter=text",
  "--reporter=html",
  "--reporter=json-summary",
  "--all",
  `--include=${INCLUDE}`,
  ...EXCLUDES.map((p) => `--exclude=${p}`),
];
const reportExitCode = run(process.execPath, reportArgs);

console.log(`\nHTML report: ${path.join(reportsDir, "index.html")}`);

process.exit(testExitCode !== 0 ? testExitCode : reportExitCode);
