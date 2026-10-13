# Dashboard Connect Throughput Follow-ups

**Status:** Backlog. Split out on 2026-10-12 from the slow-mobile-connect
investigation, after its first four fixes landed:

- permessage-deflate on the dashboard socket
- a bounded most-recent-workflow lookup on browser READY
- the first recent-workflows fetch moved to STARTUP_COMPLETE, with a loading row
- one shim READY per socket

The two items below are what remains from that investigation.

## Evidence

Measured from the session logs of an iPhone PWA connecting over cellular to a
workspace with 1,448 lineages and about 1,870 run/draft working files:

| Connect (UTC)        | READY → view bound | run view sent | phone loaded it | spinner cleared |
| -------------------- | ------------------ | ------------- | --------------- | --------------- |
| 2026-10-12 21:03:21  | 6.9 s              | 3.6 MB        | 28.7 s          | 38.8 s          |
| 2026-10-12 20:32:11  | 5.1 s              | 2.1 MB        | 14.9 s          | 17.4 s          |
| 2026-10-11 17:15:58  | 0.5 s              | 5–6 MB        | 101.6 s         | 103.7 s         |
| typical fast connect | 0.2–0.3 s          | —             | 0.3–1.5 s       | 0.4–2 s         |

Those rows were recorded before the four fixes. Re-measure before starting
either item; compression alone should cut the "phone loaded it" column several
times over.

## 1. Make the recent-workflows list cheap to build and to resend

**Partly done (2026-10-13).** The list is now built by
`RecentWorkflowCatalog` (`src/core/orchestration/`), and:

- concurrent client requests share one in-flight scan (step 1 below);
  resends after the serializer's own delete/restore still start a fresh one;
- `RecentWorkflowPublisher` pushes a single rebuilt row
  (`RECENT_WORKFLOW_UPDATED`) whenever a loaded lineage's run, state, name or
  step count changes, so new and finished workflows no longer wait for a
  rescan;
- lists and rows carry a sequence taken before their reads, so a slow list
  can no longer overwrite a newer pushed row on the client;
- the client re-requests the list on every reconnect, because pushes sent
  while a phone's socket was down are lost (this costs one scan per
  reconnect, which is what makes steps 2–4 below more pressing).

The dropdown still re-requests the full list on every open. Steps 2–5 remain.

The original analysis follows. A full scan reads, for each lineage:

- reads the descriptor
- reads and parses the current working file
- lists the runs and reads the newest manifest (`getRunNavigationSummary`)
- reads and parses **every** run file in the lineage (`getLineageLastModifiedAt`)

That is roughly 7,600 file reads for one request. They are fanned out through
an unbounded `Promise.all` and saturate libuv's threadpool, which every other
fs call (including the run view a client is waiting on) then queues behind.
The router does not await the handler (`GET_RECENT_WORKFLOWS` in
`WebviewMessageRouter`), so overlapping requests build in parallel rather than
coalescing.

The reply is about 1 MB for 1,448 entries, and every dropdown open on every
client re-requests it. One phone received it 13 times in an afternoon. A
request took about 4 s to answer while a workflow was running.

Suggested order:

1. ~~**Coalesce in-flight builds.**~~ Done: `RecentWorkflowCatalog.list`.
2. **Cache per-lineage entries.** Use the stamp-validated pattern of
   `RunSummaryCache`: key on descriptor plus working-file `mtime`/`size`, and
   write through at the single writers. Note that
   `getLineageLastModifiedUpperBound` (in `WorkingFileMetadata.ts`) already
   gives a stat-only stamp per lineage. A warm cache then costs stats, not
   parses.
3. **Bound concurrency** for cold builds, as `getLineageLastModifiedAt` already
   does with its batch size.
4. **Stop resending unchanged lists.** The client already patches rows in place
   from `WORKFLOW_SUMMARY_UPDATED` (`updateRecentWorkflowFromSummary`) and
   from pushed rows. The `seq` on lists and rows is a starting point: a
   dropdown open could ask "changed since N?" and get either a no-op or a
   delta. Pushes cover only lineages loaded in this host, so a delta still
   has to find lineages changed by other processes (CLI, MCP, other windows)
   and removals and re-favorites, which are not pushed.
5. **Slim each entry.** Absolute `runDirectory`/`draftDirectory` paths repeat
   the same state-root prefix on every row.

Keep the stale-running normalization (`ensureExternalRunWatchSession`) on
whatever path still reads the working file. A cached entry must not bypass it.

## 2. Keep browser log forwarding out of the shared route queue

Every message from every client, the panel included, goes through
`WebviewMessageRouter`'s single serialized `routeQueue`. That includes
`LOG_MESSAGE`, which the browser sends for every `WebviewLog` line. So:

- Browser log lines are timestamped when the queue reaches them, not when they
  were written. A slow handler shifts every later browser log line, which made
  this investigation hard to read: the shim's "socket opened" line landed
  about 8 s after the socket actually opened.
- A chatty client's logs delay every other client's real commands.

`LOG_MESSAGE` has no ordering dependency on workflow state, so handle it in
`route()` before enqueuing, the way `BATCH_APPROVAL_RESPONSE` and
`CHOICE_RESPONSE` already bypass the queue. While there, consider stamping
browser log lines with the client's own `Date.now()`, so the log shows when
the line was written as well as when it was received.

A broader question for the same area is whether one queue for all clients is
still right. A per-client queue would keep one phone's slow READY from
stalling the panel. Before splitting it, audit which handlers rely on
cross-client ordering (controller claims, run-view switches that retire
shared instances).

## Not yet explained

Two symptoms from the same reports were not reproduced from the logs and may
have been side effects of the duplicate READY replay, which is now fixed.
Recheck both before investigating:

- **Duplicate running rows** in the workflow dropdown that clear on their own.
- **An empty terminal on mobile.** The one occurrence in the logs was a
  headless run, which has no PTY to replay, so it was correct. If it recurs on
  a PTY run, log replayed byte counts on the server (`replayTerminalSessionsTo`)
  and write counts on the client (`terminalRegistry`) to tell a missing replay
  apart from a render problem.
