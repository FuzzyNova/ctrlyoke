import * as path from "path";
import { foldPathForCompare } from "./PathCasing";

/**
 * Returns true if `candidate` is equal to or a descendant of `directory`.
 * Both paths must already be resolved (e.g. via `path.resolve`/`fs.realpath`)
 * before calling — this only compares string prefixes.
 *
 * Using `path.sep` prevents sibling-prefix bypass attacks where a path like
 * `C:\dev\ctrlyoke-evil` would incorrectly match directory `C:\dev\ctrlyoke`.
 *
 * Comparison case-folds on win32 (see `PathCasing.foldPathForCompare`), because
 * Windows filesystems are case-insensitive and ctrlyoke routinely compares a
 * VS Code-sourced path (lowercase drive letter) against a Node- or git-sourced
 * one (OS-native casing). These are allowlist checks, so case-sensitivity here
 * only ever produced false denials — never false grants — and the sibling-prefix
 * guard below is unaffected by folding.
 */
export function isPathWithinDirectory(
  candidate: string,
  directory: string,
  pathImplementation: Pick<typeof path, "sep"> = path,
  platform: NodeJS.Platform = process.platform
): boolean {
  const foldedCandidate = foldPathForCompare(candidate, platform);
  const foldedDirectory = foldPathForCompare(directory, platform);
  const directoryPrefix = foldedDirectory.endsWith(pathImplementation.sep)
    ? foldedDirectory
    : foldedDirectory + pathImplementation.sep;
  return (
    foldedCandidate === foldedDirectory ||
    foldedCandidate.startsWith(directoryPrefix)
  );
}

/**
 * Returns true if `candidate` is equal to or a descendant of any directory in
 * `directories`. Use this for multi-root trust boundaries (e.g. every folder
 * of an open multi-root workspace), rather than checking a single root.
 */
export function isPathWithinAnyDirectory(
  candidate: string,
  directories: readonly string[]
): boolean {
  return directories.some((directory) =>
    isPathWithinDirectory(candidate, directory)
  );
}
