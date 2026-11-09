# Relative path escape checks misclassify `..`-prefixed child names

- **Found:** 2026-11-08 by smell-hunt
- **Area:** `src/utils/PathSecurity.ts` and callers of `path.relative`
- **Resolution:** fixed in this commit

## Symptom

Paths inside a root whose next segment begins with two dots, such as
`..cache/guide.md`, were treated as outside the root. Separately, two completion
checks omitted `path.isAbsolute(relative)`, the form returned by `path.relative`
for Windows paths on another drive.

## Steps to Reproduce

1. Rebase a workflow reference to a file under a workspace child named `..cache`.
2. Observe the path fall back to an absolute path instead of remaining
   workspace-relative.
3. On Windows, compare roots on different drives; `path.relative` returns an
   absolute path, which must be classified as escaping.

## Root Cause

Several callers used `relative.startsWith("..")`, which also matches ordinary
child names beginning with `..`. Other callers copied the separator-aware
check but omitted the absolute-path case. `RegexSymbolIndex` already had a
realpath containment check that rejected cross-drive results; its lexical
check now uses the shared predicate so both checks agree. The completion
helper's path selection had no equivalent realpath check.

## Suggested Fix

Use `relativePathEscapes` from `PathSecurity.ts` for native `path.relative`
results. Keep each caller's separate policy for an empty relative path.
