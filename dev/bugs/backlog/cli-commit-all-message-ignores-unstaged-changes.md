# `ctrlyoke commit --all` commits changes the generated message never saw

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli)
- **Area:** `src/cli.ts` (commit command, ~2592), `src/cli/CommitCommand.ts`, `src/git/GitCommitter.ts`, `src/git/CommitMessageGenerator.ts` (`getDiff`)
- **Severity:** medium

## Symptom

`ctrlyoke commit --all` is documented as "Stage all changes before committing
(including unstaged and untracked files)". But the message is generated from
`getDiff`, which returns **only** `git diff --cached` whenever anything is already
staged. `--all` then runs `git add .` and commits everything, so the commit
contains unstaged and untracked changes the message doesn't describe.

Also, `GitCommitter.commit` runs `git add .` in the CLI's working directory, so
with `--cwd <subdir>` it stages only that subtree, while the fallback diff used for
the message (`git diff`, `git ls-files --others`) covers the whole repo (or only the
subtree for `ls-files`). The message and the commit can disagree in that direction
too.

## Steps to Reproduce

1. In a repo: stage a change to `a.ts`, leave `b.ts` modified (unstaged), and add
   an untracked `c.ts`.
2. `ctrlyoke commit --all --yes` (with any cheap harness).
3. The generated message only talks about `a.ts`; `git show --stat HEAD` lists
   `a.ts`, `b.ts` and `c.ts`.

## Root Cause

`src/cli.ts` calls `generator.getDiff(workingDir)` before staging, and
`CommitMessageGenerator.getDiff` returns early with the staged diff when it's
non-empty (`CommitMessageGenerator.ts` ~190–208). `commitGeneratedChanges`
(`src/cli/CommitCommand.ts`) then calls `GitCommitter.commit(..., { addAll: true })`,
which runs `git add .` (`GitCommitter.ts` ~16–18) — after the message is already
written. No test covers `--all` (`src/test/unit/CliCommitCommand.test.ts`).

## Suggested Fix

When `--all` is set, stage first, from the repository top level
(`git add -A` run in the `rev-parse --show-toplevel` directory, or
`git add -A -- :/`), and only then call `getDiff`, which will now see everything as
staged. Stage only after the harness/secret preflight has passed if staging has to
be undone on abort, or state in `--help` that `--all` stages before generating.
Alternatively give `getDiff` an `includeUnstaged` option that combines staged,
unstaged and untracked diffs. Make `GitCommitter`'s `addAll` stage the whole repo
(`-A` from the toplevel) so the commit and the message cover the same set. Unit
test: staged `a`, unstaged `b`, untracked `c`, `--all` → the diff handed to
`generateMessage` contains all three.
