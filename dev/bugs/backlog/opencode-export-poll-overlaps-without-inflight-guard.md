# OpenCode export polling has no in-flight guard, so `opencode export` processes overlap whenever one export takes longer than 1 s

- **Found:** 2026-10-24 by timeout-budget bug sweep workflow (harness-cli)
- **Area:** `src/core/harness/opencode/OpenCodeLogParser.ts`
- **Severity:** medium

## Symptom

During an interactive OpenCode step, ctrlyoke polls `opencode export <sessionId>` every second. Each
call dumps the whole transcript, so the cost grows with the length of the session. Measured on
Windows, one export takes about 0.9 s even when the machine is idle (finder measurement, opencode
1.19.4). The poll does not wait for the previous export to finish. Once an export takes longer than
1 s, the exports overlap:

- Overlapping exports pile up, up to about 10 at once before each one hits its 10 s timeout.
- Each extra process slows the others down.
- If exports reach 10 s, every poll fails and is logged only at trace level, so live streaming stops
  without anyone noticing.

The interval also keeps firing during `finalizeCompletion`, alongside the drain reads and
`getFinalEventsOnCompletion`, until `CliLogMonitor` closes the watcher.

## Steps to Reproduce

1. Run an interactive OpenCode step that produces a long transcript (large tool outputs or diffs)
   while the machine is busy, for example while the agent runs a build or tests.
2. Watch the process list: several `opencode export` processes run at the same time for one session.
3. Once exports take more than 10 s, live output in the dashboard stops updating until completion.

## Root Cause

- `src/core/harness/opencode/OpenCodeLogParser.ts:278-291`:
  `setInterval(async () => { const newEvents = await this.fetchNewEvents(sessionId); ... }, EXPORT_POLL_INTERVAL_MS)`.
  Nothing records that a fetch is already running. Compare `SubagentSourceFollower.poll()`, which
  returns early on `if (this.polling) return;`.
- `:45` sets `EXPORT_POLL_INTERVAL_MS = 1000`.
- `:70-80` (`runOpenCodeExport`) starts a full export each time with `timeout: 10_000`.
- `fetchNewEvents` (:803 onward) dedupes with `seenPartIds`, so overlapping exports do not emit
  duplicate events. They only waste processes and CPU and push the latency of every export up.

## Suggested Fix

Make the poll schedule itself: run one export, then `setTimeout` the next one after it settles. As a
smaller fix, keep an `inFlight` flag and skip a tick while an export is still running.
`PollingFsWatcher.close()` must cancel the pending timeout. Longer term, the export cost grows with
transcript size because each poll dumps the whole session. Prefer an incremental source (OpenCode's
event stream or a per-message API) if one exists, rather than repeated full exports.
