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
The iPhone reload-loop criterion has not been re-measured.

## Open items, in suggested order

1. **Re-measure on the phone first.** Open the `bug-backlog` run from the
   iPhone PWA, background and foreground it several times, and read the
   `[MemoryWatchdog]`/`[PanelMemory]` samplers. Also add the missing hosted-shim
   logging that tells an iOS page kill apart from a network drop (Problem 4,
   second paragraph). The result decides whether 1A is needed.
2. **Problem 4: amortize repeat deliveries.** Cache the redacted, serialized
   snapshot by run address plus timeline `nextSequence`, and collapse
   overlapping builds for the same address. This is cheap relative to 1A and
   aimed directly at the reconnect loop.
3. **Proposal 1B, narrower form.** Drop only structured activity payloads. This
   needs the aggregate to be made lossless first (it currently loses fields such
   as `callerType`), then a fresh row-equivalence proof against the production
   projection. The committed Vitest equivalence harness pins the current
   counterexamples. About 19.4 MB of structured activity was measured before 1C.
4. **Problem 1A: windowing and paging.** Only if items 1–3 leave the payload
   over ~5 MB or the phone criterion still fails. Design the
   skeleton/minimap/range story first.
5. **Problem 3: redaction at the source.** An investigation, independent of the
   rest.

## Open acceptance criteria carried over

- The `PARALLEL_STEPS_PLAN` reproduction run no longer triggers the
  unresponsive-extension dialog in the panel or the hosted dashboard. Its files
  now project to 12.97 MB, not the original 54.5 MB, so re-establish a
  reproduction before judging this one.
- The `bug-backlog` run opened from the iPhone PWA no longer drives a reload
  loop, and the extension-host heap stays well below 1 GB.
- If 1A lands: no placeholders in the viewport at normal scroll speed, and the
  scrollbar and minimap cover the whole run from the first paint.
