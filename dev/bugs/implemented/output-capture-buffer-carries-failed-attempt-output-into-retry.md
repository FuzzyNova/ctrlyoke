# Output capture buffer carries a failed attempt's streamed output into the next attempt

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); traced in code
- **Area:** `src/core/OutputCaptureBuffer.ts` (`captureOutputInit` ~184-198, `captureFinalStepOutputInit` ~319-331), `src/core/WorkflowExecutor.ts` (`handleHarnessFailure` retry branch ~5210-5236, `createFinalCliOutput` ~3684-3764)
- **Resolution:** fixed in this commit

## Symptom

A prompt step with `errorBehavior: { onError: retry, maxRetries: 2 }` streams
some output, then the harness process exits. On the retried attempt:

- the step's final failure record (and the partial record written when the
  user presses Stop) contains the **earlier** failed attempts' streamed
  events and text as well as its own; and
- switching away from the workflow and back mid-retry replays the earlier
  attempts' text and events as if they belonged to the current attempt.

## Steps to Reproduce

1. A step with `errorBehavior.onError: retry` and `maxRetries: 2`, whose harness
   streams some events and then exits non-zero every time.
2. Attempt 0 streams `E0`, fails, and retries; attempt 1 streams `E1`, fails, and
   retries; attempt 2 streams `E2` and fails for good.
3. The persisted attempt-2 output's `structured.events` is `E0+E1+E2` (whenever
   that is longer than the parsed output's events). With no failure output from
   the harness, `response` is the text of all three attempts joined together.

Unit-level repro: `captureOutputInit(0, …, attemptIndex 0)`, `captureChunk(0, "A")`,
`captureOutputInit(0, …, attemptIndex 1)`, then `getBufferedOutput(0).response`
returns `"A"` with `attemptIndex: 1`.

## Root Cause

`captureOutputInit` keeps `accumulatedText`/`accumulatedEvents` from any existing
buffer entry for the step. This is meant to survive the second init call of the
same attempt (the `onPromptReady` update that fills in `cliCommand`). The buffer
entry is only deleted by `captureCompletedOutput`, which the harness-failure
retry branch (`handleHarnessFailure` → `RETRY`) never calls. The parallel-group
cancel path and the user-cancellation path in `handlePromptSendFailure` don't
call it either. So the next attempt, or the next run of that step, inherits the
old accumulation. `createFinalCliOutput` then prefers the buffered events when
there are more of them than parsed events, and falls back to the buffered
`response`. `replayTo` replays the combined buffer. `captureFinalStepOutputInit`
has the same problem, keyed by loop index.

## Suggested Fix

In both init methods, keep the accumulated text and events only when the
existing entry has the same `attemptIndex` **and** `runIndex`. Otherwise start
from empty. Add `OutputCaptureBuffer` unit tests for these cases: same-attempt
re-init keeps the accumulation; a new attempt or run starts empty; and the
same for final steps.
