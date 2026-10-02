# Prior Context dropdown: "Completed run output" does nothing

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), confirmed with a throwaway Vitest probe
- **Area:** `src/ui/webview-react/components/shared/PriorContextSelect.tsx`
- **Resolution:** fixed in this commit

## Symptom

In the step Properties drawer and the Workflow Properties panel (Context tab),
choosing **Completed run output** in the Prior Context dropdown closes the
popup and changes nothing. The workflow-key and run-reference inputs never
appear, so a run-address `priorContext` can only be set by editing the
workflow file by hand.

## Steps to Reproduce

1. Render `<PriorContextSelect value="none" onChange={fn} />` (or open any
   step's Prior Context dropdown in the dashboard).
2. Open it and click **Completed run output**.
3. `onChange` is not called, and no "Prior-context workflow key" input renders.

## Root Cause

`selectKeyword`'s RUN branch (~161-165) only calls `setWantsCustom(false)` and
closes the popup. The run-address inputs render only when
`mode === PRIOR_CONTEXT_SELECTION_MODES.RUN` (~349), and `mode` comes from
`value` alone (`getMode`). There is no local "wants run" state like the
`wantsCustom` state that Custom mode uses, so the RUN mode can never be entered
from the UI.

## Suggested Fix

Add `wantsRun` state that mirrors `wantsCustom`: set it in the RUN branch and
clear it in every other branch and in the external-value sync effect (unless
the value is a run address). Render the inputs when `wantsRun || mode === RUN`,
and call `onChange` once both fields are non-empty (`updateRunAddress` already
builds the value). Show RUN as the selected label while `wantsRun` is set. Also
stop showing the "Previous N" count input while Custom or RUN is the active
choice. Add Vitest coverage for selecting RUN, filling both fields, and
switching away again.
