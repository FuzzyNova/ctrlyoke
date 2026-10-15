#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnShimSync } from "./spawn-windows-shim.mjs";
import { restorePackageJson } from "./strip-dev-commands.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backupPath = path.join(repoRoot, "package.json.backup");

try {
  const result = spawnShimSync("vsce", ["package"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Failed to package extension: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (existsSync(backupPath)) {
    try {
      restorePackageJson();
    } catch (error) {
      console.error(`Failed to restore package.json: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
