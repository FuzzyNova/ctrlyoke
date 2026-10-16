# The Markdown export keeps a stale step range after steps are unhidden or the workflow changes

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; reproduced with a throwaway Vitest render of the hook)
- **Area:** `src/ui/webview-react/hooks/useOutputExport.ts`
- **Resolution:** fixed in this commit

## Symptom

With 3 steps, hide step 2 in the output filter and open **Export**. The step range is filled in
as `1,3`, which is correct. Close the modal, show all steps again, and reopen Export: the range
still reads `1,3`, and the export silently leaves out step 2 although no filter is active.

Hidden steps are stored per workflow (`uiStore.hiddenOutputTargets[workflowKey]`), so switching
to another workflow with nothing hidden has the same effect: its export is cut down by a range
built from the previous workflow's filter.

## Steps to Reproduce

1. Render `useOutputExport` with `hiddenTargetKeys: ["queue:1"]` and three steps of output.
2. `openModal()`, then `closeModal()`.
3. Rerender with `hiddenTargetKeys: []` and `openModal()` again.
4. `stepRange` is still `"1,3"`, and the exported markdown has no step 2 output.

## Root Cause

`stepRange` is hook state owned by `OutputSection`, so it outlives the modal. `openModal`
(`useOutputExport.ts:95-101`) only resets it while something is hidden:

```ts
if (hiddenTargetKeys.length > 0) {
  setStepRange(visibleStepRange);
  setStepRangeError(false);
}
```

Once the filter is cleared, nothing resets the range filled in from it.

## Suggested Fix

Reset on every open: `setStepRange(visibleStepRange); setStepRangeError(false);`.
`getVisibleStepRange` already returns `""` when nothing is hidden. Add regression tests for
"unhide all, then reopen" and for a hidden-steps change between opens in
`src/ui/webview-react/test/hooks/useOutputExport.test.ts`.
