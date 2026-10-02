# Panel reconnect clears the shared terminal replay buffer

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/ui/TerminalMessageHandlers.ts`, `src/core/harness/PtyProcessManager.ts`
- **Severity:** medium

## Symptom

After the VS Code dashboard panel's webview is recreated while an embedded
terminal is running (Developer: Reload Webviews, moving the view to another
container, or a panel reload after an extension-host hiccup), any of the
following gets an empty or truncated terminal:

- a hosted browser dashboard (phone/desktop) that connects afterwards,
- the panel itself if it is recreated a second time,
- the failure-output tail captured when the AI CLI exits non-zero.

## Steps to Reproduce

1. Start a workflow step that uses the embedded (interactive) terminal and let
   it print output.
2. Run "Developer: Reload Webviews" (panel READY → `reconnectPanel`). The
   panel correctly shows the scrollback.
3. Open the hosted dashboard in a browser (or reload webviews once more).
4. The terminal shows only output produced after step 2; earlier scrollback is
   gone. If the CLI then exits non-zero, the failure message's output tail
   is also cut off at step 2.

## Root Cause

`PtySession.reconnectBuffer` is a single bounded (≈50 KB) per-session replay
buffer, read by three consumers:

- `TerminalMessageHandlers.reconnectPanel` (panel READY),
- `WorkflowOrchestrator.replayTerminalSessionsTo` (browser client READY),
- `CliIntegration` → `CliFailureTracker.capturePtyExit`, which extracts the
  interactive output tail for failure reporting.

`reconnectPanel` calls `session.clearReconnectBuffer()` after flushing to the
panel (#selection:src/ui/TerminalMessageHandlers.ts:81-89), treating the
buffer as a one-shot queue for that one consumer. The other consumers lose
everything buffered before that point. The buffer is already size-capped in
`PtySession.bufferChunk`, so clearing it does not save any memory.

## Suggested Fix

Drop the `clearReconnectBuffer()` call in `reconnectPanel` (and remove
`PtySession.clearReconnectBuffer` if nothing else uses it). Every reconnecting
client recreates its xterm from scratch, so replaying the full bounded buffer
is correct for each one. Add a unit test: buffer output, call
`reconnectPanel`, then check that the session's `reconnectBuffer` still holds
the output, and that a second `reconnectPanel` replays it again.
