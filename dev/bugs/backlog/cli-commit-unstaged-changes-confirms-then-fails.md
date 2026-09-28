# `ctrlyoke commit` with only unstaged changes asks to commit, then always fails

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/cli.ts`, `src/git/GitCommitter.ts`
- **Severity:** low

## Symptom

When nothing is staged but tracked files are modified, `ctrlyoke commit` generates a message from
the unstaged diff (paying for the AI call), prints a "Stage files before committing" note, and
then still asks `Commit with this message? [y/N]` (or skips the question with `--yes`). Answering
yes runs `git commit -m <msg>` with nothing staged, which fails:

```
Error: Command failed: git commit -m msg
```

The command exits 1, and git's real reason ("no changes added to commit", printed on stdout) is not
shown.

## Steps to Reproduce

1. In a temp repo, modify a tracked file without staging it.
2. `ctrlyoke commit --yes` (any cheap harness/model).
3. A message is generated, then the commit fails with `Command failed: git commit -m …`.

## Root Cause

`getDiff` returns `staged: false` for the unstaged fallback. The CLI commit flow (around lines
2607-2629 of `src/cli.ts`) notes this but still calls `committer.commit(message, workingDir)`
without `addAll`, so git has nothing to commit. `GitCommitter` supports `addAll`, but no caller uses
it.

## Suggested Fix

When the diff is not staged, either (a) skip the confirmation, print the generated message and a
clear "nothing staged; stage files and re-run, or use --all" message, and exit with the usage exit
code, or (b) add an explicit `--all` flag that passes `addAll`. Don't prompt to commit something
that can't be committed. Also include git's stdout in the error when a commit fails. Add a CLI
test with an unstaged-only repo (stub the message generation; never call a real harness).
