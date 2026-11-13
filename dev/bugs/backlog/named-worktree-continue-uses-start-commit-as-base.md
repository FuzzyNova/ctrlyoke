# Continuing a named-directory run turns the run's start commit into its comparison base

- **Found:** 2026-11-12 by the bug-hunt workflow's final step (claude-cli subagent), from code reading
- **Area:** `src/utils/WorktreeResolution.ts` (`recordedWorktreeConfigForContinue`)
- **Severity:** medium

## Symptom

After **Continue** on a run that used `worktree: { directory: … }`:

- the run file's `_runtime.worktree.comparisonBaseLabel` becomes a 40-character SHA;
- Settings → Worktrees shows `<branch> — N ahead, 0 behind <sha>`. For a run that had no
  `base`, it showed no divergence line before;
- a run that had `base: origin/main` switches its label and ahead/behind counts from
  `origin/main` to the old HEAD.

## Steps to Reproduce

1. Run a workflow with `worktree: { directory: bug-fix }` and no `base`.
2. Continue it.
3. Read `_runtime.worktree.comparisonBaseLabel` in the run file. It now holds a commit SHA.

## Root Cause

`recordedWorktreeConfigForContinue` passes `base: recorded.baseCommit`
(#selection:src/utils/WorktreeResolution.ts:127-133). `_runtime.worktree.baseCommit` is not
the authored base, though: `WorktreeManager` persists it as `HEAD` at run start
(`resolveCommit(executionCheckoutRoot, "HEAD")`, persisted in `persistRuntime` near the end
of the named resolution path). In named mode `options.base` also becomes
`comparisonBaseLabel`, so Continue relabels the comparison base as that SHA. The test
"continues a recorded named directory branch with current setup after defaults change" in
`src/test/unit/WorktreeResolution.test.ts` currently asserts this `base: "captured-base"`
value.

## Suggested Fix

Carry the recorded `comparisonBaseLabel`, not `baseCommit`, as `base`, and omit `base` when
none was recorded. If a deleted branch needs to be recreated from the old commit on
Continue, pass that through a separate option that doesn't double as the comparison base.
Update the existing test and add one for the no-base and `base: origin/main` cases.
