# A fresh run start keeps the previous attempt's live context-window reading

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `src/ui/webview-react/store/workflowStore.ts`, `src/ui/webview-react/messaging/inboundMessageRouter.ts`
- **Resolution:** fixed in this commit

## Symptom

You stop a workflow while a queue step is running, then start it again from the
beginning, or resume it from step 1 (`currentIndex` 0). The dashboard then shows
the dead attempt's context-window reading for that step: the context bar,
tooltip and chip show e.g. 75% before the new attempt has sent anything. It
stays until the harness sends a new `CONTEXT_WINDOW_UPDATE`, or until a
token-carrying `CLI_OUTPUT` for a harness that never streams live context.
Resuming from step 2 or later clears the reading correctly.

## Steps to Reproduce

Vitest, using the helpers in
`src/ui/webview-react/test/messaging/inboundMessageRouter.test.ts`:

```ts
renderHook(() => useInboundMessageRouter());
act(() => {
  dispatch(MESSAGE_TYPES.FILE_SELECTED, {
    fileName: "wf.yaml",
    steps: [makePrompt("Step 0"), makePrompt("Step 1")],
  });
  useWorkflowStore.getState().setExecutionState(EXECUTION_STATES.RUNNING);
  useWorkflowStore.getState().setCurrentStep(0);
  dispatch(MESSAGE_TYPES.CONTEXT_WINDOW_UPDATE, {
    stepIndex: 0,
    used: 150000,
    size: 200000,
  });
  dispatch(MESSAGE_TYPES.EXECUTION_STATE_CHANGED, {
    state: EXECUTION_STATES.STOPPED,
  });
});
act(() => {
  dispatch(MESSAGE_TYPES.EXECUTION_STARTED, { fileName: "wf.yaml", totalSteps: 2 });
});
expect(useWorkflowStore.getState().liveContextWindow[0]).toBeUndefined();
// Fails: { used: 150000, size: 200000 }
```

The same test passes with the reading on step 1 and
`isContinuation: true, preserveStepCount: 1`.

## Root Cause

The fresh-start branch of `EXECUTION_STARTED`
(`inboundMessageRouter.ts:1221-1244`) resets with `clearAllRuntimeState`
(`workflowStore.ts:2020-2039`). That function clears `liveFinalStepContextWindow`
and the other live maps, but not the queue-step `liveContextWindow`. The
continuation branch uses `clearRuntimeStateFromStep(preserveStepCount)`, which
does clear it (`workflowStore.ts:1937-1941`). A resume from `currentIndex` 0
sends `isContinuation: true, preserveStepCount: 0`
(`src/core/orchestration/WorkflowStartupPipeline.ts`,
`continuationPreserveStepCount`). The client only takes the continuation branch
when `preserveStepCount > 0`, so that resume also lands on the fresh branch.

The stale value is then read by `useContextPct.ts:39-46` (which prefers live for
the current running step) and by `resolveEffectiveContextWindow` in
`utils/tokenUtils.ts:48-50` (which also falls back to live when the step has no
completed snapshot).

## Suggested Fix

Add `liveContextWindow: {}` to `clearAllRuntimeState`, so it matches
`clearRuntimeStateFromStep(0)` and the `loadWorkflow` reset
(`workflowStore.ts:1773-1776`). Add the reproduction above as a regression test
next to the existing `CONTEXT_WINDOW_UPDATE` tests in
`inboundMessageRouter.test.ts`, plus a store-level test that
`clearAllRuntimeState` empties `liveContextWindow`.
