# `~diff`, `~staged`, and commit-message generation output the user's `diff.external` tool instead of a patch

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced against a throwaway repo with a fake external diff tool
- **Area:** `src/utils/GitUtils.ts` (`getWorkingTreeDiff` ~661, `getStagedDiff` ~697), `src/git/CommitMessageGenerator.ts` (~231, ~282, ~302, ~312), `src/utils/ContextExpander.ts` (~812)
- **Resolution:** fixed in this commit

## Symptom

If a user has `diff.external` configured, e.g.
`git config --global diff.external difft` (the documented difftastic setup):

- the `~diff` / `~staged` attachments contain the external tool's display
  output, not a unified diff;
- commit-message generation sends that display output to the AI and stores it
  as the record's diff.

With a fake tool, `getStagedDiff` returned
`" f.txt | 2 +-\n…\n\nEXTERNAL-DIFF-TOOL OUTPUT for f.txt\n"`. Adding
`--no-ext-diff` gives a proper patch.

Related cosmetic bug in the same code: the `~<sha>` attachment title is built
from the first line of `git show --stat -p` output, which is always
`commit <full sha>`. The title therefore reads
`Commit 41866a0: commit 41866a0ebbe0…` and never shows the subject.

## Root Cause

Porcelain `git diff` uses `diff.external` unless `--no-ext-diff` is given.
`getDiffBetweenRefs` (`GitUtils.ts` ~645) and `HostedWorkspaceViewerService`
already pass `--no-ext-diff`. The five call sites above don't.
(`--name-only`/`--name-status` calls are unaffected.)

## Suggested Fix

- Add `--no-ext-diff` to every patch-producing `git diff` invocation listed
  above. Consider also passing `--no-color` where `color.diff=always` could
  inject escapes. Grep `src/` once more for any other patch-producing
  `git diff`.
- For the commit title, take the subject from `getCommitInfo`
  (`GitUtils.ts` ~419, `%s`), or from a `--format` line, instead of the first
  output line.
- Tests: with `GIT_CONFIG_GLOBAL` (or a repo-local `diff.external`) pointing at
  a script that prints a sentinel, `getStagedDiff`/`getWorkingTreeDiff` return
  a unified diff without the sentinel; the commit reference title contains the
  commit subject.
