import * as path from "path";

/**
 * Returns true if `candidate` is equal to or a descendant of `directory`.
 * Both paths must already be resolved (e.g. via `path.resolve`/`fs.realpath`)
 * before calling — this only compares string prefixes.
 *
 * Using `path.sep` prevents sibling-prefix bypass attacks where a path like
 * `C:\dev\ctrlyoke-evil` would incorrectly match directory `C:\dev\ctrlyoke`.
 */
export function isPathWithinDirectory(
  candidate: string,
  directory: string
): boolean {
  return (
    candidate === directory || candidate.startsWith(directory + path.sep)
  );
}
