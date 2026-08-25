#!/usr/bin/env node
// Builds a production .vsix and installs it into the local `code` CLI's
// VS Code, without touching any running window. Reloading the extension
// host (Developer: Reload Window) or restarting VS Code is deliberately
// left to you — either can kill a workflow that's actively running in your
// daily-driver window, so this script never does it automatically. See
// dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`Failed to run '${command}': ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const pkg = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8")
);
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const vsixPath = path.join(repoRoot, vsixName);

run("npm", ["run", "package"]);
run("code", ["--install-extension", vsixPath, "--force"]);

console.log(
  `\nInstalled ${vsixName}. VS Code won't pick up the new code until the ` +
    "extension host reloads — run \"Developer: Reload Window\" or restart " +
    "VS Code yourself once nothing is actively running in that window."
);
