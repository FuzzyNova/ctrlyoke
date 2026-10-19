# Post-completion follow-up output is missing from prior context

- **Found:** 2026-10-18 by user (media-plan run, `$previous:summary` in step 3)
- **Area:** `src/core/orchestration/RunOutputResolver.ts` (`createSettledAttemptEvent`, `finishAttemptState`, `foldSettledAttempt`, `resolvePriorContextItems`)
- **Resolution:** fixed in this commit

## Symptom

After a step completed, the user steered the same session ("commit it, also I have the gh CLI
installed…"). The harness replied with several messages ("You can let me do it: `gh` is signed
in…", "I created the private repo…") and edited the plan again. The output pane showed all of
it, but the next step's `$previous:summary` held only the step's original response, and its
`<filesChanged>` missed the follow-up's edits. Full detail (`$previous`) dropped the same events.

## Steps to Reproduce

1. Run an AI step to completion.
2. Send a follow-up message to the same session after the run completes.
3. Add a step referencing `$previous` or `$previous:summary` and run it.
4. The injected `<priorContext>` contains none of the follow-up's text, steers or file changes.

## Root Cause

`OutputHistoryManager.recordFollowUpResponse` writes a follow-up burst as a content-free
`followUpResponseAppended` marker plus a `cliOutputEventsAppended` batch. It never re-records the
attempt's `cliOutputRecorded` aggregate. `RunOutputResolver.streamAttempts` reopens the settled
attempt as a continuation and buffers the batch as deltas, but `finishAttemptState` only flushed
deltas onto an output that already existed and was streaming. A continuation has no output of its
own, so the batches were discarded. `foldSettledAttempt` and `resolvePriorContextItems` then kept
the pre-follow-up aggregate. Their only continuation model was a re-recorded cumulative aggregate,
which the current writer never produces.

## Fix

A continuation that recorded only streamed events now settles with those events as its output,
flagged `appendsOutput`. `foldSettledAttempt` appends them to the held output instead of replacing
it. `resolvePriorContextItems` concatenates the follow-up transcript onto the held one and merges
its file changes. A continuation that re-records a cumulative aggregate still supersedes the held
value.
