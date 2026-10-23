import * as path from "path";
import { promises as fs } from "fs";
import { foldPathForCompare } from "./PathCasing";

export interface RealpathContainmentResult {
  resolvedPath: string;
  allowed: boolean;
}

/**
 * Authorize filesystem references after resolving symlinks/junctions. Root
 * realpaths are cached for the lifetime of this checker so callers can share
 * one checker across all references in a prompt expansion.
 */
export class RealpathContainmentChecker {
  private readonly realRoots: Promise<string[]>;
  private readonly lexicalRoots: string[];

  constructor(roots: readonly string[]) {
    this.lexicalRoots = roots.map((root) => path.resolve(root));
    this.realRoots = Promise.all(
      roots.map(async (root) => {
        try {
          return path.resolve(await fs.realpath(root));
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
            return path.resolve(root);
          }
          throw error;
        }
      })
    );
  }

  async check(candidate: string): Promise<RealpathContainmentResult> {
    let resolvedPath: string;
    try {
      resolvedPath = path.resolve(await fs.realpath(candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        // Preserve the existing missing-file behaviour. A lexical in-root
        // missing path cannot expose content; its caller's stat/read keeps
        // producing the existing not-found skip. Traversal is still denied.
        return {
          resolvedPath: path.resolve(candidate),
          allowed: isPathWithinAnyDirectory(
            path.resolve(candidate),
            this.lexicalRoots
          ),
        };
      }
      throw error;
    }
    return {
      resolvedPath,
      allowed: isPathWithinAnyDirectory(resolvedPath, await this.realRoots),
    };
  }
}

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

const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Whether one path segment taken from untrusted input (a downloaded archive or
 * repository tree) is safe to create on every platform: not empty or `.`/`..`,
 * no separators, drive colons, wildcard or control characters, not a Windows
 * device name (`nul`, `con.txt`, …) and no trailing dot or space, which
 * Windows silently strips.
 */
export function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false;
  if (/[\\/:*?"<>|]/.test(segment) || CONTROL_CHAR_PATTERN.test(segment)) {
    return false;
  }
  if (/[. ]$/.test(segment)) return false;
  return !WINDOWS_RESERVED_NAME_PATTERN.test(segment.split(".")[0] ?? "");
}
