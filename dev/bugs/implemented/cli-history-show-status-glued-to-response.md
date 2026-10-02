# `ctrlyoke history show` prints the attempt status on the same line as the response

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reproduced with the built CLI against real run history
- **Area:** `src/cli/HistoryInspectionCommands.ts` (`renderHistoryAttempt`, ~605-627)
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke history show --workflow <key> --run <n> --step <i> --no-color` prints
`[3 Step 3] Bye! 👋│ ℹ Attempt completed`. The response text and the status
message end up on one line. This happens for every AI attempt with text output.

## Root Cause

`renderHistoryAttempt` renders streamed text into the formatter's streaming
buffer and then calls `CliTerminalFormatter.renderStatusMessage` (the
unterminated or terminal status). Only after that does it call
`flushStreamingBuffer(target)`. The formatter's rule is to flush before any
non-text event.

The live `onStatusMessage` path in `src/cli.ts` (~1156) also calls
`renderStatusMessage` without flushing, so live streamed text can interleave
with status lines the same way.

## Suggested Fix

Call `flushStreamingBuffer(target)` before the status messages in
`renderHistoryAttempt`. Preferably have `renderStatusMessage` (or a small
wrapper both call sites use) flush any pending streaming buffer itself, so
callers can't forget. Add a unit test asserting the status line starts on its
own line.
