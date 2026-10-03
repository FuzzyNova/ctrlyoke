import { createHash } from "node:crypto";
import * as path from "node:path";

/**
 * Single source of truth for Windows path-casing semantics.
 *
 * Windows filesystems are case-insensitive, so `c:\dev\ctrlyoke\x.ts` and
 * `C:\DEV\ctrlyoke\X.TS` name the same file. Two things follow, and this module
 * owns both so they stop being re-derived per call site:
 *
 * 1. **Comparison must case-fold on win32.** ctrlyoke receives paths from
 *    sources that disagree about casing — VS Code normalizes drive letters to
 *    lowercase (`Uri.fsPath` is documented to yield `c:/other`), while Node's
 *    `process.cwd()`, `os.tmpdir()`, git, and harness CLI output all report
 *    OS-native casing (`C:\...`). A case-sensitive comparison between the two
 *    produces false "outside the workspace" denials.
 *
 * 2. **Paths handed to external processes need a canonical drive letter.**
 *    Some tools key internal caches off the path string and treat `c:` and `C:`
 *    as different roots. Vite/Vitest is the known case: spawning with a
 *    lowercase-drive `cwd` makes it resolve the `vitest` package under a second
 *    module-cache key, so every test file imports a duplicate copy with no
 *    runner attached and fails at `describe()` with "Vitest failed to find the
 *    runner". `c8` has the same sensitivity (see `test.instructions.md`).
 *
 * Uses only Node built-ins so it is safe for the CLI bundle, the MCP server,
 * and anything else that must stay `vscode`-free.
 */

function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Fold a path into its comparison form: lowercase on win32 (matching the
 * filesystem's own case-insensitivity), unchanged elsewhere.
 *
 * Use this only to compare or to build a lookup key — never to derive a path
 * that will be shown to a user or handed to another process, because the folded
 * form loses the original casing.
 */
export function foldPathForCompare(value: string): string {
  return isWindows() ? value.toLowerCase() : value;
}

/** Hash a resolved path using the filesystem's path comparison semantics. */
export function hashPathForCompare(value: string): string {
  return createHash("sha256")
    .update(foldPathForCompare(path.resolve(value)))
    .digest("hex");
}

/**
 * Compare two already-resolved absolute paths for "names the same location",
 * using filesystem semantics: case-insensitive on win32, case-sensitive
 * elsewhere. Prefer this over `===` for any path equality check.
 */
export function pathsEqual(a: string, b: string): boolean {
  return foldPathForCompare(a) === foldPathForCompare(b);
}

/**
 * Uppercase a leading Windows drive letter (`c:\dev` → `C:\dev`), matching the
 * casing Node and the Windows shell report. No-op on non-Windows platforms and
 * on paths that are not drive-rooted (UNC, relative, POSIX).
 *
 * Apply this at the boundary where a path leaves ctrlyoke for an external
 * process — see the `cwd` normalization in `CliProcessManager.spawn` and
 * `PtyProcessManager`. Do **not** apply it to paths used for internal
 * comparison or persistence: VS Code re-lowercases the drive on every `Uri`
 * round-trip, so uppercase is not a stable internal form. Comparison is
 * `pathsEqual`/`isPathWithinDirectory`'s job instead.
 */
export function canonicalizeDriveLetter(value: string): string {
  if (!isWindows()) {
    return value;
  }
  return value.replace(
    /^([a-z]):([\\/])/,
    (_match, letter: string, separator: string) =>
      `${letter.toUpperCase()}:${separator}`
  );
}

/**
 * Lowercase a leading Windows drive letter (`C:\dev` → `c:\dev`).
 *
 * This is the *serialization* counterpart to {@link canonicalizeDriveLetter},
 * and the two deliberately disagree on direction. Use this one when a path is
 * written into a file that gets diffed or committed — VS Code reports uppercase
 * from GUI launches and lowercase from CLI launches, so picking one keeps the
 * generated content stable. Unlike the others here it is **not** platform-gated:
 * a tracked file must serialize identically on every OS.
 */
export function lowercaseDriveLetter(value: string): string {
  return value.replace(
    /^([A-Za-z]):/,
    (_match, letter: string) => `${letter.toLowerCase()}:`
  );
}

/**
 * Convenience for the spawn/PTY boundary: canonicalize an optional `cwd`,
 * passing `undefined` through so callers can keep their `?? fallback` chains.
 */
export function canonicalizeSpawnCwd(
  cwd: string | undefined
): string | undefined {
  return cwd === undefined ? undefined : canonicalizeDriveLetter(cwd);
}
