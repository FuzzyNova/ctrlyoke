/**
 * CtrlyokeCliPath — puts this host's own `ctrlyoke` launcher on `PATH` for the
 * processes ctrlyoke spawns.
 *
 * Both the VSIX and the npm package ship launcher shims in `<packageRoot>/bin`
 * (`ctrlyoke`, `ctrlyoke.cmd`, `ctrlyoke-mcp`, `ctrlyoke-mcp.cmd`) that run the
 * sibling `out/cli.js` / `out/mcp-server.js`. The host registers that directory
 * once at startup; every harness spawn then prepends it, so an agent running
 * `ctrlyoke append` mid-run reaches the same ctrlyoke version that launched it
 * rather than whatever copy happens to be first on the user's PATH.
 *
 * Node-only: no `vscode` import, so the CLI and MCP bundles can use it.
 * See dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.1 and §3.4.
 */

import * as fs from "fs";
import * as path from "path";

/** Directory under the package root that holds the launcher shims. */
export const CTRLYOKE_BIN_DIRNAME = "bin";

/** Bundle output directory that `cli.js`/`extension.js` live in. */
const BUNDLE_OUT_DIRNAME = "out";

/** POSIX shim filenames; each has a `.cmd` sibling for Windows. */
export const CTRLYOKE_POSIX_SHIMS = ["ctrlyoke", "ctrlyoke-mcp"] as const;

/** Canonical spelling of the PATH environment variable. */
const PATH_ENV_KEY = "PATH";

let _binDirectory: string | undefined;

/**
 * Package root for a bundled entry file. Every ctrlyoke bundle lives at
 * `<packageRoot>/out/<entry>.js`; unbundled callers (tests) get the entry's
 * own directory back.
 */
export function resolvePackageRootFromEntry(entryFile: string): string {
  const entryDir = path.dirname(entryFile);
  return path.basename(entryDir).toLowerCase() === BUNDLE_OUT_DIRNAME
    ? path.dirname(entryDir)
    : entryDir;
}

/** `<packageRoot>/bin`. */
export function resolveCtrlyokeBinDirectory(packageRoot: string): string {
  return path.join(packageRoot, CTRLYOKE_BIN_DIRNAME);
}

/**
 * Register this host's launcher directory. Ignored when the directory does not
 * exist, so a build without shims never puts a dead entry on PATH.
 */
export function registerCtrlyokeBinDirectory(packageRoot: string): void {
  const binDirectory = resolveCtrlyokeBinDirectory(packageRoot);
  _binDirectory = fs.existsSync(binDirectory) ? binDirectory : undefined;
}

/** The registered launcher directory, if any. */
export function getCtrlyokeBinDirectory(): string | undefined {
  return _binDirectory;
}

/** Test hook: forget the registered directory. */
export function resetCtrlyokeBinDirectory(): void {
  _binDirectory = undefined;
}

/**
 * The key `env` uses for PATH. Windows environment keys are case-insensitive
 * but a spread `process.env` is a plain object, so `Path` and `PATH` are
 * different properties there; reuse whichever spelling is already present.
 */
export function findPathKey(env: NodeJS.ProcessEnv): string {
  return (
    Object.keys(env).find((key) => key.toUpperCase() === PATH_ENV_KEY) ??
    PATH_ENV_KEY
  );
}

/**
 * Copy of `env` with `directory` first on PATH. An existing entry for the same
 * directory is moved to the front rather than duplicated.
 */
export function prependToPath(
  env: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const delimiter = platform === "win32" ? ";" : ":";
  const normalize = (entry: string) =>
    platform === "win32" ? entry.toLowerCase() : entry;
  const pathKey = findPathKey(env);
  const existing = (env[pathKey] ?? "")
    .split(delimiter)
    .filter(
      (entry) => entry.length > 0 && normalize(entry) !== normalize(directory)
    );
  return { ...env, [pathKey]: [directory, ...existing].join(delimiter) };
}

/**
 * Copy of `env` with the registered launcher directory first on PATH, or an
 * unchanged copy when none is registered.
 */
export function withCtrlyokeBinOnPath(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return _binDirectory ? prependToPath(env, _binDirectory) : { ...env };
}

/**
 * Restore the POSIX executable bit on the shims. A VSIX does not reliably
 * carry file modes, and an unexecutable shim reads as "command not found" to
 * the agent. Best effort; a no-op on Windows.
 */
export function ensureCtrlyokeShimsExecutable(binDirectory: string): void {
  if (process.platform === "win32") {
    return;
  }
  for (const name of CTRLYOKE_POSIX_SHIMS) {
    const shim = path.join(binDirectory, name);
    try {
      const mode = fs.statSync(shim).mode;
      if ((mode & 0o111) !== 0o111) {
        fs.chmodSync(shim, mode | 0o755);
      }
    } catch {
      // Missing or read-only install: nothing useful to do.
    }
  }
}
