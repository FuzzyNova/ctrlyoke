# Step changes dialog lists a file twice when events use mixed path separators

- **Found:** 2026-10-11 by Claude (File changes docs pass, hosted dashboard capture)
- **Area:** `src/ui/webview-react/utils/promptUndo.ts`
- **Severity:** medium

## Symptom

On Windows, the **Step changes** dialog for a Copilot CLI step showed
`notes.test.ts` twice, once as `C:/dev/demo-app/tests/notes.test.ts` and once as
`C:\dev\demo-app\tests\notes.test.ts`, both with identical diffs and both
checkable. The **Workflow changes** dialog shows the same file with its step
note doubled: "Prompt 4, Prompt 4, Prompt 5, Prompt 6".

Selecting both rows and undoing applies the same snapshot instruction twice; the
second application fails, or for a reverse patch fails with "Patch did not apply
cleanly", so the result banner reports a partial failure for a file that was
actually restored.

## Steps to Reproduce

1. In the demo project, open the `hero-gif` workflow, Run 4, in the dashboard.
2. Select **View 7 changes** on step 4 (`implement`, Copilot CLI).
3. `notes.test.ts` appears twice.

## Root Cause

`buildUndoCandidatesForOutputs` accumulates file events in a `Map` keyed by the
raw event path (`promptUndo.ts:302-367`). Copilot reported some edits to the file
with `\` separators and others with `/`, so they become two tier-1 candidates.
Both then match the same snapshot entry through the separator-tolerant
`resolveSnapshotFileMatch`, so both rows get the same instruction. The workflow
aggregation inherits the duplicate.

## Suggested Fix

Key `accumMap` by a normalized path (`sameCliFilePath`'s normalization: forward
slashes, and case-insensitive on Windows), keeping the first-seen display path.
Do the same for the workflow-scope aggregation in `useOutputUndoActions.ts`. A
regression test should feed two events for one file with different separators
and expect one candidate.
