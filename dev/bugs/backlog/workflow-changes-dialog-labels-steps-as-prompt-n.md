# Workflow changes dialog labels steps "Prompt N" instead of "Step N"

- **Found:** 2026-10-11 by Claude (File changes docs pass)
- **Area:** `src/ui/webview-react/hooks/useOutputUndoActions.ts`
- **Severity:** low

## Symptom

Each row in the **Workflow changes** dialog notes which steps changed the file,
for example "Prompt 4, Prompt 5, Prompt 6". Everywhere else the dashboard calls
these steps ("Step 4 — implement" in the Step changes subtitle, "Step 4" in the
output header and steps panel). Script steps that changed a file are also
labelled "Prompt N".

## Steps to Reproduce

1. Open any finished run whose steps changed files.
2. Select **View N changes** in the output toolbar.
3. Row notes read "Prompt N".

## Root Cause

`useOutputUndoActions.ts:208-212` builds the label as
`` `Prompt ${stepIndex + 1}` `` for queue steps. (`useOutputMinimapModel.ts:82-89`
has a similar "Prompt N"/"Script N" fallback for unnamed steps.)

## Suggested Fix

Use "Step N" (or the step's name when it has one, matching the Step changes
subtitle), and update `UndoChangesDialog.test.tsx` / `promptUndo.test.ts`
fixtures that assert the old text.
