# Timeout, cancel and PTY-exit handlers stay armed during the 2 s post-completion drain and can turn a completed step into a failure

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/CliLogMonitor.ts`
- **Severity:** low

## Symptom

A step can finish its turn and still be recorded as a failure. The Stop hook has fired, `onResponseComplete` has been called and the response has been logged, yet the step is stored as one of these:

- a timeout (`FAILURE_KINDS.TIMEOUT`, `timedOut: true`)
- a user cancellation
- an unexpected process exit (`FAILURE_KINDS.PROCESS_EXIT`)

This happens when the timeout fires, the user presses Stop, or the PTY exits during the fixed 2 s post-completion drain. It can also happen during the final-events, OTel and process-log reads that follow the drain.

## Steps to Reproduce

1. Set `maxPromptTimeout` so that a turn's Stop hook arrives within 2 s of the deadline. In a unit test, use a short `timeoutMs` and a notification monitor that reports completion at `timeoutMs - 500` ms.
2. The Stop hook calls `handleCompletion` and then `finalizeCompletion`. `completed` becomes `true`, and `drainLogEvents` starts its fixed 2000 ms loop.
3. During the drain, the `setTimeout` callback (`CliLogMonitor.ts:789`) fires and calls `resolveFailure`. Its `drainLogEvents()` call returns at once because `draining` is already `true`. It then calls `resolve({ success: false, failureKind: TIMEOUT, timedOut: true })`.
4. The drain finishes. `finalizeCompletion` logs the response, fires `onResponseComplete` and calls `resolve({ success: true, ... })`. That call is ignored because the promise has already settled.
5. `monitorLogFile` returns `success: false` with `timedOut: true`, and the step is saved as a timeout.

The same thing happens if `runtimeState.isCancelling()` or `isPtyTerminated()` becomes true within about 2 s of the Stop hook. The step then resolves as cancelled or as a process exit instead of a success.

## Root Cause

In `src/core/harness/CliLogMonitor.ts`, `finalizeCompletion` sets `completed = true` at l.283. It does not clear `timeoutHandle` or `cancellationInterval` until l.397-402. Before that point it awaits three things:

- `drainLogEvents()` (l.286). Its loop at l.651-664 is bounded only by `DRAIN_DEADLINE_MS = 2000` (l.25) and has no early exit.
- `parser.getFinalEventsOnCompletion()` (l.288).
- The OTel and process-log reads (l.314-380).

Three paths can settle the promise during that window, and none of them checks `completed`:

- the timeout callback (l.789-798), which calls `resolveFailure` (l.208)
- the cancellation branch of the interval (l.822-877), which calls `resolve` directly at l.870
- the PTY-exit branch of the interval (l.879-897), which calls `resolveFailure`

Once `draining` is set, the `drainLogEvents()` call inside `resolveFailure` (l.228) does nothing (l.646-648). The failure path therefore settles the promise well before `finalizeCompletion` reaches its success `resolve` at l.405. A promise keeps its first value, so the step resolves as a failure even though `onResponseComplete` (l.403) still fires for it.

The interval's OTel polling is already gated on `!completed` (l.807). The settle paths that follow it in the same interval body are not.

## Suggested Fix

Once completion is committed, disarm the paths that compete to settle the promise. In `finalizeCompletion`, clear `timeoutHandle` and `cancellationInterval` right after `completed = true` and before `await drainLogEvents()`.

A more robust option is a single `settled` flag, or a `settleOnce` wrapper around `resolve`, that every path checks before it acts. That covers `resolveFailure`, the timeout callback, the cancellation branch and the PTY-exit branch. The first outcome to commit then wins every time, and `onResponseComplete` never fires for a step that resolves as a failure.

Also consider having `drainLogEvents` exit after a short quiet period, so the vulnerable window is shorter than a flat 2 s.

Add `CliLogMonitor` unit tests in which the timeout, a cancellation or a PTY exit fires during the drain, and assert that `success: true` is returned.
