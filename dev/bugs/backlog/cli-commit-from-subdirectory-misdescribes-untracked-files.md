# `ctrlyoke commit` from a repo subdirectory describes different untracked files than it commits

- **Found:** 2026-10-03 by the more-bug-backlog2 workflow final step (claude-cli)
- **Area:** `src/git/CommitMessageGenerator.ts` (`getDiff`, untracked-file section), `src/git/GitCommitter.ts`, `src/cli/CommitCommand.ts`
- **Severity:** medium

## Symptom

When `ctrlyoke commit` runs with a `cwd` inside a repository subdirectory (the
shell's cwd, or `--cwd sub/`), the diff it gives the AI to write the commit
message disagrees with what it actually commits:

- **Untracked files outside the subdirectory are missing from the message
  input.** `git ls-files --others` limits its output to the current
  directory. With `--all`, `GitCommitter` then runs `git add -A` at the
  repository top level, so those files are committed but never mentioned in
  the message.
- **Untracked files inside the subdirectory get the wrong path.** `ls-files`
  prints paths relative to `cwd` (`sub-new.txt`), so the synthesized header
  reads `diff --git a/sub-new.txt b/sub-new.txt`. The tracked hunks from
  `git diff` are relative to the repository root (`sub/t.txt`), so the two
  halves of the diff use different path bases.

The resolution of `dev/bugs/implemented/cli-commit-all-message-ignores-unstaged-changes.md`
promised that the commit "includes the same repository scope when `--cwd`
points into a subdirectory". That holds for staging (`git add -A` at
`--show-toplevel`), but not for the untracked part of the message input.

## Steps to Reproduce

1. In a temp repo, commit `sub/t.txt`, then modify it.
2. Create untracked `root-new.txt` at the repo root and `sub/sub-new.txt`.
3. From `sub/`:
   - `git diff HEAD --name-only` prints `sub/t.txt` (repo-wide, root-relative).
   - `git ls-files --others --exclude-standard` prints only `sub-new.txt`
     (cwd-scoped, cwd-relative).
4. Run `ctrlyoke commit --all` from `sub/`. The generated message input has no
   `root-new.txt` and labels the other file `a/sub-new.txt`, yet the commit
   contains `root-new.txt` and `sub/sub-new.txt`.

## Root Cause

In `CommitMessageGenerator.getDiff`, the untracked section (~lines 361-383)
runs `git ls-files --others --exclude-standard -z` with `{ cwd }` and joins
each result with `path.join(cwd, filePath)`. Unlike `git diff`, `ls-files` is
both pathspec-scoped and path-relative to the current directory. The SCM and
hosted callers pass a repository root as `cwd`, so only the CLI, which passes
`--cwd`/`process.cwd()`, is affected.

## Suggested Fix

- In `getDiff`, resolve the repository top level once
  (`git rev-parse --show-toplevel`, ideally through an existing `GitUtils`
  helper rather than a new copy).
- Run the `ls-files` call there and resolve untracked paths against it, so the
  synthesized headers are root-relative like the tracked hunks. Alternatively,
  pass `--full-name` plus `:/` as the pathspec and join with the top level.
- Add a unit test with a subdirectory `cwd` covering both an untracked file
  outside the subdirectory and one inside it, asserting root-relative headers.
