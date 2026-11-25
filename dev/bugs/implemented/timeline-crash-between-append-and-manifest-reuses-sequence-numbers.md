# A crash between the events.jsonl append and the manifest write makes the next append reuse sequence numbers

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against compiled `out/core/orchestration/TimelineRecorder.js`)
- **Area:** `src/core/orchestration/TimelineRecorder.ts` (`truncateTornEventsTail` ~120, `appendEventLinesAndCommitManifest` ~205-235, `appendEvents` ~340-345, `commitDefinitionRevisionIfNewer` ~403-410)
- **Resolution:** fixed in this commit (the tail scan landed in 6a01803f8; this commit fixes its chunk-boundary bug, adds tests and moves the report)

## Symptom

`events.jsonl` ends up with two events that share a `sequence`, and `manifest.json`'s
`eventCount` stops matching the file. Nothing repairs this later.

Downstream effects:

- History search document ids include the sequence
  (`HistoryRunDocumentBuilder.ts` ~157) and both search paths dedupe on them
  (`HistorySearchService.ts` ~330), so one of the two matching events disappears from
  results.
- The dashboard store merges activity entries by key plus `sequence`
  (`src/ui/webview-react/store/workflowStore.ts` ~657, ~744), so one entry overwrites the
  other.
- 3ddf6da91 showed the same shape (`[1..5, 5, 6, 7, 8]`) breaking
  `OutputHistoryTimelineAdapter` projection.

## Steps to Reproduce

1. In a temp dir, `TimelineRecorder.initializeRunAt(...)`, then `appendEvents([one])`
   (sequence 1, manifest `nextSequence: 2`).
2. Simulate a crash after the append but before the manifest write: append a complete line
   for sequence 2 to `events.jsonl` without updating `manifest.json`. (A variant that also
   adds a torn partial third line, as in a multi-event batch cut off partway, behaves the
   same.)
3. `appendEvents([after-restart])`, which is what crash recovery (`normalizeStaleLocks` →
   recover → `RUN_TERMINATED`), Resume, or appending steps does on the next start.
4. `readEvents` returns sequences `[1 'one', 2 'two', 2 'after-restart']`. The manifest has
   `nextSequence: 3, eventCount: 2` while the file holds 3 events.

Expected: an append is all or nothing, so sequence numbers stay unique.

## Root Cause

`appendEventLinesAndCommitManifest` appends the lines first and then replaces the manifest,
which holds `nextSequence`/`eventCount`. The manifest write is the real commit point. The
rollback added in 3ddf6da91 truncates the file only when that write _throws_. It does
nothing when the process dies between the two writes (extension-host OOM, window reload,
kill; on Windows the window includes the manifest's rename-retry budget).

On the next append, `truncateTornEventsTail` only removes a final line with no trailing
newline. It treats every newline-terminated line as committed, so uncounted complete lines
stay, and the new events are numbered from the stale `manifest.nextSequence`.

The fix note in `dev/bugs/implemented/timeline-append-after-torn-line-corrupts-events-jsonl.md`
("The manifest is written after the append, so nextSequence/eventCount stay consistent")
does not hold for this crash window.

## Suggested Fix

In the shared pre-append path (inside the manifest lock, right after
`truncateTornEventsTail`, used by both `appendEvents` and `commitDefinitionRevisionIfNewer`),
also drop the uncommitted complete lines. Read backwards from the end of `events.jsonl`
and truncate every complete line whose `sequence >= manifest.nextSequence`, using the same
chunked tail scan so a large file is never fully loaded. Stop at the first line whose
sequence is below `nextSequence`. A line that does not parse at the tail is torn, so
truncate it too.

(A sturdier alternative is an additive `committedBytes` manifest field to truncate to, but
older manifests lack it, so the sequence scan is still needed. Prefer the scan alone.)

Tests (`src/test/**/TimelineRecorder*.test.ts`):

- complete but uncounted lines (single event) are dropped and the next append gets
  sequence 2, with `eventCount` matching the file;
- a multi-event batch with complete lines plus a torn final line is fully rolled back;
- a healthy file is never truncated.
