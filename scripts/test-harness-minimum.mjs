#!/usr/bin/env node

/**
 * Run the real-harness suite against each harness's `versionPolicy.minimum`.
 *
 * ctrlyoke finds harness CLIs through `PATH`, so instead of a sandbox (which
 * would need a fresh sign-in to every CLI on each run) this installs each npm
 * harness at its minimum into a gitignored prefix and puts that prefix's bin
 * directory first on `PATH`. The developer's existing sign-ins in `~/.copilot`,
 * `~/.claude`, `~/.codex`, `~/.qwen` and OpenCode's config directory keep
 * working. The suite's version report (`.ctrlyoke/logs/test-runs/harness-*.json`)
 * records `mode: "minimum"` and the versions that actually ran.
 *
 * Antigravity is not on npm and `agy update` cannot pick a version, so its
 * minimum is tested by hand; this run uses whatever `agy` is installed.
 *
 * An old CLI can rewrite config that a newer one wrote. `~/.codex/config.toml`
 * and `~/.qwen/settings.json` are backed up before the run and restored after.
 *
 * Usage:
 *   npm run test:harness:minimum                     (all harness test files)
 *   npm run test:harness:minimum -- --grep codex-cli (extra args go to mocha)
 *   node scripts/test-harness-minimum.mjs --install-only
 *
 * Run it whenever a minimum moves, and record the result in the CHANGELOG.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = join(ROOT_DIR, ".ctrlyoke", "harness-minimums");
const BIN_DIR = join(PREFIX, "node_modules", ".bin");
const require = createRequire(import.meta.url);

/** npm package of each harness that publishes its CLI to npm. */
const NPM_PACKAGES = {
  "copilot-cli": "@github/copilot",
  "claude-cli": "@anthropic-ai/claude-code",
  "codex-cli": "@openai/codex",
  "opencode-cli": "opencode-ai",
  "qwen-cli": "@qwen-code/qwen-code",
};

/** Config files an old CLI might rewrite, restored after the run. */
const BACKED_UP_CONFIGS = [
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
  join(homedir(), ".qwen", "settings.json"),
];

/** Keep each CLI at the installed version for the whole run. */
const NO_SELF_UPDATE_ENV = {
  DISABLE_AUTOUPDATER: "1", // Claude Code
  OPENCODE_DISABLE_AUTOUPDATE: "1",
};

function readMinimums() {
  const registryPath = join(ROOT_DIR, "out/core/HarnessCapabilityRegistry.js");
  if (!existsSync(registryPath)) {
    throw new Error(
      `${registryPath} not found. Run "npm run compile-tests" first.`
    );
  }
  const { HarnessCapabilityRegistry } = require(registryPath);
  return Object.fromEntries(
    HarnessCapabilityRegistry.getDocumentationFacts().harnesses.map((h) => [
      h.harnessId,
      h.versionPolicy.minimum,
    ])
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  return result.status ?? 1;
}

function installMinimums() {
  const minimums = readMinimums();
  const specs = Object.entries(NPM_PACKAGES).map(
    ([harnessId, pkg]) => `${pkg}@${minimums[harnessId]}`
  );
  mkdirSync(PREFIX, { recursive: true });
  const manifest = join(PREFIX, "package.json");
  const installed = existsSync(manifest)
    ? Object.entries(
        JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {}
      )
        .map(([pkg, version]) => `${pkg}@${version}`)
        .sort()
    : [];
  if (JSON.stringify(installed) === JSON.stringify([...specs].sort())) {
    console.log(`Harness minimums already installed in ${PREFIX}`);
    return;
  }
  console.log(
    `Installing harness minimums into ${PREFIX}:\n  ${specs.join("\n  ")}`
  );
  const status = run("npm", [
    "install",
    "--prefix",
    PREFIX,
    "--save-exact",
    "--no-audit",
    "--no-fund",
    ...specs,
  ]);
  if (status !== 0) {
    throw new Error(`npm install of the harness minimums failed (${status})`);
  }
}

function withBackups(fn) {
  const backups = BACKED_UP_CONFIGS.filter(existsSync).map((file) => {
    const backup = `${file}.ctrlyoke-minimum-backup`;
    copyFileSync(file, backup);
    return { file, backup };
  });
  try {
    return fn();
  } finally {
    for (const { file, backup } of backups) {
      copyFileSync(backup, file);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  installMinimums();
  if (args.includes("--install-only")) return 0;

  // Windows spells it `Path`; a second `PATH` key would leave the child with
  // whichever one it happens to read.
  const pathKey =
    Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";
  const env = {
    ...process.env,
    ...NO_SELF_UPDATE_ENV,
    [pathKey]: `${BIN_DIR}${delimiter}${process.env[pathKey] ?? ""}`,
    CTRLYOKE_HARNESS_VERSION_MODE: "minimum",
  };
  console.log(
    "Antigravity is not on npm: this run uses the installed agy. Test its minimum by hand."
  );
  // `pretest:harness:minimum` already compiled; --ignore-scripts skips
  // `pretest:harness` compiling a second time.
  return withBackups(() =>
    run("npm", ["run", "--ignore-scripts", "test:harness", "--", ...args], {
      env,
      cwd: ROOT_DIR,
    })
  );
}

process.exitCode = main();
