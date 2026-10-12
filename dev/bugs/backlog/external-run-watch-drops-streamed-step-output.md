# Dashboard mirror of a CLI run freezes a step's output at its first streamed chunk

- **Found:** 2026-10-12 by Claude while writing `docs/guide/history.md`
- **Area:** `src/core/orchestration/ExternalRunWatchCoordinator.ts`
- **Severity:** medium

## Symptom

When a workflow runs from `ctrlyoke run` and the dashboard (VS Code panel or hosted browser)
mirrors it, a step's output stops updating once the dashboard has shown the step's first output.
Everything the step prints afterwards never arrives, including the step's completed output. The
run still reaches COMPLETED and the step shows as passed, because those come from the run file,
not from the output stream.

Observed with a two-step script workflow whose second step printed "Running integration
tests...", waited 120 s, then printed "42 passed". After the run finished, the dashboard still
showed only the first line for step 2.

## Steps to Reproduce

1. Create a workflow with two script steps. Make the second one print a line, sleep 120 s, then
   print a second line.
2. Open the dashboard, then run the workflow with `ctrlyoke run <file>` in a terminal.
3. The step 2 card shows "Running integration tests..." and never shows "42 passed", either
   during the wait or after the run completes. `events.jsonl` for the run does contain both
   lines.

## Root Cause

`handleExternalRunWatchOutput` (`src/core/orchestration/ExternalRunWatchCoordinator.ts:805-852`)
reloads the run history whenever `manifest.json` changes
(`ExternalRunWatchSession.ts:343-347`; every `appendEvents` rewrites the manifest,
`TimelineRecorder.ts:228-262`). It then decides what to broadcast by counting CLI entries per
step:

```ts
const lastKnown = entry.session.getAndUpdateLastKnownOutputCount(stepIndex, outputs.length);
for (let i = lastKnown; i < outputs.length; i++) { ...notifyCliWatchOutput(...) }
```

But the history projection keeps **one** CLI entry per attempt. Streamed chunks are folded into
that entry, not appended as new entries (`OutputHistoryTimelineAdapter.ts:194-223`, `:298-305`).
The completed aggregate also replaces that entry in place, under the same key. So the count for
a step goes 0 → 1 when the first chunk lands and stays 1 for the rest of the attempt. Every later
change to the entry's content (more streamed text, the final aggregate) is never sent.
`replayExternalWatchHistoryFile` (`:757-803`) has the same count-only bookkeeping.

The end of the run makes it worse. When the run file reaches a terminal state,
`ExternalRunWatchSession.handleWorkingFileChange` calls `signalFinished` (`:238-247`), and
`handleExternalRunFinished` disposes the session and deletes the entry immediately
(`ExternalRunWatchCoordinator.ts:854-865`) without a final history read. A manifest change
that is still in flight is dropped by the `if (!entry) return` guard (`:809-810`), or never
delivered because its watcher has been disposed. So the tail can be lost even after the
count problem is fixed.

## Suggested Fix

- Track what was sent per CLI entry key (target, run index, attempt, phase) by content, not
  just by count. For example, keep the last sent `cliOutput` (or its response length and
  `isStreaming` flag) per key, and re-send an entry whenever it changed. Check that the
  webview's `notifyCliWatchOutput` handler replaces an existing entry for the same attempt
  instead of appending a duplicate.
- In `handleExternalRunFinished`, run one last `handleExternalRunWatchOutput`-style diff
  against the final history before deleting the entry, and await it before
  `notifyWorkflowDismissed`.
- Add a coordinator test that streams two chunks into one attempt, then completes it, and
  asserts that the dashboard receives the final text.
