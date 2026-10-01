# Run-View Payload & Paging Plan

**Status:** Backlog — proposed 2026-09-06, updated 2026-10-01
**Priority:** P1 (raised 2026-10-01: a phone viewing a large run was caught in
a reload loop that rebuilt and resent the full run view about every 10 s; see
"2026-10-01 evidence" below. The quadratic-CPU half of the original report is
already fixed — see "Already shipped" below)

## 2026-10-01 evidence: a phone reload loop

Measured with the `[MemoryWatchdog]`/`[PanelMemory]` samplers (see the
"Crash investigation" note in `.github/copilot-instructions.md`) on the
`bug-backlog` run `run-2026-09-30T13-41-01-546Z` (38 steps, a 43.7 MB
`events.jsonl`, 61 history entries, 8 062 activity entries). Session log:
`.ctrlyoke/logs/ctrlyoke-1790824029160.log`.

- **Each open is a 42.7 MB `RUN_VIEW_LOADED`.** Building one spikes the
  extension-host heap by 300–650 MB (reading the history, the redaction copy,
  `JSON.stringify`), and the VS Code panel's heap by about 420 MB on receipt.
  All of it is transient: the heap returned to ~270 MB each time.
- **An iPhone PWA viewing the run kept reconnecting.** WebSockets closed with
  code 1006 after 2–36 s, and each new connection asked for the run again: at
  least 29 deliveries in 10 minutes (~1.2 GB serialized), against 3 to the panel.
  The likeliest cause is iOS killing the page while it parses and renders the
  payload, but nothing on the phone side was measured. Overlapping rebuilds
  pushed the extension-host heap to 1 736 MB (limit 4 192 MB).
- **Where this run's bytes are** (`events.jsonl`, by field): 7.8 MB of
  `bashCommand.output` and 4.9 MB of `toolResult.result` (tool output the
  dashboard collapses to 3 lines by default), 14.9 MB of
  `cliOutputRecorded.structured` (the per-attempt aggregate that duplicates the
  appended deltas, i.e. Proposal 1B's duplication), and 8.6 MB of
  `workspaceSnapshotCaptured` (Problem 2).
- **Resuming a running instance sends the history twice to the panel.** The
  panel received `RUN_VIEW_LOADED` (61 entries), then `SESSION_RESTORED`
  followed by `OUTPUT_HISTORY_LOADED` with the same 61/8 062 entries
  (`WorkflowInstance.replayOutputHistoryTo`), so it built the run twice in a
  few seconds. The server built it twice too (see Problem 5), and browser
  connects take the same path, so each phone reconnect probably cost two
  history builds rather than one. That last point comes from reading the code;
  the logs did not measure it.

That run also crashed the machine three times. Those crashes were a test that
looped forever (`dev/bugs/backlog/extension-host-crash-during-long-bug-backlog-run.md`),
not this payload. The reload loop is real regardless.

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

Measured in the hosted dashboard 2026-09-07, the client side of this same run
was the larger half: 15.6 s of blocked main thread against 1.5 s of
extension-host work. Almost all of it was `buildOutputRows` recomputing one
constant undo answer once per message — fixed the same day, taking the worst
blocked frame to 2 142 ms. The rest of that work is now complete and lives in
`dev/implemented/OUTPUT_PANE_RESIZE_PERFORMANCE_PLAN.md`: the per-pane-width
rebuild is bucketed to 32 px and deferred until a resize settles, and the
minimap is quantized to rail pixels. Two things there matter here. First,
`quantizeOutputMinimapBars` (`src/ui/webview-react/utils/outputMinimapBars.ts`)
was deliberately written as a structural projection rather than a view detail,
so it is the compact whole-run overview that Proposal 1A below currently has no
answer for — a windowed reader can produce the same bar array without
materializing every row. Second, that plan's measurements found the remaining
mount cost is React commit and style/layout across ~5 000 rows, not any single
hot function, which is precisely the cost windowing addresses.

Note for anyone re-measuring the numbers below: the payload sizes are
unchanged, but the `~1 600 ms` client figure in the table above predates that
fix and the 2026-09-06 one, and was measured in the VS Code panel rather than
the browser.

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

#### If 1A is ever needed: tuning constraints

The output pane already keeps _rendering_ separate from _data_:
`useOutputVirtualization` virtualizes rows with an adaptive overscan, and
`useOutputScrollSeek` swaps in `OutputScrollSeekPlaceholder` during fast
scrolls. Paging changes only the data side. **The fetch window must not be the
viewport.** If it were, every scroll past the loaded edge would wait on a
round-trip, and on a phone that wait is easy to see. Settle these before writing
the reader:

- **Page by step-attempt, not by row.** Rows exist only after the client runs
  `buildOutputRows`, and their heights vary by orders of magnitude, so the
  server cannot count or size them. The unit is an `orderedEntries` entry (one
  CLI attempt or other history entry), together with its activity slices. The
  existing pagers (`usePagedCommitHistory`, `usePagedFileHistory`,
  `usePagedGitRefDiff`, `usePagedWorkspaceDirectory` over
  `VirtualizedPagedList`) use a fixed `pageSize` over a known total of
  uniform-height items. Reuse their direction-aware prefetch logic, not their
  paging model.
- **Ship a skeleton with the first window.** The initial payload carries one
  small record per step-attempt for the whole run: target key, status, event
  count or byte size, and an estimated height. It also carries the minimap
  bars (`quantizeOutputMinimapBars` can produce them from this data without
  building any rows). That keeps scroll height, the scrollbar thumb, and the
  minimap correct before any content arrives. An unloaded attempt renders as a
  placeholder of its estimated height, reusing `OutputScrollSeekPlaceholder`,
  so a fetch that lands only changes heights the virtualizer is already
  handling.
- **Use a byte budget with a prefetch margin, not a row count.** Size each
  page by serialized bytes (on the order of 1–2 MB), and keep at least a few
  screen-heights loaded ahead of the scroll direction. Start the next fetch
  when the user scrolls within that margin of the loaded edge, not when they
  reach it. A minimap click or a find/navigation jump into an unloaded region
  fetches the attempt containing the target first, then widens around it.
- **Bound what the client keeps.** Loaded attempts accumulate in
  `workflowStore`. Decide whether to evict far-away pages (which costs a
  refetch on scroll-back) or keep everything once loaded (which caps the
  savings at the first window). Keeping everything is the simpler default;
  re-measure on the phone before adding eviction.
- **Give find, export, and copy-all an answer over unloaded ranges.** This is
  the same consumer list as Proposal 1C below, and the two proposals should
  share one answer, most likely to run these on the extension side against the
  full history.

### Proposal 1B — stop shipping `activityEntries` alongside the aggregates

22.4 MB (41 % of the payload) exists so the renderer can interleave text and
tool blocks chronologically. The activity stream carries structured event
payloads and their slice boundaries/timestamps, plus standalone text deltas;
the persisted-run comparison below also found some event fields missing from
the corresponding aggregate.

**Investigation (2026-10-01): exact replacement does not hold.** The candidate
cannot reproduce every current row from `orderedEntries[].cliOutput.structured.events`
plus ordering metadata alone:

- Plain-text and script stdout are persisted as
  `CLI_OUTPUT_CHUNK_APPENDED` string deltas. `StreamingCliOutputAccumulator`
  concatenates them into `cliOutput.response`; they are not represented in
  `structured.events`. For example, activity slices `(seq 2, text "before ")`,
  `(seq 3, bash tool)`, `(seq 4, text "after")` become one response string
  (`"before after"`) plus the tool event. No per-event timestamp or slice
  marker can recover which side of the tool each part occupied. The committed
  Vitest harness pins this counterexample and also verifies equality for a
  structured-only fixture with missing `CliEvent.timestamp`, paired tool
  events across slices, retries, a parallel group, a final-step loop, and a
  phase-distinct condition attempt.
- A scratchpad comparison against the available persisted
  `bug-backlog/run-2026-09-30T13-41-01-546Z` run also differed: current
  projection built 6,600 rows, while the aggregate-event candidate built
  6,581. This loaded projection had 73 ordered entries and 8,661 activity
  entries, all structured (no plain-text activity). The first differing row
  showed streamed event fields including `callerType: "direct"` and optional
  event-data properties that were absent from the corresponding aggregate
  event. Ordering metadata cannot restore event payload fields that the
  aggregate does not contain.

The current projection sorts activities by `(timestampMs, sequence)`. It groups
structured slices by target/run/attempt/phase, flattens each attempt, then uses
`normalizeCliEventsWithSource` to pair calls/results and anchor the merged event
to the slice that opened it. A completion slice absorbed into an earlier
operation disappears. Text/script chunks coalesce only while adjacent in the
globally sorted activity stream and with the same identity. `CliEvent.timestamp`
is optional and is not the timeline slice timestamp; the sequence and timestamp
on the activity entry are the ordering source. Retry, phase, parallel, and
final-step identities all participate in this ordering.

**A narrower saving remains possible.** Keep TEXT, SCRIPT, and STATUS activity
entries, since their chunk boundaries/order (and status severity) affect rows.
For structured entries, make the aggregate a lossless canonical copy first,
then assign each normalized event its originating slice's
`activityTimestampMs` and `activitySequence` and omit only the duplicate
structured activity payload. The source mapping must use
`normalizeCliEventsWithSource` so a paired completion retains the opening
slice's order. Assign it while `OutputHistoryTimelineAdapter` folds each
`CLI_OUTPUT_EVENTS_APPENDED` batch through `StreamingCliOutputAccumulator`;
the resolver path and completed `CLI_OUTPUT_RECORDED` replacements must retain
the same event fields and metadata. The real-run mismatch above means adding
order fields alone is insufficient: first resolve why fields such as
`callerType` differ, and compare every normalized event payload. The measured
structured activity projection for that run was about 19.4 MB serialized, so
this narrower option may still save substantial duplicate bytes, but its net
payload reduction needs a fresh measurement after the canonical aggregate is
lossless. It does not eliminate all `activityEntries` or justify switching the
webview wholesale to aggregates.

### Proposal 1C — cap tool output in the payload, fetch the rest on expand

Tool output is the largest content the user mostly never expands: in the
2026-10-01 run, 7.8 MB of `bashCommand.output` and 4.9 MB of
`toolResult.result`, all shipped in full while the output pane collapses each
one to 3 lines (`outputTruncation.ts` `buildCollapsedOutputPreview`;
`outputRows.ts` character budget and `maxResultLines`). No message type
fetches an entry's full content today, and nothing on the history path
truncates (`OutputHistoryManager.loadHistory`, `RunViewPublisher.deliverRunView`
and both `OUTPUT_HISTORY_LOADED` senders pass the history through as is).

Send each tool output capped (head plus a byte count and a "truncated" marker)
and add a request keyed by address, attempt and event for the full text, used
when a row is expanded. `TimelineRecorder.truncateHistorySearchEvent` already
caps exactly these fields for search indexing; reuse its per-field knowledge
rather than writing a second truncator.

Before doing this, deal with every webview consumer of the full text. Each one
needs either the fetch or an explicit "truncated" state:

- in-pane find (`useOutputFind.ts` → `utils/outputFind.ts`);
- Markdown export (`useOutputExport.ts` → `utils/markdownExport.ts`, which
  writes bash output in full);
- copy (`OutputRow.tsx` row copy, `useOutputContextMenu.tsx` copy-all and
  copy-hovered);
- the expanded `BashOutput` and tool-result views.

Export and copy-all probably belong on the extension side, where the full
history can be read directly.

Land this in the same order as Problem 2. The full-text fetch comes first, with
the payload uncapped. Capping is switched on only in the commit where the last
consumer above stops assuming the full text is present. Live streaming output
(the in-memory buffer replay) stays uncapped, so every consumer must accept both
capped and complete entries.

**Infrastructure (2026-10-01):** The first step adds a request/reply
for one normalized aggregate event, addressed by run, target, attempt, and
event index, plus a cached webview client. The extension resolves it through
`OutputHistoryManager.loadHistory()`, preserving the same normalization and
snapshot enrichment path as the view. Markdown export and Copy All hydrate any
marked event before formatting.

**Landed (2026-10-01):** `RUN_VIEW_LOADED` now caps bash output and tool-result
text in both the normalized aggregate events and activity slices. Persisted
history and live buffered replay remain complete. Expand and row-copy actions
fetch the full normalized event; Copy All and copy-hovered hydrate before
formatting. In-pane find searches the capped head and displays “Matches in
truncated outputs may be missed.” Collapsed Bash rendering is unchanged because
the 400,000-byte head exceeds the pane's 100,000-character collapsed preview
budget, including four-byte UTF-8 characters.

Measured with a scratch script against the user's
`bug-backlog` run `run-2026-09-30T13-41-01-546Z`: the largest individual bash
output/error or tool-result output/error field in `events.jsonl` was 55,979
bytes, below the 400,000-byte cap. The projection therefore saved **0 bytes**
on this run. The 7.8 MB and 4.9 MB totals describe all output text, but no
individual field reached the cap.

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

**Consumers the fetch must cover (added 2026-10-01 during staging).** Diff
rows are not the only reader of snapshot contents. The undo/redo dialogs build
their input in the webview from the same snapshot:
`useOutputUndoActions.ts` passes `promptUndo.workspaceSnapshot` and
`row.workspaceSnapshot` to `buildUndoDialogInputForPrompt` /
`buildUndoDialogInputForSpecificEvent`, which read `beforeContent` and
`contentToRestore` (`SnapshotFileChange` in `OutputHistoryTypes.ts`). Strip
both fields from the index, and make every one of these consumers fetch, or
state explicitly that the content is unavailable. `structuredPatch`,
`afterHash`, `lineEnding`, `changeType` and `contentCaptureSkipped` are small
and stay on the index.

**Landing order.** Land the fetch request and its extension-side handler
first, with the payload unchanged. Then switch the webview consumers to it and
strip the contents in the same commit, so no commit leaves a consumer reading a
field that is no longer sent. The on-demand reply is an ordinary outbound
message, so on the hosted server it still goes through
`redactHostedTransportMessage`. The same rule applies to the Proposal 1C fetch.

Independent of 1A/1B, and probably the cheapest of the three to land.

**Landed (2026-10-01):** `RUN_VIEW_LOADED` retains the snapshot index and strips
`beforeContent` and `contentToRestore` from entries that have captured content,
marking those entries with `contentAvailableOnDemand`. The index retains paths,
change kinds, base source, patches, hashes, line endings, capture-skipped state,
and repo metadata. `OutputHistoryManager.loadHistory()` remains full because
startup, external-run, and undo-record callers use its enriched history; only
`RunViewPublisher` projects the lean client payload.

`REQUEST_WORKSPACE_SNAPSHOT_CONTENT` / `WORKSPACE_SNAPSHOT_CONTENT` and the
address/target/path client cache serve the content through the same history
manager enrichment. File-edit rows fetch when a diff expands. Prompt, file, and
workflow undo dialogs fetch indexed content before opening. The minimap still
uses `changedFiles` from the index. Live in-memory snapshot messages retain
their full bodies; webview consumers support both full live snapshots and
content-marked run-view indexes. Undo execution re-reads `restore-content`
instructions from addressed history and ignores client-supplied bodies.

Measured on `bug-backlog` run
`run-2026-09-30T13-41-01-546Z`: stripping snapshot body properties from the
45 persisted `workspaceSnapshotCaptured` records removes 8,982,233 serialized
UTF-8 bytes (8.57 MiB; 302 changed-file entries had captured content). This is
the persisted capture size before any git-head enrichment performed on load.

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

## Problem 4: a reconnecting client re-pays the whole build every time

Nothing amortizes a run view across deliveries. Each request re-reads the
history, re-redacts it, and re-serializes it, even when the run's timeline has
not advanced since the previous delivery to a client that dropped seconds ago.
In the 2026-10-01 loop that cost was paid at least 29 times in 10 minutes, and
deliveries overlapped.

**Proposal:** after Problems 1B and 2 shrink the payload, consider (a) caching
the redacted, serialized snapshot keyed by run address plus timeline
`nextSequence`, so a repeat request for an unchanged run is a send rather than
a rebuild, and (b) collapsing overlapping requests for the same address into one
in-flight build. Both must respect the redaction rules in Problem 3. The cache
holds the already-redacted string, never the raw history, and must be dropped
when the redaction configuration changes.

Separately, find out what is killing the phone's page. The hosted shim already
logs `pageshow`/visibility and foreground probes into the session log; add
whatever is missing to tell an iOS page kill apart from a network drop before
treating payload size as the whole story.

## Problem 5: resuming a running run sends its history twice — landed 2026-10-01

**Landed:** lineage binds now use `RUN_VIEW_LOADED` as their sole snapshot,
including authoritative live queue state (execution state, steps/results,
parallel groups, final-step runtime, workflow properties, and schema warnings).
The second history loader, `replayOutputHistoryTo`, and its unused dashboard
sink/provider pass-throughs were deleted. The addressed publisher remains the
single owner of buffered-output and terminal replay.

`WorkflowOrchestrator.replayWorkflowStateTo` binds a client (the panel, or any
browser at `ready` via `WebviewMessageRouter.completeBrowserReadyAfterStartup`)
to a live or retired instance. For an instance with a lineage, it currently
sends:

1. `loadRunViewForClient` → `RUN_VIEW_LOADED` with the full history. Because
   the address is live, `RunViewPublisher.deliverRunView` then also calls
   `replayBufferedOutputTo`, which replays every completed step's in-memory
   output, and it replays terminals when the bind returned an id.
2. `replayFullStateTo` → `SESSION_RESTORED`. The client runs a second
   `workflowStore.loadWorkflow` plus `applyWorkflowChange`, and then the same
   in-memory buffer replays **a second time**.
3. `replayOutputHistoryTo` → **a second server-side `loadHistory()`** and an
   `OUTPUT_HISTORY_LOADED` carrying the same history.
4. `WORKFLOW_VIEW_IDENTITY`, which exists only to restore the identity that
   step 2 cleared.
5. Terminal replay again, unless `skipTerminalReplay` is set.

Step 1's `RunViewPublisher` path is already the complete live-bind protocol:
snapshot, then buffered replay, then terminals.
`WorkflowInstance.replayBufferedOutputTo`'s own doc comment says
`SESSION_RESTORED` must not follow an addressed snapshot. Steps 2–5 are the
pre-run-view protocol left in place on top of it.

**Proposal:** when `queueState.workflowKey` is set, `loadRunViewForClient` is
the only sender, and `replayWorkflowStateTo` returns after it. Keep
`replayFullStateTo` only for the no-lineage case (a brand-new workflow,
`asReplacement`). Steps 3–5 then go away for lineage-backed instances, and
`replayOutputHistoryTo` may have no callers left. Before cutting step 2, check
everything `SESSION_RESTORED` carries that `RUN_VIEW_LOADED` does not. The main
candidate is the authoritative in-memory execution state
(`getAuthoritativeExecutionState`), since the working file can lag it and the
client drops a snapshot whose `executionState` looks stale (`RUN_VIEW_LOADED`
handler in `useMessageHandler.ts`). Also check `results`, `parallelGroups`,
schema warnings, and final-step runtime. Anything missing goes onto the
snapshot, or onto a small follow-up message that does not reset state, never
back onto `SESSION_RESTORED`.

`CtrlYokeWebviewProvider.loadOutputHistoryForWorkflow` is **not** a second
sender on this path. No code calls it except the pass-throughs in
`DashboardBroadcastHub` and `WorkflowTaggedSink`. Delete it together with the
`IDashboardSink.loadOutputHistoryForWorkflow` member and its no-op in
`NotificationManager`.

This is small and independent of the rest. It halves the server's history
reads on every bind, browser reconnects included, not just the panel's cost.
That makes it the first thing to land against the reload loop.

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

1. **Problem 5** (send the history once on resume): small and independent,
   and it halves the server cost of every reconnect.
2. **Problem 2** (on-demand `workspaceSnapshot` contents): ~16 MB off the
   payload, no protocol redesign, no client range tracking.
3. **Proposal 1C** (capped tool output, fetched on expand): protects payloads
   containing individual large outputs. The 400,000-byte head saved 0 bytes on
   the 2026-10-01 run because its largest individual field was 55,979 bytes.
   It still lands before 1B so large outliers can be fetched on demand; 1B's
   broader saving depends on an equivalence proof that may not hold.
4. **Proposal 1B** (structured-only activity reduction): exact replacement
   failed the equivalence check. Consider the narrower structured-slice
   reduction above only after the aggregate/event-field mismatch is resolved
   and a fresh row-equivalence and payload-size comparison passes.
5. **Problem 1A** (windowing + paging): **only if**, after steps 1–4, the
   `RUN_VIEW_LOADED` for the 2026-10-01 `bug-backlog` run is still over
   ~5 MB serialized, or the iPhone acceptance criterion below still fails.
   Design the skeleton/minimap/range story first (see "If 1A is ever needed:
   tuning constraints").
6. **Problem 3** (redaction) — investigate alongside; independent of the rest.
7. **Problem 4** (amortize repeat deliveries) — after 1B and 2, if a
   reconnecting client still hurts. Re-measure with the samplers first.

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
- [ ] The `bug-backlog` run above, opened from the iPhone PWA and backgrounded
      and foregrounded several times, no longer drives a reload loop, and the
      `[MemoryWatchdog]` heap stays well below 1 GB through it.
- [x] Binding any client (panel or browser) to a live instance with a lineage
      costs one server-side `loadHistory`, one `RUN_VIEW_LOADED`, and no
      `SESSION_RESTORED` or `OUTPUT_HISTORY_LOADED`. The client runs one
      `workflowStore.loadWorkflow`, and completed-step buffers replay at most
      once.
- [ ] If 1A lands, scrolling at normal speed through a paged run never shows
      a placeholder in the viewport (the prefetch margin covers it), and the
      scrollbar and minimap cover the whole run from the first paint.
- [ ] New coverage for the on-demand/windowed reads in `src/test/**`, and for
      the client's range handling in `src/ui/webview-react/test/**`.
