# Undo/redo shows a skipped step as completed

- **Found:** 2026-11-14 by the smell-hunt final step (pass 15), comparing the runtime → step-status ladders
- **Area:** `src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts`
- **Resolution:** fixed in this commit

## Symptom

After a run in which a step ended as skipped (a "Set start position" skip, or an
`errorBehavior` that skips the step), pressing undo or redo in the dashboard relabels
that step's badge from "Skipped" to "Completed". Reloading the workflow from disk
shows "Skipped" again, because the host rebuilds the status correctly.

## Steps to Reproduce

1. Run a workflow where one step finishes with `_runtime.terminalStatus: "skipped"`
   (and `completedAt` set), and let the run finish.
2. Edit a step so the undo stack has an entry, then press Ctrl+Z (or Ctrl+Y).
3. The skipped step now shows as completed.

## Root Cause

`deriveStatusFromRuntime` in `src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts`
(about lines 91-108) maps `terminalStatus` to a step status for any step with
`completedAt`, ignoring the restored status. Its ladder handles `cancelled`,
`noTurnStarted` and `failed` but has no `skipped` branch, so `skipped` falls through
to `STEP_STATUS.COMPLETED`. The host's copies of the same ladder in
`src/core/PromptQueue.ts` (`restoreFromWorkingFile`, about lines 641-654, and
`getResultStatusFromRuntime`, about lines 3788-3810) do handle `skipped`.

## Suggested Fix

Single-source the terminal-status → step-status mapping as a pure helper in
`src/types/DashboardConstants.ts` (next to `isTerminalStepStatus`) and use it from
all three places, so the webview copy picks up the `skipped` case.
