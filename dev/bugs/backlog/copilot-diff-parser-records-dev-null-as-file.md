# Copilot diff parser records `dev/null` as an edited file

- **Found:** 2026-10-11 by Claude (File changes docs pass, hosted dashboard capture)
- **Area:** `src/core/harness/copilot/CopilotToolBuilder.ts`
- **Severity:** low

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

`parseGitDiffFileEdits` (`CopilotToolBuilder.ts:589-624`) takes the path from the
`+++` header and only treats it as "no file" when the captured text is exactly
`/dev/null`. The regex strips an optional `b/` prefix, so a header written as
`+++ b/dev/null`, or one ending in `\r`, compares unequal and yields `dev/null`
as the path. The section is also classed as an UPDATE rather than a DELETE. The
exact header Copilot emitted wasn't captured; the event's `path` value proves it
reached this branch with a non-`/dev/null` string.

## Suggested Fix

Take the file path from the `diff --git a/<old> b/<new>` line, which is always
present in this format, and decide add/delete from the `new file mode` /
`deleted file mode` lines and from `/dev/null` after trimming CR and stripping
any `a/` or `b/` prefix. Add a `CopilotToolBuilder` test with a delete-and-recreate
patch and CRLF line endings.
