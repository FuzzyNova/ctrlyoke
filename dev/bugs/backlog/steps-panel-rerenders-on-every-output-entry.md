# The steps panel and chip rail re-render on every streamed output entry

- **Found:** 2026-11-27 by the round-14 dashboard step of the workflow-step plan (claude-cli)
- **Area:** `src/ui/webview-react/components/layout/WorkflowStepsPanel.tsx`, `src/ui/webview-react/components/steps/StepChipRail.tsx`
- **Severity:** low

## Symptom

`WorkflowStepsPanelInner` and `StepChipRail` re-render on every `workflowStore`
write, including each streamed output entry, and pass a new `getLatestOutput`
callback to every step row on each entry append. Nothing visibly breaks, but a
long run spends render time in the steps list for output it never shows.

## Steps to Reproduce

1. Render `<WorkflowStepsPanel />` inside a React `Profiler`.
2. Call `useWorkflowStore.getState().appendLiveEntry(...)` with an ordinary
   status or CLI entry.
3. The profiler reports a commit for the panel on every append.

## Root Cause

Several hooks the panel and the rail call read the whole store with a
selector-less `useWorkflowStore()`, which subscribes to every field:
`WorkflowStepsPanel.tsx` (the destructure ending around line 862),
`StepChipRail.tsx:404`, `hooks/useStepListContextMenus.tsx:36`,
`hooks/useStepStatus.ts:22`, `hooks/useContextPct.ts:29` and
`hooks/useLatestStepOutput.ts:13`. The last one also derives `getLatestOutput`
from `liveOrderedEntries`/`historyOutputs.orderedEntries`, so its identity
changes on every entry append and every row receives a new prop.

This predates the sub-workflow work: the round-13 review attributed the churn
to `useSubWorkflowRanWithIndex`, but before `cfda4254f` the panel already
subscribed this way. Round 14 made that hook return a memoised primitive, so
it no longer adds a scan and a `JSON.stringify` per render or a re-render of
its own; it could not by itself stop the panel re-rendering.

## Suggested Fix

Replace each selector-less `useWorkflowStore()` with field selectors (or
`useShallow`) for exactly the fields read, and make the latest-output lookup
per row (a selector that returns the stored entry reference for one step, or a
callback that reads `getState()` lazily where only event handlers need it).
Then extend the render-count test in
`test/components/layout/WorkflowStepsPanelLanes.test.tsx` to profile the whole
panel across ordinary appends.
