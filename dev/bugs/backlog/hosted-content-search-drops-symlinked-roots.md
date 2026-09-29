# Hosted content search returns nothing when a workspace root is reached through a symlink

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/server/HostedWorkspaceViewerService.ts` (`isSearchFileWithinTrustedRoots`)
- **Severity:** medium

## Symptom

If a trusted root's path goes through a symlink or junction, content search silently returns no
results, although reading the same files works. Examples: a junction or symlinked project folder,
macOS `/tmp` → `/private/tmp`, a symlinked home directory, 8.3 short paths.

## Steps to Reproduce

Verified by an agent: `real/notes.txt` contains `needle`, and `link` is a junction to `real`.
Searching for `needle` with root `real` finds 1 match. With root `link` it finds `[]`, although
`readFile("notes.txt")` succeeds.

## Root Cause

`isSearchFileWithinTrustedRoots` (around line 944) compares `fs.promises.realpath(file)` against
the non-realpath'd `this.trustedRoots`, so every candidate fails containment and is dropped.
`safeResolve` already does this correctly by comparing against `this.realpathsOf(trustedRoots)`.

## Suggested Fix

Compare against the realpath'd roots, reusing `realpathsOf` or the same cached helper
`safeResolve` uses. Add a regression test with a junction (Windows) or symlink root that asserts
search finds the match.
