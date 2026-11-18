# WorktreeUtils placement test needs symlink privilege on Windows

- **Found:** 2026-11-15 by the orchestrator review of session-control Stage 1 (`npm test` on
  Windows 11 without Developer Mode)
- **Area:** `src/test/unit/WorktreeUtils.test.ts` (`guards planned path-form directories against checkout and worktree placement`, line ~320)
- **Resolution:** fixed in this commit

The Windows test uses a directory junction, which `resolveThroughNearestExistingAncestor`
follows through `fs.realpath`; cleanup uses `removeTempDir` to unlink the junction before
recursing, leaving the checkout target intact.

## Symptom

```
Error: EPERM: operation not permitted, symlink '…\repo' -> '…\checkout-link'
```

The test fails before it reaches any assertion about worktree placement.

## Steps to Reproduce

1. On Windows, with Developer Mode off and a non-elevated shell, run
   `npm run test:extension -- WorktreeUtils`.
2. The test above fails with `EPERM` from `fs.symlink`.

## Root Cause

The test creates a directory symlink with `fs.symlink(source, symlinkParent, "dir")`. Windows
only allows that with the create-symlink privilege (Developer Mode or an elevated process).
Other tests in this tree use a junction on Windows instead, which needs no privilege
(`src/test/contextExpander.test.ts`: `process.platform === "win32" ? "junction" : "dir"`).

## Suggested Fix

Use `"junction"` on win32 for this directory link, as `contextExpander.test.ts` does, and
confirm the placement guard resolves junctions the same way (it should, through `realpath`).
Clean it up through `removeTempDir`, which unlinks links before recursing.
