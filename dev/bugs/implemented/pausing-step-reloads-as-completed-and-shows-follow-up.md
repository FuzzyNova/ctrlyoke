# A step still running under Pause reloads as completed and shows a "Follow-up" divider

- **Found:** 2026-10-10 by user (bug-hunt run, final-step pass 6, claude-cli headless)
- **Area:** `src/core/orchestration/OutputHistoryTimelineAdapter.ts`, `src/core/OutputCaptureBuffer.ts`
- **Resolution:** fixed in this commit

## Symptom

While a headless final step was still running, the output pane rendered a
"Follow-up" divider and appended the step's new output below it. A headless
step cannot produce a follow-up: it only stops when its process exits. Nothing
follow-up-shaped was persisted; `events.jsonl` holds no `followUpResumed` event.

## Steps to Reproduce

1. Run a workflow and press Pause while a step is executing (state `pausing`;
   the current step keeps running).
2. Switch the dashboard to another workflow, then back.
3. The next streamed batch from the still-running step appears under a
   "Follow-up" divider.

## Root Cause

Two places treated only `RUNNING` as "a step is still executing":

- `OutputHistoryTimelineAdapter.project` and `hydrateCliOutputsFromResolver`
  sealed every streaming CLI entry (`isStreaming: false`) whenever the
  manifest's `executionState` was not `RUNNING`. The run-view snapshot sent on
  the switch therefore delivered the in-flight attempt as complete.
- `OutputCaptureBuffer.replayTo` replayed the in-flight final-step buffer (and
  queue buffers, absent an active-target entry) only when the status was
  `RUNNING`, so nothing re-opened the entry as streaming.

`workflowStore.computeStreamingEventsToMerge` treats any batch arriving for an
`isStreaming: false` entry as post-completion activity and prefixes the
one-time `FOLLOW_UP_RESUMED` divider.

## Fix

Both sites use `IN_FLIGHT_EXECUTION_STATES` (RUNNING, PAUSING, CANCELLING), the
existing predicate for "a step may still be executing". PAUSED and terminal
states still seal, since no step is live by then.
