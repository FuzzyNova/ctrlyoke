# Copilot diff parser records `dev/null` as an edited file

- **Found:** 2026-10-11 by Claude (File changes docs pass, hosted dashboard capture)
- **Area:** `src/core/harness/copilot/CopilotToolBuilder.ts`
- **Resolution:** fixed in this commit

## Symptom

The **Step changes** and **Workflow changes** dialogs for a Copilot CLI step
listed a file named `null` in folder `dev/`, marked "Cannot undo", with a diff
of `-29` lines. Those 29 lines are the old content of `tests/notes.test.ts`,
which Copilot rewrote in the same step. The output pane also shows an "Edited
null" block.

## Steps to Reproduce

1. In the demo project, open the `hero-gif` workflow, Run 4.
2. Select **View 7 changes** on step 4 (`implement`, Copilot CLI).
3. A `null` row under `dev/` appears.

The run's `events.jsonl` has a `fileEdit` event on `queue` step index 3 with
`"path":"dev/null"` and a structured patch that removes every line of the old
test file.

## Root Cause

`parseGitDiffFileEdits` took its path from the `+++` header and only treated the
captured text as "no file" when it was exactly `/dev/null`. Stripping the
optional `b/` prefix from `+++ b/dev/null` leaves `dev/null`, which the old check
did not recognize. The parser then recorded `dev/null` as the path and marked
the section as an UPDATE. A regression test using that header reproduces the
failure. CRLF alone is not the cause: JavaScript's `.` does not match `\r`, and
`$` with the multiline flag matches before `\r`.

## Fix

The parser now takes paths from the `diff --git a/<old> b/<new>` line when
available, falls back to the `---`/`+++` headers, and recognizes add/delete
sections from file mode lines or null-path headers after trimming whitespace
and stripping `a/` or `b/`. It skips null paths and uses the old path for
deletions. A regression test covers a delete-and-recreate patch, `+++ b/dev/null`,
and CRLF line endings.
