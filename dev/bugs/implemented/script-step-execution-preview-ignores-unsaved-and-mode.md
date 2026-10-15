# Script-step execution preview reads the wrong executionMode and ignores unsaved shell/env, so preview disagrees with what Update saves

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/utils/executionPreview.ts`
- **Severity:** medium

## Symptom

When a script step is selected in the editor, Execution Preview and Dry Run show a different step from the one that is saved or that Update would save:

- A saved `executionMode` is dropped, so the preview shows the inherited mode.
- Unsaved Shell, Env and Execution Mode edits are ignored, so the previewed command still uses the old shell.
- Fields set back to their defaults in the editor (`onPass`, `onFail`, `compareSource`, `operator`, `expected`, `ignoreCase`, `timeoutSec`) still show their old saved values.

## Steps to Reproduce

1. Create a workflow with a script step that sets `executionMode: interactive`, `shell: pwsh` and `onPass: stopWorkflow`. Save it.
2. Select that step in the dashboard so the editor loads it. Make no edits.
3. Open Execution Preview from the header, or from the Properties drawer / Dry Run. The step shows the inherited execution mode instead of `interactive`, because the snapshot deleted `executionMode`.
4. In the editor, change Shell to `bash` and On Pass back to Continue. Do not press Update. Refresh the preview.
5. The previewed command still uses `pwsh`, and `onPass` still shows `stopWorkflow`. Pressing Update would save `bash` and clear `onPass`.

## Root Cause

`getExecutionPreviewEditorSnapshot`, script branch (`src/ui/webview-react/utils/executionPreview.ts:45-89`):

- **Wrong executionMode source.** Lines 81-85 read `editor.properties.executionMode`. For script steps, `properties` comes from `propertiesFromScriptData` (`src/ui/webview-react/store/editorStore.ts:730-735`). That object spreads `PROPERTY_DEFAULTS`, whose `executionMode` is `undefined` (`editorStore.ts:198`). The real value is in `editor.scriptExecutionMode` (`editorStore.ts:777-779`, written by `setScriptExecutionMode`). The snapshot therefore always runs `delete step.executionMode`.
- **Shell and env edits are never applied.** The branch spreads the saved step as `base` (lines 46-51) and never reads `editor.scriptShell` or `editor.scriptEnv`, so the saved `shell`/`env` are used.
- **Defaults never clear saved values.** `timeoutSec`, `onPass`, `onFail`, `compareSource`, `operator`, `expected` and `ignoreCase` are only set when non-default (lines 55-76). Nothing deletes them when the editor holds the default, so the old values from `base` remain. The save path does clear them through its `clearProperties` list (`src/ui/webview-react/components/editor/PromptEditor.tsx:1147-1168`).

The orchestrator swaps the snapshot in for the step (`src/core/WorkflowOrchestrator.ts:2372-2382`). `ExecutionPreviewService` then builds the preview from the wrong values: `scriptAsPrompt` (`src/core/ExecutionPreviewService.ts:776`) uses `step.executionMode`, and `buildScriptCommand` (`ExecutionPreviewService.ts:1328-1334`) uses `step.shell`.

## Suggested Fix

Build the script snapshot the same way PromptEditor's save path does. Ideally, move the `scriptProperties` / `clearProperties` logic in `PromptEditor.tsx:1111-1168` into one shared helper, use it from both the save path and `executionPreview.ts`, and apply the result to `base` (set the properties, delete the cleared keys).

At minimum:

- Use `editor.scriptExecutionMode` instead of `editor.properties.executionMode`.
- Apply `editor.scriptShell` (delete `shell` when blank) and `editor.scriptEnv` (delete `env` when empty).
- Delete `timeoutSec`, `onPass`, `onFail`, `compareSource`, `operator`, `expected` and `ignoreCase` when the editor holds the default.
- Handle `color` and `secrets` the way the save path does.

Add a Vitest case under `src/ui/webview-react/test/` that loads a saved script step with `executionMode`, `shell` and a non-default `onPass`, edits them back to the defaults, and checks the snapshot.

**Resolution:** fixed in this commit
