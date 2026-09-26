# Advisory directory claims do not protect child paths due to missing directory containment in pathsOverlap

- **Found:** 2026-09-26 by step 1 (antigravity-cli / gemini-3.8-flash-medium) during coordination test workflow
- **Area:** `src/core/orchestration/ExecutionRootCoordination.ts` (`pathsOverlap`, `globMatches`)
- **Severity:** medium: advisory claims on directories silently permit concurrent conflicting edits to descendant files

## Symptom

When an agent claims a directory path (e.g., `"dev/bugs"` or `"src/core"`), another concurrent agent can subsequently claim any file within that directory (e.g., `"dev/bugs/README.md"` or `"src/core/WorkflowOrchestrator.ts"`). The coordination server grants both claims without conflict or warning.

Conversely, if an agent has claimed a specific file, another agent can claim the enclosing directory without encountering a denial.

This was observed live during the coordination workflow: Step 1 claimed `"dev/bugs"` and `"dev/bugs/backlog"`, but Step 0's subsequent claim for `"dev/bugs/README.md"` was granted without conflict.

## Steps to Reproduce

1. Agent A calls `claim_paths` with `{"paths": ["dev/bugs"]}`.
2. The claim is granted.
3. Agent B calls `claim_paths` with `{"paths": ["dev/bugs/README.md"]}`.
4. Expected: Agent B's claim is denied because `"dev/bugs/README.md"` resides within Agent A's claimed path.
5. Actual: Agent B's claim is granted; both participants now hold overlapping claims.

## Root Cause

In `src/core/orchestration/ExecutionRootCoordination.ts:122-129`:

```typescript
function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return (
    globMatches(left, right) ||
    globMatches(right, left) ||
    globSamplesOverlap(left, right)
  );
}
```

When neither `left` nor `right` contains glob wildcards (`*`, `?`, `[`), `hasMagic()` returns `false`. `globMatches()` falls back immediately to strict literal string equality (`pattern === candidate`).

Because there is no hierarchical prefix check (e.g., checking if one path is a parent directory of another), a bare folder path only conflicts with that exact string, providing zero concurrency protection for child files.

## Suggested Fix

1. Enhance `pathsOverlap()` to account for directory containment:
   Normalize paths (stripping redundant trailing slashes) and check whether `left` is a prefix directory of `right` (`right.startsWith(left + "/")`) or vice versa, in addition to glob overlap checks.
2. In `claim_paths`, document whether directory claims are permitted and whether callers should explicitly use recursive wildcards (`dir/**`). If bare directory names are disallowed, validate and return a helpful diagnostic error rather than silently granting a no-op claim.

## Planning Note (2026-09-26)

This bug and `coordination-overlapping-wildcard-claims-granted.md` share one root cause: `pathsOverlap()`
guesses overlap from a few sample strings instead of computing it. Fix both in one change. Replace the
sample heuristic with a real segment-wise glob intersection test. Also treat every claim `P` as covering
`P` itself and everything under `P/`, so a bare directory claim protects its descendants and still
interacts correctly with wildcard claims (for example, `dev/bugs` vs `dev/*/README.md`). Bare
directory claims stay permitted, and `claim_paths` documents that they are recursive.
