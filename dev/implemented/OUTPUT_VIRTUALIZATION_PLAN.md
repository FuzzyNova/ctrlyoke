# Output Virtualization

**Status**: ✅ IMPLEMENTED (May 2026)

## Overview

FlightPath's webview Output pane now virtualizes row-level output with
`@tanstack/react-virtual` instead of mounting the full nested output tree.

The implemented change keeps the existing output UX intact while reducing the
cost of large runs that contain long markdown responses, many structured tool
events, and expanded diffs.

The expensive unit was not the top-level `OutputMessage`; it was the rendered
row inside each message. The shipped architecture therefore virtualizes a
flattened row model rather than the original top-level message list.

---

## What Shipped

### Shared navigation seam

`OutputSection` now owns an `OutputNavigationController` exposed through
`src/ui/webview-react/utils/outputNavigation.ts`.

That controller is used by:

- `useStepClickHandler`
- `OutputMinimap`
- `OutputSection` itself for programmatic step navigation

This removes the old requirement for callers to reach directly into output DOM
anchors and keeps navigation behavior centralized.

### Flattened row projection

`src/ui/webview-react/utils/outputRows.ts` projects output into stable,
virtualizable rows and returns the metadata needed by the rest of the Output
pane.

The row model includes:

- `history-banner`
- `step-anchor`
- `final-step-label`
- `status`
- `cli-header`
- `prompt`
- `cli-command`
- `error`
- `structured-event`
- `plain-response`
- `stats`

The projection step also preserves:

- `uniqueStepTargets` for ordered step navigation
- `stepOutputsMap` for prompt-level undo/redo flows
- `lastCliIndexPerStep` for prompt-level action placement
- `firstRowIndexByTarget` for navigation/minimap lookup
- diff metadata for minimap overlays

### Row renderer split

Rendering moved into `src/ui/webview-react/components/output/OutputRow.tsx`,
which renders the flattened row types instead of mounting a full `CliOutput`
tree for every message.

Shared helper logic that was needed by both projection and rendering lives in:

- `src/ui/webview-react/utils/outputRenderUtils.ts`

### TanStack Virtual integration

`OutputSection.tsx` now uses `useVirtualizer` from
`@tanstack/react-virtual`.

Implemented behavior:

- stable item keys per projected row
- per-row estimated heights via `estimateOutputRowHeight(...)`
- measured heights cached by row key
- virtual row measurement wired through the output scroll container
- metadata-derived target offsets for step navigation and minimap markers

### Configurable non-virtual fallback

Output rows now use the same flattened row projection in both render modes.
`ui.outputVirtualizationRowThreshold` controls when TanStack Virtual is used:

- `200` default: virtualize when projected output rows reach 200
- `0`: always virtualize
- `-1`: never virtualize

Below the threshold, `OutputSection` renders all rows in normal document flow.
This preserves native browser scroll and resize behavior for smaller outputs
without resurrecting the old nested `CliOutput` rendering path.

### Persistent diff collapse state

Expanded/collapsed diff state is now preserved outside individual diff row DOM
lifetime so it survives virtualization unmount/remount.

This required updates to:

- `DiffView.tsx`
- `FileOperationOutput.tsx`

### Minimap and context-menu parity

The minimap and output context menu no longer depend on global offscreen DOM
queries for all behavior.

`OutputSection` computes scroll fractions and diff overlay metadata from row
projection plus virtualizer measurements, allowing the following behaviors to
continue working with virtualized output:

- step markers
- final-step loop markers
- diff overlays
- minimap marker click navigation
- "Copy Step Output" target resolution

### History-mode support

The virtualized row projection supports both live output and the reduced history
snapshot shape exposed by `workflowStore.historyOutputs`.

That keeps history browsing on the same rendering path as live output without
requiring a separate non-virtualized renderer.

---

## Key Files

| File | Role |
| --- | --- |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Virtualized output orchestration, measurement cache, navigation controller registration, minimap metadata |
| `src/ui/webview-react/utils/outputRows.ts` | Row projection, row metadata, row height estimates |
| `src/ui/webview-react/utils/outputRenderUtils.ts` | Shared event/diff/render helpers |
| `src/ui/webview-react/utils/outputNavigation.ts` | Active output navigation controller |
| `src/ui/webview-react/components/output/OutputRow.tsx` | Row-level renderer |
| `src/ui/webview-react/components/output/OutputMinimap.tsx` | Marker-click navigation through the shared controller |
| `src/ui/webview-react/hooks/useStepClickHandler.ts` | Step-click navigation through the shared controller |
| `src/ui/webview-react/components/output/DiffView.tsx` | Controlled diff collapse support |
| `src/ui/webview-react/components/output/FileOperationOutput.tsx` | Pass-through controlled diff collapse wiring |

---

## Validation Completed

The implemented change was validated with:

- `npm install @tanstack/react-virtual --save`
- `npm run typecheck:webview`
- `npm run test:ui`
- `npm run compile`

The focused regression coverage added for this work lives in:

- `src/ui/webview-react/test/utils/outputRows.test.ts`
- `src/ui/webview-react/test/components/output/DiffView.test.tsx`

---

## Design Decisions Kept

- **Single row model**: both virtualized and non-virtualized rendering consume
  the same flattened `OutputRenderRow` projection.
- **Row model in `utils/`**: the row projection remains a pure utility and the
  rendering remains under `components/output/`.
- **Estimated offscreen minimap placement**: offscreen rows use estimated or
  cached sizes, then refine as rows are measured.
- **No markdown chunk splitting in the first pass**: row virtualization shipped
  without adding a second chunking layer.

---

## Deferred Follow-ups

The following ideas were intentionally left as follow-up work rather than being
bundled into the initial virtualization change:

- splitting extremely large markdown/text output into chunk rows if profiling
  shows one huge row is still expensive
- limiting syntax-highlighting work for very large fenced code blocks
- any additional minimap tuning if marker refinement during measurement proves
  visually noisy in practice

---

## Outcome

The Output pane now virtualizes the actual expensive rendering unit while
preserving step navigation, minimap behavior, history rendering, prompt undo
flows, and diff interaction behavior.
