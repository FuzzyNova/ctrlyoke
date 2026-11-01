# `~diff` is described as "all uncommitted changes" but attaches only unstaged changes

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/completions/CompletionCore.ts`, `src/utils/ContextExpander.ts`, `docs/guide/prompt-editor.md`
- **Resolution:** fixed in this commit

## Symptom

`~diff` runs `git diff` (unstaged working-tree changes, plus untracked file
names), but several user-facing strings say it covers all uncommitted work:

- `~` completion detail: "All uncommitted changes" (`src/completions/CompletionCore.ts:468`)
- Empty result text sent to the AI: "No uncommitted changes in working tree."
  (`src/utils/ContextExpander.ts:865`, duplicated at `src/extension.ts:1402`)
- `docs/guide/prompt-editor.md:43`: "`diff` (uncommitted changes)"

`docs/workflows/context-files.md` correctly says "unstaged working-tree
changes", so the docs contradict each other.

## Steps to Reproduce

1. Stage a change and leave nothing unstaged.
2. Run a prompt containing `~diff`.
3. The AI receives "No uncommitted changes in working tree." although there is
   staged, uncommitted work, so it may conclude there is nothing to review.

## Root Cause

`buildWorkingTreeDiffArgs` (`src/utils/GitUtils.ts:1181`) builds a plain
`git diff`, which excludes the index. The labels were written as if it diffed
against `HEAD`.

## Suggested Fix

Keep the behavior (changing what `~diff` attaches would be a user-visible
contract change) and fix the wording: completion detail "Unstaged changes"
(keep "uncommitted" in filterText so typing it still finds the item), the empty
text "No unstaged changes in working tree (staged changes are attached with
~staged).", single-sourced in one constant used by both `ContextExpander.ts`
and `extension.ts`, and the prompt-editor docs row. Update the tests that
assert the old strings.
