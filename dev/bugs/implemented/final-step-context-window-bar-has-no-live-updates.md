# Final step context-window bar never updates while the final step runs

- **Found:** 2026-10-10 by Nathan (manual observation), confirmed in code by claude-cli
- **Area:** `src/core/WorkflowExecutor.ts` (`onContextWindowUpdate` listener), `src/ui/webview-react/components/prompts/FinalStepFooter.tsx`
- **Resolution:** fixed in this commit

## Symptom

While a queue step runs, its `ContextWindowBar` fills live. The final step's
footer shows no bar at all while it runs. The bar appears only after the pass
completes, filled from the completed CLI output's token metadata. Collapsing
and re-expanding the details does not affect this; the bar was never live.

## Steps to Reproduce

1. Run a workflow whose `finalStep` is an AI prompt (any harness that reports
   live context, e.g. `claude-cli`).
2. Expand the final step footer's details while the final step runs.
3. No context-window bar is shown. It appears when the pass completes.

## Root Cause

Live context telemetry is dropped for final-step targets at the source, and no
part of the pipeline can carry it:

1. **Executor drops it.** `WorkflowExecutor.ts` ~4377-4391 forwards
   `integration.onContextWindowUpdate` only when
   `target.kind === FINAL_STEP_PHASES.QUEUE`. There is no `FINAL_STEP` branch,
   unlike the streaming-events listener right above it (~4350), which has
   `captureFinalStepEvents` and `updateFinalStepStreamingEvents`.
2. **The transport is keyed by queue index only.**
   `IDashboardSink.updateContextWindow(stepIndex, …)`, the
   `CONTEXT_WINDOW_UPDATE` message (`WebviewMessageTypes.ts` ~835), and
   `OutputCaptureBuffer.captureContextWindow`/`contextWindowBuffer` (~303, and
   the reconnect replay at ~629-639) have no way to address the final step.
3. **The webview has nowhere to store it.** `workflowStore.liveContextWindow`
   is `Record<number, …>` keyed by queue step index. The
   `CONTEXT_WINDOW_UPDATE` handler (`useMessageHandler.ts` ~1703-1724) looks
   up `steps[message.stepIndex]`.
4. **The footer never asks for live data.** `FinalStepFooter.tsx` ~104-108
   calls `resolveEffectiveContextWindow` with `isCurrent: false` and no
   `liveContextWindow`, so it only shows `latestOutput.tokens` (written at
   completion) or `finalStep._runtime`. Its comment says this is because
   "live context telemetry is keyed by queue step index only".

`ContextWindowBar` returns `null` when `contextWindow?.size` is falsy, so the
bar is missing entirely during the pass instead of showing a stale value.

## Suggested Fix

Give the final step its own live context-window channel, modelled on the
existing final-step streaming-events path. Do not reuse a sentinel queue index.

- **Executor:** add a `FINAL_STEP` branch to the `onContextWindowUpdate`
  listener that calls new `captureFinalStepContextWindow(loopIndex, …)` and
  `dashboardProvider.updateFinalStepContextWindow(loopIndex, used, size)`
  hooks, mirroring `captureFinalStepEvents`/`updateFinalStepStreamingEvents`.
- **Sink/transport:** add `updateFinalStepContextWindow` to `IDashboardSink`
  and every implementation (`PostMessageDashboardSink`, `WorkflowTaggedSink`,
  `DashboardBroadcastHub`, `CtrlYokeHostedServer`, `CtrlYokeWebviewProvider`).
  Either add a `FINAL_STEP_CONTEXT_WINDOW_UPDATE` message type or widen
  `CONTEXT_WINDOW_UPDATE` to carry an execution target (`kind` + index) instead
  of a bare `stepIndex`. The target form is the cleaner single source; the
  output-history entries already use it.
- **Reconnect replay:** buffer the final step's last reading in
  `OutputCaptureBuffer` and replay it next to the queue-step replay, so a
  dashboard that connects mid-pass gets the gauge at once.
- **Store:** add `liveFinalStepContextWindow` (or a target-keyed map) with the
  same guards as the queue handler. Ignore it once the final step's status is
  terminal, and clear it when a new pass or run starts.
- **Footer:** pass `isCurrent` (final step is the running target) and the live
  snapshot into `resolveEffectiveContextWindow`. Then delete the comment that
  explains the limitation. Do the same for the final-step chip in
  `PromptChipRail.tsx` and for `useFinalStepContextMenu`'s copied metadata, so
  all three surfaces agree.

Tests: an executor unit test that a `FINAL_STEP` target forwards context
updates; a `useMessageHandler.test.ts` case for the new message; and a
`FinalStepFooter` render test where the bar shows the live value mid-pass and
the completed value afterwards.
