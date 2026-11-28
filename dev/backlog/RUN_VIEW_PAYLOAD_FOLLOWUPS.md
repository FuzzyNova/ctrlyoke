# Run-View Payload Follow-ups

**Status:** Backlog — split out 2026-10-01 when sequencing items 1–4 of
`dev/implemented/RUN_VIEW_PAYLOAD_PAGING_PLAN.md` landed. That document holds
the evidence, the measurements and the full design notes for each item below.
Do not re-derive them here.

> **2026-10-10 audit:** All five items remain open. No run-view work has landed
> since the 1C rollback (`869dd0f19`, `571b160fb`): `RUN_VIEW_LOADED` is still built
> fresh per delivery in `src/core/orchestration/RunViewPublisher.ts`
> (`deliverRunView`), with no serialized-snapshot cache or build coalescing
> (item 2), and structured activity payloads are still shipped (item 3). Recent
> streamed-redaction fixes (`659d3494d`, `f2a6b5d56`) touch output redaction but
> not item 5's "redaction at the source" investigation.

> **2026-10-12:** The hosted dashboard socket now negotiates permessage-deflate
> (level 3), so the sizes below are serialized sizes, not bytes on the wire.
> A run timeline compressed about 4×. Heap use on both ends is unchanged, so
> item 1's phone re-measurement still decides 1A. See
> `DASHBOARD_CONNECT_THROUGHPUT_PLAN.md` for the connect-time measurements.

> Last reviewed against code: 2026-10-26. All five items still open: `deliverRunView`
> (`RunViewPublisher.ts`) still builds `RUN_VIEW_LOADED` per request with no
> serialized-snapshot cache or overlapping-build coalescing. Adjacent fixes since the last
> audit, none of which replace an item: the run-view load watchdog no longer reissues slow
> loads (`45a330a96`), hosted reconnects reload the run view (`ad5da660b`), and multi-message
> replays go out as one `MESSAGE_BATCH` (`be267f781`).

> **2026-11-27 phone measurement (item 1 answered):** The iPhone PWA repeatedly
> refreshed while it was viewing `workflow-step-plan-2026-11-26T16-01-37-491`. The
> refreshes stopped as soon as it stopped viewing that run. The session log shows
> `hosted send runViewLoaded` at **74.6–86.5 MB** for that run on each socket open,
> with the extension-host heap jumping about +1.2 GB (to ~1.8 GB) per delivery. The
> shim logged repeated `inbound watchdog timed out` and
> `application-heartbeat-ack-timeout` closes. Each one was followed by a reconnect
> and the same ~86 MB send. Right after a socket opens, `[PanelMemory]` reports
> `liveEntries=0 historyEntries=0`, which fits a fresh page load rather than a
> socket-only reconnect. The most likely cause is iOS killing the WebContent
> process for memory while it parses the payload, so the page reloads and the
> cycle repeats. The missing shim logging from item 1 would confirm this; it has
> not been added. The run-view payload is therefore the trigger, and 1A is needed.

## Where the payload stands

The `bug-backlog` run (`run-2026-09-30T13-41-01-546Z`) serialized to 42.7 MB
before this work. After Problem 2 (snapshot contents on demand), its
`RUN_VIEW_LOADED` history is **38.55 MB**:

| Part              | Size     |
| ----------------- | -------- |
| `activityEntries` | 19.44 MB |
| `orderedEntries`  | 18.45 MB |
| `promptOutputs`   | 0.65 MB  |

Proposal 1C (tool output capped at 8 KiB) brought this to 27.6 MB, but it was
rolled back the same day: expanding a capped output re-projected the whole run,
blanked the pane, and lost its result on collapse. The plan's "Rolled back"
note under Proposal 1C has the details and the conditions for trying it again.

Either figure is well over the ~5 MB threshold the plan set for starting 1A.
Real runs have since grown far past it: the 2026-11-27 phone measurement above
saw 74.6–86.5 MB for a single run, and that run drove the iPhone reload loop.

## Open items, in suggested order

1. ~~**Re-measure on the phone first.**~~ Answered 2026-11-27 (see the note
   above): the reload loop reproduces with an ~86 MB `RUN_VIEW_LOADED`, and 1A is
   needed. Still open from this item: add the hosted-shim logging that tells an
   iOS page kill apart from a network drop (Problem 4, second paragraph), so the
   fix can be verified from the session log alone.
2. **Problem 4: amortize repeat deliveries.** Cache the redacted, serialized
   snapshot by run address plus timeline `nextSequence`, and collapse
   overlapping builds for the same address. Do this first: it is cheap and
   removes the ~1.2 GB extension-host heap spike per reconnect. It does **not**
   fix the phone. The client still receives and parses the full payload on every
   load, so iOS can still kill the page.
3. **Problem 1A: windowing and paging.** This is the actual fix for the phone
   reload loop. The client only ever holds a bounded window of the run, so the
   payload no longer grows with the run's length. Design the
   skeleton/minimap/range story first.
4. **Proposal 1B, narrower form (optional).** Drop only structured activity
   payloads. Activity entries were about half of the measured payload, so this
   alone would still leave an ~86 MB run near 40 MB, far over 5 MB. It is
   worth doing only as a size reduction alongside 1A. It needs the aggregate to
   be made lossless first (it currently loses fields such as `callerType`),
   then a fresh row-equivalence proof against the production projection. The
   committed Vitest equivalence harness pins the current counterexamples.
5. **Problem 3: redaction at the source.** An investigation, independent of the
   rest.

## Open acceptance criteria carried over

- The `PARALLEL_STEPS_PLAN` reproduction run no longer triggers the
  unresponsive-extension dialog in the panel or the hosted dashboard. Its files
  now project to 12.97 MB, not the original 54.5 MB, so re-establish a
  reproduction before judging this one.
- The `bug-backlog` run, and the 2026-11-27 reproduction
  `workflow-step-plan-2026-11-26T16-01-37-491` (~86 MB), opened from the iPhone
  PWA no longer drive a reload loop, and the extension-host heap stays well
  below 1 GB.
- If 1A lands: no placeholders in the viewport at normal scroll speed, and the
  scrollbar and minimap cover the whole run from the first paint.
