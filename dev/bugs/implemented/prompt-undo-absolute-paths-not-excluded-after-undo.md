# Undone files are not excluded from the prompt undo dialog or change counts when event paths are absolute

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/utils/promptUndo.ts`
- **Severity:** medium

## Symptom

After a file is undone at prompt level, the prompt header counts it twice: once as undoable and once as undone. For a single changed file the header reads "View 2 changes (1 undone)". The undo dialog also still lists the file as undoable. Undoing it again fails with "Patch did not apply cleanly - the file may have changed since this edit was made". For a created file, the second undo is a silent no-op that still reports success.

## Steps to Reproduce

1. Run a step with the `claude-cli` harness that edits an existing file. The edit arrives as a `FILE_EDIT` event with an absolute path such as `C:\ws\src\a.ts`, and the `CliOutput`'s `workingDirectory` is `C:\ws`.
2. The post-prompt workspace snapshot records the change under the workspace-relative path `src/a.ts`.
3. Open the prompt's changes dialog and undo `a.ts`. The `UndoRecord`'s `redoInstructions` now contain `{ path: 'src/a.ts', ... }`.
4. Look at the prompt header: it reads "View 2 changes (1 undone)" although only one file changed.
5. Open the dialog again: `a.ts` is still listed as undoable. Undoing it again fails because the reverse patch no longer applies.

## Root Cause

Three call sites pass a redo instruction's relative path as the probe and the candidate list, which holds absolute event paths, as the haystack:

- `src/ui/webview-react/utils/promptUndo.ts:1070` (`buildUndoDialogInputForPrompt`)
- `src/ui/webview-react/utils/promptUndo.ts:1299-1303` (`computePromptChangeSummary`)
- `src/ui/webview-react/hooks/useOutputUndoActions.ts:237` (workflow change data)

`resolveSnapshotFileMatch` (`promptUndo.ts:217-249`) was written for the opposite roles: relative haystack, possibly absolute probe. It relativizes only the probe, and only when the probe is absolute (`:223`). It never relativizes haystack entries. With a relative probe, the exact compare at `:230-233` fails against the absolute candidate path, and because `workspaceRoot` is set, `:237` returns `undefined` before the suffix fallback runs. The undone candidate is therefore never excluded.

Where each path comes from:

- Candidate paths are the raw CLI event paths (`promptUndo.ts:388`, `:425`). Claude reports them as absolute (`src/core/harness/claude/ClaudeToolBuilder.ts:399`).
- Redo instruction paths are snapshot-relative: `resolveSnapshotUndoInstruction` copies `snap.path` (`promptUndo.ts:471`, `:481`, `:488`), and `WorkspaceSnapshotService.applyUndo` carries `instruction.path` into the redo instructions (`src/utils/WorkspaceSnapshotService.ts:1154`, `:1177`, `:1185`, `:1235`).

The existing tests for the exclusion logic use only relative event paths, so they miss this.

## Suggested Fix

Add a shared helper, such as `excludeUndoneCandidates(candidates, redoInstructions, workspaceRoot)`, and use it at all three call sites. It should normalize both sides to workspace-relative keys before comparing: relativize any absolute candidate path against `workspaceRoot` with `relativizeToWorkspace`, then compare with `normalizePath`. When `workspaceRoot` is missing, fall back to `sameFilePath` / `sameCliFilePath`.

A simpler alternative is to match each redo instruction against the snapshot-derived instruction path (`candidate.instruction?.path`, which is already relative) instead of `candidate.path`.

Add tests for both `buildUndoDialogInputForPrompt` and `computePromptChangeSummary` that use an absolute Windows event path, a `workingDirectory`, and a relative snapshot and redo path.

**Resolution:** fixed in this commit
