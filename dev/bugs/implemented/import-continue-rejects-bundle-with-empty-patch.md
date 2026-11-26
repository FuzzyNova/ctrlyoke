# `ctrlyoke import --continue` turns a bundle with no file changes into a view-only run

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/core/orchestration/RunChangesPlacer.ts` (`place`)
- **Resolution:** fixed in this commit

## Symptom

A run that made no file changes cannot be continued after it is imported. This
covers script-only runs, read-only reviews, and runs stopped before any edit.
The export reports `continuable: true` and `patch.files: 0`, and writes a
0-byte `changes.patch`. On import:

- `--changes checkout` (default) and `--changes worktree` exit `0` with
  `"continued": false`. The warning reads: `Workspace changes were not applied;
  the imported run is view-only. Command failed: git ... apply --index --3way
  -- .../changes.patch error: No valid patches in input (allow with
  "--allow-empty")`.
- `--changes skip` continues, but warns "The checkout does not appear to
  contain the exported changes". That is false, because there are no changes.

`docs/guide/export-import.md` makes a run view-only only when the base commit
is missing or the patch is *rejected*. An empty patch has nothing to reject.

## Steps to Reproduce

1. Create a git repo with one commit and `st2.ctrlyoke.yaml` holding four
   script steps: `false`, then three `echo` steps.
2. Run `ctrlyoke run st2.ctrlyoke.yaml`. It stops at step 1.
3. Run `ctrlyoke export --workflow <key> --run 1 --out /tmp/b2 --json`. It
   reports `continuable: true` and `patch.files: 0`.
4. Run `git clone <repo> ws4 && cd ws4 && ctrlyoke import /tmp/b2.ctrlyokerun --continue --json`.
5. Observe `"continued": false` with the warning above.

## Root Cause

`RunChangesPlacer.place()` always runs `git apply --index --3way` for
checkout and worktree placement (around line 160). For `skip` it runs
`git apply --check --reverse` (around line 140). It never checks for an empty
patch, and `git apply` rejects empty input.

## Suggested Fix

When the patch is empty (0 bytes or whitespace only, or the manifest's
`patch.files === 0`), treat placement as applied for checkout and worktree,
and skip the "does not appear to contain" warning for `skip`. Add a
`RunChangesPlacer`/importer unit test with an empty patch for all three
`--changes` modes.
