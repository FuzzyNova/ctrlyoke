# Appending after a torn last line corrupts `events.jsonl` permanently

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (reproduced against the compiled `out/` `TimelineRecorder` from a scratch script)
- **Area:** `src/core/orchestration/TimelineRecorder.ts`
- **Resolution:** fixed in this commit

## Symptom

After the extension host or CLI dies mid-write (for example an extension-host
OOM during a large `appendFile` of CLI output), the run's output history can no
longer be loaded. `readEvents` throws `Expected ':' after property name...`,
which breaks `OutputHistoryTimelineAdapter.loadHistory`, the run view and the
history-search fallback. `streamEvents` silently drops every event after the
torn line, and starts throwing once a later event is appended.

The damage is done by ctrlyoke itself on the next start: crash recovery
(`normalizeStaleLocks` → `recoverInterruptedRun` → `finalizeRun`) appends
`RUN_TERMINATED`, and so do Resume and appending steps to the run.

## Steps to Reproduce

1. `initializeRunAt` a run and append one event.
2. Append a partial line with no trailing newline to `events.jsonl`:
   `{"eventType":"cli_output_recorded","payl`
3. Call `appendEvents([run_terminated])`.
4. The file now contains
   `{"eventType":"cli_output_recorded","payl{"eventType":"run_terminated",...}`
   and `readEvents` throws.

## Root Cause

The readers (`readEvents`, `streamEvents`, `TimelineRecorder.ts` around lines
148-202) tolerate a partial **last** line, which is exactly the shape a crash
leaves. But both appenders — `appendEvents` (around line 253) and
`commitDefinitionRevisionIfNewer` (around line 315) — write straight onto the
end of the file without checking that it ends in `\n`. The next append is glued
onto the torn line, so the invalid JSON ends up in the middle of the file where
the readers no longer tolerate it.

## Suggested Fix

In one shared helper used by both appenders, inside the manifest lock and
before appending, check the file's last byte. If it is not `\n`, truncate the
file back to just after the last `\n` (dropping the torn fragment). Merely
writing a `\n` first is not enough: the torn line would then sit mid-file and
`readEvents` would still throw. The manifest is written after the append, so
`nextSequence`/`eventCount` stay consistent. Add a unit test covering the
torn-tail case for both appenders.
