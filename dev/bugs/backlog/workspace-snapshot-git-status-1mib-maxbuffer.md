# Workspace snapshot `git status` hits Node's 1 MiB maxBuffer once there are ~10-20k untracked files, so the prompt's changes are dropped

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (utils-git-config)
- **Area:** `src/utils/WorkspaceSnapshotService.ts`
- **Severity:** high

## Symptom

In git mode, the before/after snapshot of every prompt runs
`git status --porcelain=v1 --untracked-files=all -z` through a bare
`promisify(execFile)` with no `maxBuffer`, so Node's default 1 MiB stdout cap
applies. The output has one `XY <path>\0` entry per dirty or untracked,
non-ignored file, so somewhere between 10k and 20k such files (depending on
path length) push it past 1 MiB. Node then kills git and rejects with
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. The failure is only logged
(`[WorkspaceSnapshotService] git status failed: ...`) and the segment comes back
with an empty `files` map and `dirty` undefined.

- If the **after** snapshot is the one that fails, every file the prompt
  created or modified (and that was clean before the prompt) is missing from the
  prompt's change list and its undo, because `computeSnapshotChanges` only diffs
  paths present in `after.files`.
- If the workspace is already over the threshold before the prompt, **every**
  snapshot in that workspace fails until the files are cleaned up or ignored.
  The user sees an empty change list with no error.

The commit-range pass (`git diff -z --name-status before..after`) has the same
default cap. If a prompt commits enough files, it also logs a warning and
returns `[]`, so the committed changes are left out of the prompt's history.

Realistic triggers: an AI step runs `npm install`, `python -m venv .venv`,
`cargo build` or a scaffolder before a `.gitignore` exists (common when the
agent creates a new project), the user never ignored a `.venv`/`vendor`/`target`
folder, or a step unpacks or generates a large tree.

## Steps to Reproduce

1. Open a git workspace and create ~20k untracked, non-ignored files (for
   example `python -m venv .venv` with no `.gitignore`, or a loop that writes
   `gen/file_N.txt`).
2. Run any workflow step that edits a tracked file.
3. The step's change list is empty. The session log shows
   `git status failed: RangeError [ERR_CHILD_PROCESS_STDIO_MAXBUFFER]: stdout maxBuffer length exceeded`.

Verified separately: a bare promisified `execFile`/`exec` writing 1.2 MB of
stdout rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and a 1,048,576-byte
cap.

## Root Cause

- `src/utils/WorkspaceSnapshotService.ts:39`: `const execFileAsync = promisify(execFile);`
  is a local wrapper that does not use `GitUtils`' shared options
  (`GIT_COMMAND_MAX_BUFFER` = 50 MB, exported from `src/utils/GitUtils.ts:260`).
- `:720`: `await execFileAsync("git", args, { cwd: root })` has no `maxBuffer`.
  The catch at `:721-724` logs and returns `{ git, files }` with an empty map.
- `:477`: the commit-range `git diff -z --name-status` call has no `maxBuffer`
  either. The catch at `:481-486` returns the empty `changes` array.
- `computeSnapshotChanges` (`:899`, deletion loop from `:1051`) treats a path
  missing from `after.files` as clean or deleted, so an empty after-map
  silently drops every new or modified file instead of surfacing a failure.

The same class was fixed for `CommitMessageGenerator`
(`dev/bugs/implemented/commit-message-large-staged-diff-falls-back-to-unstaged.md`)
but not here.

## Suggested Fix

- At minimum, pass a scaled buffer: route both calls through the `GitUtils`
  exec helper or pass `maxBuffer: GIT_COMMAND_MAX_BUFFER`, so the limit is
  50 MB (several hundred thousand entries) instead of 1 MiB.
- Better: stream `git status -z` (spawn and parse NUL-separated records
  incrementally) so output size never matters. Memory is then bounded by the
  per-file state the snapshot keeps anyway.
- A failed capture must not look like a clean workspace. Mark the segment as
  `captureFailed` and have `computeSnapshotChanges` report "changes unavailable"
  for that segment instead of an empty or partial list.
- Add a test that captures a segment with output over 1 MiB (or stubs the exec
  to reject with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) and asserts the failure is
  surfaced.
