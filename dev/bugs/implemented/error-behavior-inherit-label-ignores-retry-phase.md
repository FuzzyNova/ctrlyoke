# Step On Error "Inherit" label says Stop Workflow when the inherited policy is retryPhase

- **Found:** 2026-11-13 by the bug-hunt workflow final step (claude-cli), reviewing a1f660730
- **Area:** `src/ui/webview-react/components/editor/PromptPropertiesDrawer.tsx`
- **Resolution:** fixed in this commit

## Symptom

In a step's properties drawer, the error-behavior select's Inherit option names the
policy the step inherits from the workflow or the settings default. When that policy
is `onError: retryPhase`, the option reads **Inherit (Stop Workflow)**. The step
actually retries the failed phase. When the inherited policy is `onError: retry`, the
option reads **Inherit (Retry)**, but everywhere else in the dashboard that value is
now labelled **Retry Step**.

The label is wrong about what happens when a step errors, so a user who relies on it
may add an override they don't need, or leave in place a policy they meant to change.

## Steps to Reproduce

1. Set the workflow's error behavior to **Retry Failed Phase**
   (`errorBehavior: { onError: retryPhase }`) in Workflow Properties.
2. Open any step's properties drawer and look at its On Error select.
3. The Inherit option reads "Inherit (Stop Workflow)". It should read
   "Inherit (Retry Failed Phase)".

## Root Cause

`buildErrorBehaviorInheritLabel` in `PromptPropertiesDrawer.tsx` (around line 570)
hardcodes a ternary over `CONDITION_ACTIONS.RETRY` / `CONDITION_ACTIONS.CONTINUE` and
falls through to "Stop Workflow" for every other value. a1f660730 added
`ERROR_BEHAVIOR_ACTIONS.RETRY_PHASE` and relabelled `retry` as "Retry Step" in
`ERROR_BEHAVIOR_ACTION_OPTIONS_META` (`src/types/SchemaUiMetadata.ts`). It updated
`ErrorBehaviorEditor` but missed this second copy of the labels.

## Suggested Fix

Build the label from the single source:
`ERROR_BEHAVIOR_ACTION_OPTIONS_META[resolved?.onError ?? ERROR_BEHAVIOR_ACTIONS.STOP_WORKFLOW].label`,
falling back to the Stop Workflow label for a missing or unknown value. Add a
`PromptPropertiesDrawer.test.tsx` case that sets a workflow-level `retryPhase` policy
and asserts the Inherit option's label, plus one for `retry` → "Inherit (Retry Step)".
