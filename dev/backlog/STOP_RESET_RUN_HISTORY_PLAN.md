# Stop → Reset → Resume: Correct Output History with runIndex

## Problem

When a user stops a workflow, repositions via "set start position", and resumes, steps
that re-run write new history entries with `attemptIndex: 0` — the same value used by
their original run. This produces duplicate, indistinguishable entries in the history
file and in the in-memory `OutputCaptureBuffer`.

The same issue exists for the simpler STOPPED → Resume path (no repositioning): the
cancelled step's partial output (`att:0`) and the re-run output (`att:0`) are both in
history with the same identifier.

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

### Phase 1: Data model

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

Backward compatibility: when reading history files that predate this change, treat
missing `runIndex` as `0`.

---

### Phase 2: Determine runIndex before execution

**`src/flightpath/WorkflowInstance.ts`** — In `executeLoadedPromptFile`, when
`continueFromCurrent=true` AND `currentIndex > 0`, query the history file to determine
the `runIndex` to use for each step that will re-run:

```typescript
// Called only on continuation runs (continueFromCurrent=true, currentIndex > 0)
private async computeStepRunIndices(
  historyFilePath: string,
  fromStepIndex: number,
  totalSteps: number
): Promise<Map<number, number>> {
  const indices = new Map<number, number>();
  if (!historyFilePath) return indices;

  try {
    const history = await this.outputHistoryManager.loadHistory(historyFilePath);
    for (const entry of history.orderedEntries) {
      if (
        entry.kind === OUTPUT_HISTORY_KINDS.CLI &&
        entry.target.kind === FINAL_STEP_PHASES.QUEUE
      ) {
        const { stepIndex } = entry.target as { kind: ...; stepIndex: number };
        if (stepIndex >= fromStepIndex) {
          const existing = indices.get(stepIndex) ?? -1;
          const entryRunIndex = (entry as any).runIndex ?? 0;
          indices.set(stepIndex, Math.max(existing, entryRunIndex));
        }
      }
    }
  } catch {
    // History unreadable — start at runIndex 0 for all steps
  }

  // Increment: the re-run gets max(existing) + 1
  for (const [stepIndex, maxRunIndex] of indices) {
    indices.set(stepIndex, maxRunIndex + 1);
  }

  return indices;
}
```

Pass the result as `stepRunIndices` in `WorkflowExecutionContext` before calling
`startWorkflowExecution`.

---

### Phase 3: Thread runIndex through the execution context

**`src/flightpath/WorkflowExecutor.ts`** — Add to `WorkflowExecutionContext`:
```typescript
export interface WorkflowExecutionContext {
  // ... existing fields ...
  /**
   * Per-step run index for continuation runs (stop→reset→resume).
   * Absent (or empty) for fresh starts: all steps default to runIndex 0.
   */
  stepRunIndices?: Map<number, number>;
}
```

In `WorkflowExecutor`, when building a `CliOutput` for a queue step, look up
`context.stepRunIndices?.get(stepIndex) ?? 0` and set `output.runIndex = runIndex`.

Pass `runIndex` through to:
- `captureOutputInit` (OutputCaptureBuffer)
- `buildCliOutput`
- `notifyCliOutput` → dashboard

---

### Phase 4: OutputCaptureBuffer

**`src/flightpath/OutputCaptureBuffer.ts`**

Add `runIndex` to `StepOutputBuffer` and `CompletedStepEntry`:
```typescript
interface StepOutputBuffer {
  // ... existing ...
  runIndex: number;
}
```

`captureOutputInit` accepts `runIndex` parameter (default 0) and stores it.

`captureCompletedOutput` uses `(stepIndex, runIndex)` as the compound key for
`completedStepOutputs` so that re-run entries don't collide with original entries.
Change the map key from `stepIndex: number` to a compound key
`${stepIndex}:${runIndex}` (or use a nested Map).

`sendFullStateToDashboard` replays all runs for each step in order:
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

- `writeCliOutput`: Include `runIndex` (defaulting to 0) in the written
  `OrderedCliHistoryEntry`.
- `loadHistory`: When deserializing older files, default missing `runIndex` to 0.
- New helper `getMaxRunIndexForStep(historyFilePath, stepIndex)`: queries the history
  file and returns `max(runIndex)` for a given step. Used by `computeStepRunIndices`.

---

### Phase 7: Dashboard broadcast and webview store

**`src/ui/DashboardBroadcastHub.ts` / `FlightPathWebviewProvider.ts`**

`updateCliOutput` already passes `CliOutput` as-is; `runIndex` rides along for free.

**`src/ui/webview-react/store/workflowStore.ts`**

`appendLiveEntry` de-duplicates streaming entries by `(target, attemptIndex)`. Extend
to `(target, runIndex, attemptIndex)` so re-run streaming entries don't overwrite the
original streaming entry.

---

### Phase 8: UI rendering

**`src/ui/webview-react/utils/outputProjection.ts`**

Currently projects `OrderedHistoryEntry[]` into renderable output. When multiple
`runIndex` values exist for the same step, each runIndex should render as a distinct
output group with appropriate labeling.

Display options (pick one — decide at implementation time):
- **Option A**: Show as sequential collapsed blocks within a step: "Run 1" / "Run 2"
  headers (similar to how retry blocks work today).
- **Option B**: Only show the most recent `runIndex` in the live output, with a
  "previous runs" disclosure.
- **Option C**: Show all runs sequentially without grouping headers (simplest; all
  attempts are already shown today for EC retries).

Recommendation: **Option A** for clarity. Reuses the existing attempt-collapse
component pattern.

---

## Files changed (summary)

| File | Change |
|------|--------|
| `src/types/WebviewMessageTypes.ts` | Add `runIndex?: number` to `CliOutput` |
| `src/types/OutputHistoryTypes.ts` | Add `runIndex: number` to `OrderedCliHistoryEntry` |
| `src/flightpath/WorkflowInstance.ts` | Add `computeStepRunIndices`; populate `stepRunIndices` in context for continuation runs |
| `src/flightpath/WorkflowExecutor.ts` | Accept `stepRunIndices` in context; stamp `runIndex` on outputs |
| `src/flightpath/OutputCaptureBuffer.ts` | Add `runIndex` to buffer types; compound key for `completedStepOutputs` |
| `src/flightpath/EndConditionHandler.ts` | Forward `runIndex` through `RetryContext` |
| `src/flightpath/orchestration/OutputHistoryManager.ts` | Read/write `runIndex`; add `getMaxRunIndexForStep` helper |
| `src/ui/webview-react/store/workflowStore.ts` | Extend streaming de-dup key to include `runIndex` |
| `src/ui/webview-react/utils/outputProjection.ts` | Render multiple runIndex groups per step |
| `src/ui/webview-react/components/output/CliOutput.tsx` (or equivalent) | Display run group header when `runIndex > 0` |

---

## Edge cases

**Step 10 (never ran before) in the complex scenario**: `computeStepRunIndices` finds
no history entries for step 10 → not added to `stepRunIndices` map → defaults to
`runIndex: 0`. Correct.

**Append continuation (appended prompts after completed run)**: These use a different
code path (`isAppendContinuation`). New steps have no prior history so `runIndex: 0`.
Existing completed steps are not re-run, so their `runIndex` is unchanged.

**Fresh restart (Run button, state=IDLE, currentIndex=0)**: `stepRunIndices` map is
empty (no steps to re-run). All steps get `runIndex: 0`. No change from today.

**STOPPED → Resume (no repositioning)**: The cancelled step re-runs. It has a prior
history entry with `runIndex: 0`. `computeStepRunIndices` finds it and sets
`runIndex: 1` for that step. The re-run output is now distinguishable. Fixes the
pre-existing duplicate issue for this path too.

**CLI harness (headless)**: `CliOutput` is also used in CLI output formatting
(`src/flightpath/harness/shared/CliOutputFormatter.ts`). The `runIndex` field should
be treated as display metadata only — CLI output formatters should display a
"Re-run N:" prefix when `runIndex > 0`, similar to retry block labeling.

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
