# CLI final-step pass retry reuses the previous attempt's event stream

- **Found:** 2026-10-04 by the review step of `CLI_EVENT_RENDERING_PARITY_PLAN.md`
- **Area:** `src/cli.ts`, `src/core/OutputCaptureBuffer.ts`
- **Resolution:** fixed in this commit

## Symptom

In headless `ctrlyoke run`, when a finalStep pass is retried, the retry's events go into the
same `final:<loopIndex>` `CliEventStream` as the failed attempt, so the retry's operations pair
with the earlier attempt's slots. When the failed attempt left a command open (it was killed
mid-command), the retry's run of the same command was treated as superseding it, and its
output printed under a re-emitted header of the failed attempt's command instead of under the
retry's own `…` marker. The earlier attempt's deferred bodies (a `FILE_EDIT` waiting for its
diff) were also never settled, because nothing called `finishEventStream` for a finalStep pass.

## Steps to Reproduce

1. Run a workflow headless whose `finalStep` attempt is interrupted while a Bash command is
   running, so the pass retries.
2. The retry runs the same command.
3. The retry's output prints a second `$ cmd` header belonging to the failed attempt's command.

## Root Cause

`cli.ts` replaced a target's stream in `onPromptStart` and finished it in `onPromptComplete`.
`OutputCaptureBuffer` fires both only for queue steps (`captureOutputInit` and
`captureCompletedOutput`). `captureFinalStepOutputInit` and `captureFinalStepCompletedOutput`
fired nothing, so the CLI never saw a finalStep attempt start or end.

## Fix

`OutputCaptureBuffer` fires `onTargetAttemptStart` (on an attempt's first init, before its
command is known) and `onTargetAttemptComplete` for both queue steps and finalStep passes.
`WorkflowInstance` exposes them as events. `cli.ts` replaces and finishes event streams from
those events for every target, and builds each `CliOutputTarget` through one
`toCliOutputTarget` helper.

The completion event carries the attempt's `PromptAttemptStats`, so the CLI prints the stats
line from it for finalStep passes too; before, it printed stats only from the queue-only
`onPromptComplete`, and a finalStep pass never showed tokens, session, or elapsed time.

The retry summary (`↻ step: N attempts · … total`) was queue-only for the same reason. Its
tally now lives in `CliAttemptTally`, keyed by the output-stream key and fed by the same two
target events (the start event carries `attemptIndex`), so a retried finalStep pass gets its
own summary line.
