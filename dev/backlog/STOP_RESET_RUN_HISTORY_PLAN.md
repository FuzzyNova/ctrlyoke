# Stop → Reset → Resume: Correct Output History with runIndex

## Problem

When a user stops a workflow, repositions via "set start position", and resumes, steps
that re-run write new history entries with `attemptIndex: 0` — the same value used by
their original run. This produces duplicate, indistinguishable entries in the history
file and in the in-memory `OutputCaptureBuffer`.

The same issue exists for the simpler STOPPED → Resume path (no repositioning): the
cancelled step's partial output (`att:0`) and the re-run output (`att:0`) are both in
history with the same identifier.

In the current timeline-backed implementation, the user-visible failure is actually a
bit worse than "duplicate raw entries": `OutputHistoryTimelineAdapter` projects CLI
history using `(target, attemptIndex)` as the dedupe key, so a later manual re-run with
the same `attemptIndex` can overwrite the earlier projected entry during `loadHistory()`.
So the fix needs to address both:
- raw timeline events (`events.jsonl`) containing colliding records, and
- projected `orderedEntries` collapsing earlier runs because the adapter key is too coarse.

### Scenario: stop at step 9, reposition to step 2, resume

After the resume, the history file contains:
- Steps 1–8: original run, `attemptIndex: 0` (correct)
- Step 9: partial/cancelled, `attemptIndex: 0`
- Steps 2–9: re-run, `attemptIndex: 0` ← duplicate, indistinguishable from originals
- Step 10: first run ever, `attemptIndex: 0`

## Why a simple "offset the attemptIndex" approach is wrong

The natural fix — start re-run steps at `baseAttemptIndex + 1` — would break the
end-condition retry display.

`EndConditionHandler` builds `nextAttemptIndex = currentAttemptIndex + 1` and stores
`retryState = { currentRetry: attemptIndex, maxRetries }`. If `currentAttemptIndex`
starts at 4 (because this is the 4th manual re-run), the first EC retry would report
`retryState = { currentRetry: 5, maxRetries: 5 }` — the UI would show "Retry 5/5"
on the very first EC retry, which is wrong.

**Important**: `maxRetries` enforcement is NOT broken — `EndConditionHandler` uses
`promptQueue.getCurrentRetryCount()` as its retry counter, which is reset to 0 at the
start of each step execution regardless of `attemptIndex`. So the *gate* is correct;
only the *display* is wrong. But display correctness still matters.

## Solution: Two independent axes

Track manual re-runs and end-condition retries as independent dimensions:

| Field          | Meaning                                                 | Values       |
| -------------- | ------------------------------------------------------- | ------------ |
| `runIndex`     | Which manual start/re-run of this step (new)            | 0, 1, 2, …  |
| `attemptIndex` | End-condition retry within the current `runIndex` (unchanged) | 0, 1, 2, …  |

A history entry for step N is uniquely identified by `(stepIndex, runIndex, attemptIndex)`.

For `finalStep`, the same idea applies with `(loopIndex, runIndex, attemptIndex)`. The
storage / projection / buffering layers should therefore treat `runIndex` as part of the
general execution-target key, not as a queue-step-only concern.

Examples for step 9 (maxRetries=5) after 2 manual re-runs:
- Original run, initial attempt: `runIndex:0, att:0`
- Original run, EC retry 1:     `runIndex:0, att:1`
- Manual re-run #1, initial:    `runIndex:1, att:0`
- Manual re-run #1, EC retry 1: `runIndex:1, att:1`  → UI shows "Retry 1/5" ✓
- Manual re-run #2, initial:    `runIndex:2, att:0`

**`maxRetries` enforcement is completely unaffected** — `EndConditionHandler` calls
`promptQueue.getCurrentRetryCount()` (reset on each new step execution) and does not
look at `runIndex` or `attemptIndex` from history.

---

## Implementation Plan

### Phase 1: Data model + timeline event shape

**`src/types/WebviewMessageTypes.ts`** — Add `runIndex` to `CliOutput`:
```typescript
export interface CliOutput {
  // ... existing fields ...
  /** End-condition retry within the current manual run. 0 = initial attempt. */
  attemptIndex?: number;
  /**
   * How many times the user has manually started/restarted this step
   * (via stop → set-start-position → resume). 0 = first run ever.
   * Orthogonal to attemptIndex — does NOT reset the EC retry counter.
   */
  runIndex?: number;
}
```

**`src/types/OutputHistoryTypes.ts`** — Add `runIndex` to `OrderedCliHistoryEntry`:
```typescript
export interface OrderedCliHistoryEntry {
  kind: "cli";
  target: OutputExecutionTarget;
  runIndex: number;      // ← NEW, default 0 for existing history
  attemptIndex: number;
  cliOutput: CliOutput;
  timestampMs: number;
  sequence: number;
}
```

**`src/types/WorkflowTimelineTypes.ts`** — Add `runIndex` to the timeline CLI event:
```typescript
export interface CliOutputRecordedEventDraft extends TargetedTimelineEventDraftBase {
  eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED;
  runIndex: number;      // NEW
  attemptIndex: number;
  payload: {
    cliOutput: CliOutput;
  };
}
```

**`src/flightpath/orchestration/OutputHistoryTimelineAdapter.ts`** — Default missing
`runIndex` to `0` when reading older timeline events, and change the projection key from
`(target, attemptIndex)` to `(target, runIndex, attemptIndex)`.

Backward compatibility: older history files and older `events.jsonl` entries that omit
`runIndex` should deserialize as `runIndex: 0`.

---

### Phase 2: Determine runIndex before execution

**`src/flightpath/WorkflowInstance.ts`** — In `executeLoadedPromptFile`, compute run
indices for any execution target that is about to be re-run against an existing history
file.

Important correction: this must run for both continuation paths that reuse history:
- `continueFromCurrent=true` manual Resume
- `isIdleContinuation=true` stop → set-start-position → Run/Resume

It should also handle the case where a workflow resumes directly in `finalStep`, not just
queue steps.

Recommended shape: compute a target-keyed map, not a step-only map:
```typescript
type ExecutionTargetRunKey = `queue:${number}` | `final:${number}`;
```

Then build:
- `queue:${stepIndex}` for any queue step `>= currentIndex` that will re-run
- `final:${loopIndex}` when resuming in the `finalStep` phase for the current loop

```typescript
private async computeTargetRunIndices(...): Promise<Map<ExecutionTargetRunKey, number>> {
  // load history
  // collect max(runIndex) for each queue/final target that will re-run
  // set next runIndex = max + 1 for those targets
  // targets with no prior history are omitted and therefore default to 0
}
```

Pass the result as `targetRunIndices` in `WorkflowExecutionContext` before starting
execution.

---

### Phase 3: Thread runIndex through the execution context

**`src/flightpath/WorkflowExecutor.ts`** — Add to `WorkflowExecutionContext`:
```typescript
export interface WorkflowExecutionContext {
  // ... existing fields ...
  /**
   * Per-target run index for continuation runs.
   * Keys use execution-target form (`queue:N`, `final:N`).
   * Absent (or empty) for fresh starts: all targets default to runIndex 0.
   */
  targetRunIndices?: Map<string, number>;
}
```

In `WorkflowExecutor`, resolve the current run index from the execution target and stamp
it on every emitted `CliOutput`, for both queue and `finalStep` targets.

Pass `runIndex` through to:
- `captureOutputInit` (OutputCaptureBuffer)
- `captureFinalStepOutputInit`
- `buildCliOutput`
- `createFinalCliOutput`
- `notifyCliOutput` / `notifyFinalStepOutput` → dashboard

Also forward it into the retry path so end-condition retries stay within the current
`runIndex`.

---

### Phase 4: OutputCaptureBuffer

**`src/flightpath/OutputCaptureBuffer.ts`**

Use the actual buffer types in this file: `StepOutputBufferEntry` and
`CompletedStepEntry`.

Add `runIndex` to `StepOutputBufferEntry` and `CompletedStepEntry`:
```typescript
interface StepOutputBufferEntry {
  // ... existing ...
  runIndex: number;
}
```

`captureOutputInit` accepts `runIndex` parameter (default 0) and stores it.

`captureCompletedOutput` should use `(target, runIndex)` as the compound key so that
manual re-runs for the same queue step or same `finalStep` loop do not collide with the
original run. Change:
- queue completed-output keys from `stepIndex`
- finalStep completed-output keys from `loopIndex`
to a compound execution-target key such as:
`queue:${stepIndex}:run:${runIndex}` / `final:${loopIndex}:run:${runIndex}`

Also update `cacheHistoricalStepOutput()` and the append-continuation history hydration in
`WorkflowInstance` so pre-cached outputs preserve per-run grouping instead of flattening
all outputs for a step into a single bucket.

`replayTo()` replays all runs for each target in order:
```
step 2, runIndex 0 → attempt 0, attempt 1 (EC retries)
step 2, runIndex 1 → attempt 0, attempt 1 (EC retries from re-run)
```

---

### Phase 5: EndConditionHandler — no changes required to enforcement

`EndConditionHandler` needs ONE update: forward `runIndex` through `RetryContext` so
it can be stamped on retry outputs. The retry `nextAttemptIndex` calculation stays
unchanged (`currentAttemptIndex + 1` — still means "EC retry within this runIndex").

```typescript
export interface RetryContext {
  // ... existing ...
  runIndex: number;  // passed through from WorkflowExecutionContext
}
```

`retryState.currentRetry` continues to be the EC retry count (0-based within the
current `runIndex`). This is what drives the "Retry N/M" display — it remains
correct because it's sourced from `attemptIndex` which still resets to 0 at the
start of each `runIndex`.

---

### Phase 6: OutputHistoryManager

**`src/flightpath/orchestration/OutputHistoryManager.ts`**

Correction for this repo: the write path is `saveExecutionOutput()` →
`saveTimelineExecutionOutput()`, not `writeCliOutput()`.

Required changes:
- `saveTimelineExecutionOutput`: include `runIndex` (default 0) in
  `CliOutputRecordedEventDraft`
- `loadHistory`: still delegates to `OutputHistoryTimelineAdapter`, which must default
  missing `runIndex` to 0
- `OutputHistoryTimelineAdapter.project`: key projected CLI entries by
  `(target, runIndex, attemptIndex)`, not just `(target, attemptIndex)`
- Optional helper: replace `getMaxRunIndexForStep(...)` with the more general
  `getMaxRunIndexForTarget(...)`

**`src/types/WorkflowTimelineTypes.ts`** and
**`src/flightpath/orchestration/OutputHistoryTimelineAdapter.ts`** are part of this phase
and should be called out explicitly in the implementation plan.

---

### Phase 7: Dashboard broadcast and webview store

**`src/ui/DashboardBroadcastHub.ts` / `FlightPathWebviewProvider.ts`**

`updateCliOutput` already passes `CliOutput` as-is; `runIndex` rides along for free.

**`src/ui/webview-react/hooks/useMessageHandler.ts`**

When constructing `OrderedCliHistoryEntry` for `CLI_OUTPUT` and `FINAL_PROMPT_OUTPUT`,
copy `message.output.runIndex ?? 0` into the entry.

**`src/ui/webview-react/store/workflowStore.ts`**

`appendLiveEntry` de-duplicates streaming entries by `(target, attemptIndex)`. Extend
to `(target, runIndex, attemptIndex)` so re-run streaming entries don't overwrite the
original streaming entry.

Also review the synthetic-entry path in `appendStreamingEvents` /
`appendFinalStepStreamingEvents`: today it hardcodes `attemptIndex: 0`. If that fallback
path remains, it should derive both `attemptIndex` and `runIndex` from the current
in-flight entry instead of synthesizing a colliding default.

---

### Phase 8: UI rendering

**`src/ui/webview-react/utils/outputProjection.ts`**

Currently projects `OrderedHistoryEntry[]` into renderable output. When multiple
`runIndex` values exist for the same step, each runIndex should render as a distinct
output group with appropriate labeling.

Implementation detail: `OutputMessage` should carry `runIndex`, not just `attemptIndex`.
That keeps downstream rendering and export code from silently flattening re-runs.

Display options (pick one — decide at implementation time):
- **Option A**: Show as sequential collapsed blocks within a step: "Run 1" / "Run 2"
  headers (similar to how retry blocks work today).
- **Option B**: Only show the most recent `runIndex` in the live output, with a
  "previous runs" disclosure.
- **Option C**: Show all runs sequentially without grouping headers (simplest; all
  attempts are already shown today for EC retries).

Recommendation: **Option A** for clarity. Reuses the existing attempt-collapse
component pattern.

Also update the renderers / helpers that currently key UI affordances by
`attemptIndex` alone:
- [ ] `src/ui/webview-react/components/layout/OutputSection.tsx`
- [ ] `src/ui/webview-react/components/output/CliOutput.tsx`
- [ ] `src/ui/webview-react/utils/markdownExport.ts` if exported labels should preserve
      run grouping

At minimum, diff-anchor IDs should include `runIndex` so two `attemptIndex: 0` outputs
from different manual runs do not generate duplicate DOM IDs.

---

### Phase 9: Tests

This plan is not implementation-ready without test coverage updates. Add/adjust tests for:

- `src/test/unit/OutputHistoryManager.test.ts`
  Verify timeline write/read preserves two outputs for the same target with
  `(runIndex:0, attemptIndex:0)` and `(runIndex:1, attemptIndex:0)`.
- `src/test/unit/OutputCaptureBuffer.test.ts`
  Verify completed-output replay preserves multiple manual runs for the same step.
- `src/test/unit/WorkflowInstance.test.ts`
  Verify continuation computes incremented `runIndex` for re-run targets, including the
  stop → set-start-position → idle continuation path.
- `src/test/unit/WorkflowExecutor.test.ts`
  Verify emitted `CliOutput` includes the correct `runIndex` for initial attempt and EC retries.
- `src/ui/webview-react/test/store/workflowStore.test.ts`
  Verify live-entry dedupe does not collapse different `runIndex` values.
- `src/ui/webview-react/test/utils/outputUtils.test.ts` or equivalent output-projection tests
  Verify render projection keeps multiple run groups for one step.

---

## Files changed (summary)

| File | Change |
|------|--------|
| `src/types/WebviewMessageTypes.ts` | Add `runIndex?: number` to `CliOutput` |
| `src/types/OutputHistoryTypes.ts` | Add `runIndex: number` to `OrderedCliHistoryEntry` |
| `src/types/WorkflowTimelineTypes.ts` | Add `runIndex` to timeline CLI event draft/event types |
| `src/flightpath/orchestration/OutputHistoryTimelineAdapter.ts` | Key projected CLI entries by `(target, runIndex, attemptIndex)` and default old events to `runIndex: 0` |
| `src/flightpath/WorkflowInstance.ts` | Compute target run indices; populate `targetRunIndices` for continuation / idle-continuation runs |
| `src/flightpath/WorkflowExecutor.ts` | Accept `targetRunIndices`; stamp `runIndex` on queue/finalStep outputs and retry paths |
| `src/flightpath/OutputCaptureBuffer.ts` | Add `runIndex` to buffer types; compound key completed outputs by target+runIndex; update replay/cache logic |
| `src/flightpath/EndConditionHandler.ts` | Forward `runIndex` through `RetryContext` |
| `src/flightpath/orchestration/OutputHistoryManager.ts` | Write `runIndex` to timeline drafts; add optional `getMaxRunIndexForTarget` helper |
| `src/ui/webview-react/hooks/useMessageHandler.ts` | Preserve `runIndex` when constructing ordered live entries |
| `src/ui/webview-react/store/workflowStore.ts` | Extend streaming de-dup key to include `runIndex` |
| `src/ui/webview-react/utils/outputProjection.ts` | Render multiple runIndex groups per step |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Keep diff/minimap/render grouping distinct across runIndex values |
| `src/ui/webview-react/components/output/CliOutput.tsx` (or equivalent) | Display run group header when `runIndex > 0`; include `runIndex` in anchor keys |
| `src/ui/webview-react/utils/markdownExport.ts` | Preserve run labels in export output if history/live output is exported |
| `src/cli/CliTerminalFormatter.ts` | Display manual re-run labeling in CLI mode when `runIndex > 0` |
| `src/test/unit/*` / `src/ui/webview-react/test/*` | Add regression coverage for target/run/attempt uniqueness |

---

## Edge cases

**Step 10 (never ran before) in the complex scenario**: `computeTargetRunIndices` finds
no history entries for step 10 → not added to `targetRunIndices` map → defaults to
`runIndex: 0`. Correct.

**Append continuation (appended prompts after completed run)**: These use a different
code path (`isAppendContinuation`). New steps have no prior history so `runIndex: 0`.
Existing completed steps are not re-run, so their `runIndex` is unchanged.

**Fresh restart (Run button, state=IDLE, currentIndex=0)**: `targetRunIndices` map is
empty (no steps to re-run). All steps get `runIndex: 0`. No change from today.

**STOPPED → Resume (no repositioning)**: The cancelled step re-runs. It has a prior
history entry with `runIndex: 0`. `computeTargetRunIndices` finds it and sets
`runIndex: 1` for that step. The re-run output is now distinguishable. Fixes the
pre-existing duplicate issue for this path too.

**Resume during `finalStep`**: If the workflow is stopped while executing a `finalStep`
loop and then resumed, the same loop index can be re-run. The plan should either:
- include target-keyed `runIndex` support for `final:${loopIndex}` in this same change, or
- explicitly scope `finalStep` out as follow-up work.

Recommendation: include it now, because the storage/projection/buffer layers are already
generic over `OutputExecutionTarget`.

**CLI harness (headless)**: the human-facing label lives in
`src/cli/CliTerminalFormatter.ts`. Treat `runIndex` as display metadata only there:
show a "Re-run N" prefix when `runIndex > 0`, alongside the existing retry labeling.

**History file backward compatibility**: Files written before this change have no
`runIndex` field. Deserializer defaults to `runIndex: 0`. All existing history
displays correctly.

---

## What is explicitly NOT changed

- `EndConditionHandler.getCurrentRetryCount()` / `maxRetries` enforcement: zero changes.
  `promptQueue.getCurrentRetryCount()` is the sole gate for retry limiting. It is reset
  each time a step starts executing, independent of `runIndex`.
- `attemptIndex` meaning: still "EC retry index within the current runIndex (0=initial)".
  The `retryState.currentRetry` display value ("Retry N/M") remains accurate.
- The `SetStartPosition` UI flow: already implemented in the resume-from-idle-offset PR.
  This plan is purely about making the history storage correct for that flow.

---

## Prerequisite

The `stop → set-start-position → resume` UI fix (enabling the Resume button when
`executionState=idle, currentStep>0`) must be merged first. This plan depends on that
code path being exercised.
