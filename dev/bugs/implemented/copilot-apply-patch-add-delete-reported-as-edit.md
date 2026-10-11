# Copilot `apply_patch` reports Add File / Delete File as FILE_EDIT, so per-edit undo leaves an empty file or fails

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch `npx tsx` script running the real builder and `WorkspaceSnapshotService.undoFiles`)
- **Area:** `src/core/harness/copilot/CopilotToolBuilder.ts` (`buildInitiatedEvents`, `buildCompletedEvents`, `parseGitDiffFileEdits`)
- **Resolution:** fixed in this commit

## Symptom

When Copilot CLI runs `apply_patch` with `*** Add File:` or `*** Delete File:`
sections, ctrlyoke emits `FILE_EDIT` events for them. The dashboard labels the
files as edited, and per-edit undo (`promptUndo.ts`, which builds a
`REVERSE_PATCH` instruction for any FILE_EDIT with a `structuredPatch`) does
the wrong thing:

- Undoing an added file reports "restored" but leaves the file in place with
  empty content.
- Undoing a deleted file fails with `File not found`.

## Steps to Reproduce

1. Feed `buildInitiatedEvents` / `buildCompletedEvents` an `apply_patch` call
   whose input is
   `*** Begin Patch\n*** Add File: src/new.ts\n+export const a = 1;\n*** Delete File: src/old.ts\n*** End Patch`
   and whose `detailedContent` git diff contains `new file mode … --- /dev/null`
   and `deleted file mode … +++ /dev/null`.
2. Both files come out as `fileEdit` with hunks `@@ -0,0 +1,1` and
   `@@ -1,1 +0,0`.
3. Pass them to `WorkspaceSnapshotService.undoFiles` as REVERSE_PATCH:
   `src/new.ts` still exists with `""`; `src/old.ts` fails "File not found".

Expected: Add → `FILE_WRITE` (undo deletes it), Delete → `FILE_DELETE` (undo
restores from snapshot), as Codex already does.

## Root Cause

- `CopilotToolBuilder.buildInitiatedEvents` (~287, ~300) maps every parsed
  `fileEdit` to `CLI_EVENT_TYPES.FILE_EDIT`, ignoring `fileEdit.kind`.
- `buildCompletedEvents` does the same on the git-diff path (~372), the
  `parseFileEdits` path (~396) and the fallback (~419).
- `parseGitDiffFileEdits` (~607) discards `new file mode` / `deleted file mode`
  / `/dev/null` information, so it can't return a kind at all.
- `CodexToolBuilder.ts` (~130-150) already maps `APPLY_PATCH_FILE_EDIT_KINDS.ADD`
  → FILE_WRITE and `DELETE` → FILE_DELETE; `harness-cli-providers.instructions.md`
  calls that mapping a correctness fix. Copilot never got it.

## Suggested Fix

Extract Codex's kind → event-type/data mapping into one shared helper (e.g. in
`src/core/harness/shared/`, next to `ApplyPatchParser`) and use it in every
Copilot `apply_patch` branch and in Codex. Make `parseGitDiffFileEdits` return
a `kind` (`add` for `new file mode` or `--- /dev/null`, `delete` for
`deleted file mode` or `+++ /dev/null`, else `update`). Tests in
`src/test/suite/harness/LogParsers.test.ts` next to "should extract file paths
from apply_patch tool events", covering initiated and completed events for
add, delete and update.
