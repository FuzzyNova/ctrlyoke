# Commit-message diffs and `~diff`/`~staged` attachments contain ANSI color codes under `color.ui=always`

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against `out/`)
- **Area:** `src/git/CommitMessageGenerator.ts` (`gitDiffArgs` ~62-64), `src/utils/GitUtils.ts` (`getDiffBetweenRefs` ~1110, `getWorkingTreeDiff` ~1134, `getStagedDiff` ~1203, `getStashDiff` ~1258)
- **Severity:** medium

## Symptom

A user with `color.ui=always` or `color.diff=always` in their git config gets
ANSI escape sequences in every diff ctrlyoke reads through porcelain
`git diff`/`git stash show -p`:

- the diff sent to the AI for commit-message generation (`ctrlyoke commit`, SCM
  button) and the diff saved in its tracker record;
- `~diff`, `~staged` and stash attachments expanded into prompts.

Example output of `getDiff(repo)` after staging `a` → `b`:
`"\u001b[1mdiff --git a/f.txt b/f.txt\u001b[m\n…\u001b[31m-a\u001b[m\n\u001b[32m+\u001b[m\u001b[32mb\u001b[m\n"`.
The `--stat` summary in `getStagedDiff`/`getWorkingTreeDiff` is colored too.

## Steps to Reproduce

1. Scratch repo, `git config color.ui always`, commit `f.txt`, change and stage it.
2. `npm run compile:extension`; call `getDiff(repo)` from
   `out/git/CommitMessageGenerator.js` or `getStagedDiff(repo)` from
   `out/utils/GitUtils.js`.
3. **Actual:** output contains `\u001b[` sequences.
   **Expected:** a plain unified diff.

## Root Cause

`gitDiffArgs` and the `GitUtils` diff helpers add only
`GIT_DIFF_NO_EXT_DIFF_OPTION` (`GitUtils.ts:18`). None pass `--no-color`, so
`color.ui=always` overrides git's pipe detection. The external-diff fix
(`dev/bugs/implemented/git-diff-attachments-run-external-diff-tool.md`)
suggested also passing `--no-color`, but that was never done.

## Suggested Fix

Add a `GIT_DIFF_NO_COLOR_OPTION = "--no-color"` constant beside
`GIT_DIFF_NO_EXT_DIFF_OPTION` (or a shared array of both) and use it everywhere
`GIT_DIFF_NO_EXT_DIFF_OPTION` is used today, including `stash show -p`. Tests in
`src/test/unit/CommitMessageGenerator.test.ts` and
`src/test/unit/GitUtils.test.ts`: set repo-local `color.ui=always` and assert
there is no `\u001b` in the output.
