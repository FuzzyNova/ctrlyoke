# Run-View Payload & Paging Plan

**Status:** Backlog — proposed 2026-09-06
**Priority:** P2 (raised to P1 if a run-view load is reported OOM'ing or hanging
the extension host again; the quadratic-CPU half of the original report is
already fixed — see "Already shipped" below)

## Background

Switching to a large completed workflow took ~9.3 s end to end and threw VS
Code's "an extension has stopped responding" dialog. The reproduction is
`PARALLEL_STEPS_PLAN` / `run-2026-09-04T01-35-57-252Z` (18 steps, 19 attempts,
7 537 timeline events, a 63.9 MB `events.jsonl`).

Instrumented against that run, the load broke down as:

| Phase                                                       | Before    |
| ----------------------------------------------------------- | --------- |
| `readAddressedRunView` — definition read                    | 1 ms      |
| `readAddressedRunView` — summaries/descriptor/`loadHistory` | 5 008 ms  |
| `deliverRunView` — build + redact + serialize + send        | 2 265 ms  |
| client — receive → `workflowStore.loadWorkflow`             | ~1 600 ms |

Reading and parsing the 63.9 MB JSONL is not the problem: `readFile` +
`split` + `JSON.parse` of all 7 537 events is ~320 ms.

### Already shipped (2026-09-06)

The 5 008 ms was **not** I/O — it was quadratic CPU in the history projection.
`OutputHistoryTimelineAdapter.hydrateCliOutputsFromResolver` folded each
streamed `cliOutputEventsAppended` batch into its attempt eagerly, so it called
`normalizeCliEvents([...alreadyNormalized, ...batch])` once per batch over an
ever-growing array: 7 371 calls, 1.33 M cumulative input events, 5 254 ms of
the 5 619 ms `loadHistory` measured in isolation. A single step in this run
contributed 721 batches growing to ~1 150 events.

`src/utils/StreamingCliOutputAccumulator.ts` now buffers a run's deltas per
attempt and folds them in with one `normalizeCliEvents` pass, and the same
accumulator replaced the identical per-batch pattern in
`OutputHistoryTimelineAdapter.project`, `RunOutputResolver.resolveAttempt`, and
(as a raw append, since every reader there already normalizes)
`OutputCaptureBuffer.captureEvents`/`captureFinalStepEvents`. Measured on the
same run, in the same app:

| Phase                                      | Before   | After    |
| ------------------------------------------ | -------- | -------- |
| `loadHistory` (isolated)                   | 5 619 ms | 337 ms   |
| summaries/descriptor/history read (in app) | 5 008 ms | 309 ms   |
| `deliverRunView` build + send (in app)     | 2 265 ms | 1 192 ms |
| click → client store loaded (in app)       | ~9.3 s   | ~3.3 s   |

**What remains is a payload-size problem, not a CPU-complexity one**, and that
is what this plan covers.

### Not covered here: the client-side render cost

Measured 2026-09-07, the same run also costs 130 ms of `buildOutputRows` on
_every pane width change_ and renders ~7 100 elements in the minimap, which is
what freezes the UI while the panel is resized. That is a separate, cheaper,
client-side problem — see `dev/backlog/OUTPUT_PANE_RESIZE_PERFORMANCE_PLAN.md`.
It should land first: its minimap quantization is also the compact whole-run
overview that Proposal 1A below currently has no answer for.

## The remaining cost: one 54.5 MB snapshot per client

`readAddressedRunView` builds a complete `WorkflowOutputHistory` for the run and
`deliverRunView` hands the whole thing to every bound client inside a single
`RUN_VIEW_LOADED` message. For this run the history serializes to **54.5 MB**:

| Part                                  | Size    | What it is                                              |
| ------------------------------------- | ------- | ------------------------------------------------------- |
| `activityEntries` (7 372)             | 22.4 MB | the raw streamed text/structured deltas, in wall order  |
| `promptOutputs` (19)                  | 16.4 MB | per-step `workspaceSnapshot` file contents              |
| `orderedEntries` (25, 19 of them CLI) | 15.6 MB | the per-attempt aggregates (13.0 MB of it `structured`) |

That payload is paid for three times on the way out and again on the way in:

1. **`secretRedactionService.redactValue`** deep-walks and rebuilds the entire
   object graph on every hosted-server send
   (`CtrlYokeHostedServer.redactHostedTransportMessage`) — **544 ms** measured
   on this payload, and it runs per message, not per connection.
2. **`JSON.stringify`** — 177 ms.
3. **Transport** — a 54.5 MB WebSocket frame to a browser client; for the VS
   Code panel, a `postMessage` of the same object across the extension-host IPC
   boundary. The panel path is the one that produced "an extension has stopped
   responding".
4. **Client** — `JSON.parse`, then `mapOrderedHistoryEntriesToMessages` over
   7 372 activity entries, then React rendering thousands of rows.

Two structural facts make this worse than it needs to be:

- **`activityEntries` and `orderedEntries[].cliOutput.structured.events` are two
  encodings of the same events.** The client re-normalizes the activity slices
  itself (`normalizeStructuredActivityEvents` in `outputProjection.ts`) to
  rebuild what the aggregate already carries; it needs the per-slice split only
  to interleave text and tool blocks in wall order. 22.4 MB is shipped to
  reconstruct ordering information.
- **Nothing about this scales with the viewport.** The user sees a few screens
  of output; the transfer is sized by the whole run.

## Problem 1: the whole run ships when only a window of it is visible

`RUN_VIEW_LOADED` is all-or-nothing. There is no request shape for "the last N
entries of this run" or "step 12's output", so a client that opens a run to look
at its final step still pays for step 1's 1 148 tool events.

### Proposal 1A — server-side windowing of `orderedEntries`/`activityEntries`

Add a bounded initial window to `readAddressedRunView` (newest-first, since
that is where a run view opens) plus a `LOAD_MORE_RUN_HISTORY`-style request
carrying the address and a cursor, answered from the same streamed read.

The pieces this needs already exist and should be reused rather than
re-implemented:

- `TimelineRecorder.streamEvents` already yields events without materializing
  the file, and `RunMetadataScanner` is the established precedent for answering
  a narrow question from a streamed pass instead of a full
  `OutputHistoryTimelineAdapter.loadHistory()` projection (see
  `.github/instructions/orchestration.instructions.md`). A windowed reader
  belongs alongside those, not as a fourth way to read a run.
- `manifest.json` already carries `eventCount`/`nextSequence`, so a cursor can
  be a `sequence` without a preliminary scan.

The hard part is not the read — it is that `workflowStore`'s history state and
`useOutputRowsModel`/`useOutputMinimapModel` currently assume `historyOutputs`
is the complete run. The minimap in particular is a whole-run overview by
definition and will need either a separate compact summary projection or an
explicit "loaded range" concept. **Design that before writing the reader**;
a windowed payload with a minimap that silently only covers the window is worse
than the current slow load.

### Proposal 1B — stop shipping `activityEntries` alongside the aggregates

22.4 MB (41 % of the payload) exists so the renderer can interleave text and
tool blocks chronologically. The aggregate already holds every event; what the
activity stream adds is (a) the slice boundaries and (b) each slice's timestamp.

Investigate replacing the full delta payload with per-event ordering metadata
on the aggregate's normalized events — the aggregate plus a `timestampMs`
(already present on most `CliEvent`s) may be enough for
`mapOrderedHistoryEntriesToMessages` to produce the same interleaving without a
second copy of the payload. If it is, this is the single largest win available
and it is independent of paging.

Do 1B before 1A if it holds up: it is a projection change with no new protocol
and no client range-tracking, and it shrinks whatever 1A would later page.

## Problem 2: `workspaceSnapshot` contents ride along on every load

`promptOutputs` is 16.4 MB of captured file contents, sent so that a file-edit
row can render `beforeContent` in a diff (`OutputRow.tsx`
`getSnapshotBeforeContent`) and so the minimap can flag changed steps. Diffs are
expanded by the user, one at a time, and most are never opened.

**Proposal:** keep the snapshot _index_ (paths, change kinds, sizes) in the run
view and fetch a file's `beforeContent` on demand through a request keyed by
address + step + path. `OutputHistoryManager.loadHistory()` already enriches
snapshots on read (git-head `beforeContent` hydration), so the on-demand path
must go through the same enrichment rather than reading the timeline directly —
otherwise replay and diff rendering diverge, which the orchestration
instructions already warn about.

Independent of 1A/1B, and probably the cheapest of the three to land.

## Problem 3: redaction re-walks the entire payload per message

`redactHostedTransportMessage` runs `secretRedactionService.redactValue` over
every outbound hosted message — 544 ms on this payload, on the extension host's
main thread, and a second full object graph allocated to hold the result.

This is a security control and must not simply be dropped. The question worth
answering is whether redaction can move to where secrets _enter_ the system
(harness output capture and timeline write) so that persisted history is already
redacted and the transport walk becomes a cheap assertion rather than a full
rebuild. `TimelineRecorder.appendEvents`/`writeManifestDirect` already redact on
write, which suggests the transport walk is largely re-doing settled work — but
that has to be verified per message type, not assumed, before anything is
relaxed. Treat this as an investigation, not a scheduled change.

## Non-goals

- **No worker thread for the run-view read.** Unlike the
  `HistorySearchIndexService` case in
  `dev/implemented/HISTORY_SEARCH_PERFORMANCE_PLAN.md`, there is no OOM evidence
  here and the post-fix read is 309 ms. The cost that remains is the payload
  itself, which a worker would still have to structured-clone back across the
  thread boundary — relocating the problem, exactly as that plan's Phase 2
  design note warns about sending documents back over the channel.
- **No change to how `events.jsonl` is stored or chunked.** Reading and parsing
  the whole file is ~320 ms; the storage format is not the bottleneck and
  changing it would invalidate every existing run.
- **No lazy rendering as a substitute for a smaller payload.** Virtualizing the
  output list would help the last phase only; the extension host still pays
  redaction, serialization, and transport for 54.5 MB, and that is where the
  "extension has stopped responding" dialog comes from.

## Sequencing

1. **Problem 2** (on-demand `workspaceSnapshot` contents) — ~16 MB off the
   payload, no protocol redesign, no client range tracking.
2. **Problem 1B** (drop the duplicated `activityEntries` encoding) — ~22 MB, a
   projection change, but needs the interleaving to be proven equivalent first.
3. **Problem 1A** (windowing + paging) — only worth its complexity if 1 and 2
   leave a payload that still hurts. Design the minimap/range story first.
4. **Problem 3** (redaction) — investigate alongside; independent of the rest.

## Acceptance criteria

- [ ] Opening the `PARALLEL_STEPS_PLAN` reproduction run in both the VS Code
      panel and the hosted browser dashboard no longer triggers VS Code's
      unresponsive-extension dialog.
- [ ] The `RUN_VIEW_LOADED` payload for that run is materially smaller than
      54.5 MB, with the reduction attributable to specific parts (record the
      new breakdown the way this plan records the current one).
- [ ] Whatever is fetched on demand goes through `OutputHistoryManager`, so
      snapshot enrichment and replay semantics stay identical to the eager path.
- [ ] The output panel, minimap, and diff rows render identically to today for
      a fully-loaded run; a partially-loaded run states its own boundaries
      rather than silently presenting a window as the whole run.
- [ ] New coverage for the on-demand/windowed reads in `src/test/**`, and for
      the client's range handling in `src/ui/webview-react/test/**`.
