#!/usr/bin/env node
/**
 * Pulls the Vercel OIDC token the skills.sh snapshot needs into `.env.local`
 * (CHORES.md #7), then undoes Vercel's `.gitignore` edit.
 *
 * `vercel env pull` appends `.env*` to `.gitignore` whenever it can't find that
 * exact line. The repo already ignores `.env` and `.env.*`, and a later `.env*`
 * would cancel the `!.env.example` exception, so the line must not stay. This
 * restores `.gitignore` when the only change is added `.env*` lines; any other
 * change is left in place with a warning.
 *
 * Usage: npm run vercel:env-pull [-- <extra vercel env pull args>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GITIGNORE_PATH = resolve(REPO_ROOT, ".gitignore");
const ENV_FILE = ".env.local";
const VERCEL_ADDED_LINE = ".env*";

const readGitignore = () =>
  existsSync(GITIGNORE_PATH) ? readFileSync(GITIGNORE_PATH, "utf8") : null;

/** Lines of `text` without Vercel's line, ignoring blank-line and EOL differences. */
const withoutVercelLine = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== VERCEL_ADDED_LINE)
    .join("\n")
    .trimEnd();

const before = readGitignore();

const result = spawnSync(
  "vercel",
  ["env", "pull", ENV_FILE, "--yes", ...process.argv.slice(2)],
  {
    cwd: REPO_ROOT,
    stdio: "inherit",
    // The Vercel CLI is a .cmd shim on Windows, which needs a shell to run.
    shell: process.platform === "win32",
  }
);

const after = readGitignore();
if (before !== null && after !== null && after !== before) {
  if (withoutVercelLine(after) === withoutVercelLine(before)) {
    writeFileSync(GITIGNORE_PATH, before);
    console.log(`Reverted Vercel's "${VERCEL_ADDED_LINE}" line in .gitignore.`);
  } else {
    console.warn(
      "Warning: .gitignore changed in more ways than Vercel's " +
        `"${VERCEL_ADDED_LINE}" line, so it was left as is. Check git diff .gitignore.`
    );
  }
}

if (result.error) {
  console.error(`Failed to run vercel: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
