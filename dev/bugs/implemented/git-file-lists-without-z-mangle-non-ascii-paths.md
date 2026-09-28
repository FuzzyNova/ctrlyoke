# Commit-message diff and stash diff mangle non-ASCII file paths (git lists parsed without `-z`)

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/git/CommitMessageGenerator.ts`, `src/utils/GitUtils.ts`, `src/extension.ts`
- **Resolution:** fixed in this commit

## Symptom

Git C-quotes paths with non-ASCII characters (`café.txt` → `"caf\303\251.txt"`) unless `-z` is
used. Several git file lists are parsed from the quoted form:

- **Commit message generation.** With only an untracked `café.txt` in the repo,
  `new CommitMessageGenerator().getDiff(repo)` returns `null`, so the SCM button and
  `ctrlyoke commit` report "No changes detected". When other changes exist, the file's content is
  silently left out of the prompt.
- **Stash diff.** After stashing a change to `naïve.txt`, `getStashFiles(repo, 0)` returns
  `['"na\\303\\257ve.txt"']`, so `openNativeStashDiff` opens a nonexistent file instead of the
  stashed change.
- **`@git:diff` context.** `getWorkingTreeDiff` builds its untracked list from
  `git status --short`, so non-ASCII names appear quoted and escaped, and a new folder collapses to
  `newdir/` instead of listing its files.

## Steps to Reproduce

1. In a clean temp repo, create an untracked `café.txt` containing `hello`.
2. Call `new CommitMessageGenerator().getDiff(repo)`. It returns `null` instead of a new-file diff.

## Root Cause

- `CommitMessageGenerator.ts` (around lines 232-239): `git ls-files --others --exclude-standard`
  without `-z`. Reading the quoted name fails and the "skip unreadable files" catch swallows it.
- `GitUtils.getStashFiles` (around lines 600-613): `git stash show --name-only` without `-z`.
- `GitUtils.getWorkingTreeDiff` (around lines 524-534): `git status --short` without `-z` or
  `--untracked-files=all`.

## Suggested Fix

Add `-z` to each command and split on `\0` (plus `--untracked-files=all` for the status call),
through one shared NUL-list helper in `GitUtils` so the callers don't each reimplement splitting.
Add tests against a real temp repo with a non-ASCII file name for each function.
