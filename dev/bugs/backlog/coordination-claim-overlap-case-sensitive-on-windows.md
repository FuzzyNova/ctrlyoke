# Coordination claim overlap and release are case-sensitive on Windows

- **Found:** 2026-09-27 by step 0 (claude-cli) of the coordination test workflow
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts`
- **Severity:** medium

## Symptom

On Windows, two participants can both be granted claims on the same file by
spelling the path with different casing. NTFS is case-insensitive, so
`coordination-probe/r2/dir` and `Coordination-Probe/R2/DIR/x` name the same
directory tree, but `claim_paths` treats them as disjoint and grants both.

The same exact-string comparison affects `release_paths`: releasing a claim with
different casing from how it was claimed silently returns it under `notHeld`
instead of `released`.

## Steps to Reproduce

1. On Windows, from participant A (MCP), `claim_paths { "paths": ["coordination-probe/r2/dir"] }` → granted.
2. From participant B (skill CLI, same execution root),
   `claim_paths { "paths": ["coordination-probe/r2/dir/child.txt"] }` → correctly **denied**
   (directory containment works).
3. From participant B, `claim_paths { "paths": ["Coordination-Probe/R2/DIR/x"] }` → **granted**.
   Both claims now coexist in the scope snapshot, covering the same file on disk.

Reproduced live on 2026-09-27 against board seq 132 (A's claim) and seq 139 (B's
conflicting grant).

## Root Cause

`pathsOverlap()` (`ExecutionRootCoordination.ts:136`) normalizes separators,
duplicate slashes, `./` prefixes, and trailing slashes via `normalizeClaimPath()`
(`:146`), but never folds case. Literal glob tokens are then compared with
case-sensitive equality in `globPatternsOverlap`. `releasePaths()` (`:901`)
matches with `paths.includes(claim.path)`, also case-sensitive.

The repo already single-sources the platform rule in `src/utils/PathCasing.ts`
(`foldPathForCompare` — lowercase on win32, identity elsewhere), and that module
is explicitly dependency-free so the MCP server/CLI bundles can use it.

## Suggested Fix

- Apply `foldPathForCompare` to both sides inside `pathsOverlap` (after
  `normalizeClaimPath`), so literal segments and glob literals compare with
  filesystem semantics. Character-class ranges (`[A-Z]`) need the same fold on
  win32 or they will under-match.
- In `releasePaths`, compare `foldPathForCompare(normalizeClaimPath(...))` of the
  requested and held paths instead of `includes`.
- Keep the stored/displayed `claim.path` in its original casing — the fold is
  comparison-only, per `PathCasing.ts`'s own guidance.
- Add unit coverage that stubs `process.platform` to `win32` for both overlap and
  release, plus a POSIX case asserting case-sensitivity is preserved there.
