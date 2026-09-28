# Per-prompt workspace snapshot misses deleted files, files in new folders, staged renames and non-ASCII paths

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/utils/WorkspaceSnapshotService.ts`
- **Resolution:** fixed in this commit

## Symptom

The git-strategy snapshot taken before and after each prompt silently drops several kinds of
change, so they never appear in the step's changed-files list, prompt history or undo:

| Change during the prompt (clean repo before) | Recorded | Expected |
|---|---|---|
| Delete a tracked file `tracked.txt` | nothing | `deleted tracked.txt` |
| Create `newdir/a.ts` in a new folder | nothing | `created newdir/a.ts` |
| `git mv old.txt new.txt` | nothing | deleted plus created (or a rename) |
| Modify committed `café.txt` | nothing | `modified café.txt` |
| Create and commit `naïve.txt` | `created "na/303/257ve.txt"` | `created naïve.txt` |

## Steps to Reproduce

In a temp git repo with committed `tracked.txt`, `old.txt` and `café.txt`: call
`captureWorkspaceState(dir, "git")`, perform one action from the table, capture again, then run
`computeSnapshotChanges(before, after)`. Each case returns the "Recorded" column.

## Root Cause

`captureSegment` (around lines 645-700) runs `git status --porcelain` without `-z` or
`--untracked-files=all`, then records only paths it can read from disk:

- A deleted file (` D`/`D `) can't be read, so `readFileForSnapshot` returns null and the entry
  is skipped. The file was clean beforehand, so it isn't in the "before" map either, and no
  deletion is computed.
- A new folder is reported as a single `?? newdir/` line, which is a directory and is skipped.
- A staged rename yields the path text `old.txt -> new.txt`, which doesn't exist.
- Git C-quotes non-ASCII paths (`"caf\303\251.txt"`). The code strips the quotes but never decodes
  the octal escapes, then turns every `\` into `/`, producing `caf/303/251.txt`.

`getCommitRangeChanges` (around lines 461-487) uses `--name-status` without `-z` and has the same
quoting problem for files committed during the prompt.

## Suggested Fix

Use `git status --porcelain=v1 -z --untracked-files=all` and `--name-status -z`, parse NUL-separated
records, and take the second path for `R`/`C` entries. Record deleted entries as `deleted`, with
the content to restore read from `HEAD` (`git show HEAD:<path>`). Reuse an existing NUL-safe
porcelain parser if one exists (the hosted SCM status fix, `hosted-scm-status-keeps-git-quoted-paths`,
solved the same class of problem elsewhere) rather than adding another. Add tests against a real temp
repo for each row of the table.
