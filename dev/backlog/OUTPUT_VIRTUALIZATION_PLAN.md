# Output Virtualization Plan

## Problem

The Output panel can become slow when a workflow produces verbose AI output.
Recent render logging showed two distinct issues:

1. **Collapse/expand remount cost**: when the Output section returned only a
   collapsed bar, expanding remounted every output row and every markdown block.
   This has been improved by keeping the output tree mounted when only Output is
   collapsed.
2. **Expanded-state render cost**: even while Output stays expanded, the DOM can
   contain many markdown blocks, tool rows, and diff views. A sample session had
   only `messages=10`, but individual `CliOutput` rows contained up to 100+
   structured events. That means top-level message virtualization alone would not
   solve the main problem.

The expensive unit is not `OutputMessage`; it is the rendered row inside each
message: markdown text, thinking blocks, bash output, file-operation rows, diff
views, status rows, and stats rows.

---

## Recommendation

Use **TanStack Virtual** (`@tanstack/react-virtual`) and refactor Output rendering
around a flattened row model.

Why TanStack Virtual:

- Headless: keeps control over FlightPath's existing markup, styling, minimap,
  anchors, undo controls, and scroll behavior.
- Supports variable-height items through measurement.
- Works with a custom scroll element (`outputRef`), which the Output panel already
  owns.
- Less opinionated than React Virtuoso, which is convenient for simple lists but
  owns more of the rendering structure.

Avoid `react-window` for this case. It is best for simpler fixed or predictable
row heights; FlightPath output has large variable-height markdown, diffs, and
streaming content.

---

## Target Architecture

Replace nested output rendering:

```tsx
allMessages.map((message) => <CliOutput output={...} />)
```

with a flattened render model:

```typescript
type OutputRenderRow =
  | StepAnchorRow
  | FinalStepLabelRow
  | StatusRow
  | CliHeaderRow
  | PromptRow
  | CliCommandRow
  | ErrorRow
  | StructuredEventRow
  | PlainResponseRow
  | StatsRow;
```

`OutputSection` builds `OutputRenderRow[]` from `allMessages`, then TanStack
Virtual renders only visible rows plus overscan.

The scroll container remains `#output-content`. The virtualizer owns the inner
spacer height and translates visible rows into position.

Conceptually:

```tsx
const rowVirtualizer = useVirtualizer({
  count: rows.length,
  getScrollElement: () => outputRef.current,
  estimateSize: (index) => estimateOutputRowHeight(rows[index]),
  getItemKey: (index) => rows[index].key,
  overscan: 8,
});

return (
  <div ref={outputRef} className="overflow-y-auto">
    <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => (
        <div
          key={virtualRow.key}
          ref={rowVirtualizer.measureElement}
          data-index={virtualRow.index}
          style={{
            position: "absolute",
            transform: `translateY(${virtualRow.start}px)`,
            width: "100%",
          }}
        >
          <OutputRow row={rows[virtualRow.index]} />
        </div>
      ))}
    </div>
  </div>
);
```

---

## Row Model Details

### Step-level Rows

Rows generated around each output message:

- `step-anchor`: preserves navigation target for each queue/final-step output
- `final-step-label`: renders "Final Step Loop N"
- `status`: wraps `StatusMessage`
- `cli-header`: header currently inside `CliOutput`
- `prompt`: original prompt text
- `cli-command`: command line / working directory
- `error`: error message
- `stats`: token/session/elapsed summary

### Structured Event Rows

Rows generated from normalized structured events:

- `text`: markdown or raw text
- `thinking`: markdown thinking block
- `bash-command`: `BashOutput`
- `file-edit`: `FileEditOutput`
- `file-write`: `FileWriteOutput`
- `file-read`: `FileReadOutput`
- `file-delete`: `FileDeleteOutput`
- `mcp-tool-call`
- `web-search`
- `generic-tool-call`
- `tool-result`
- `compaction`

The current `StructuredOutput` logic should become row projection logic plus a
small `OutputRow` renderer. Keep `SingleEvent` behavior where possible, but the
virtualizer should render one row per event instead of mounting every event in a
visible `CliOutput`.

### Stable Keys

Every row needs a stable key. Suggested format:

```text
{targetKind}:{targetIndex}:run{runIndex}:attempt{attemptIndex}:{rowKind}:{eventIndex}
```

For non-event rows:

```text
{targetKind}:{targetIndex}:run{runIndex}:attempt{attemptIndex}:header
```

Stable keys are required to preserve measured heights and avoid remounting rows
unnecessarily while streaming.

---

## Minimap and Anchor Strategy

The current minimap measures real DOM anchors:

- step anchors via `document.getElementById(...)`
- diff anchors via `querySelectorAll("[data-diff-anchor]")`

Virtualization means offscreen rows do not exist in the DOM, so the minimap
cannot depend on DOM queries for all output.

Replace DOM-wide measurement with virtualizer metadata:

1. Track the row index for each step anchor.
2. Use virtualizer measurements or estimated offsets to compute
   `scrollFraction = rowStart / totalSize`.
3. Track diff rows in row metadata:
   - row key
   - event type
   - added/removed line counts
   - collapsed state
   - structured patch run metadata when available
4. Use measured row height when available; use estimated row height otherwise.

This makes the minimap partially estimate offscreen content, then refine as rows
are measured. That is acceptable if marker movement is subtle and stable enough.

---

## Auto-scroll and Streaming

The existing behavior should remain:

- If the user is near the bottom, streaming output follows the bottom.
- If the user scrolls away, streaming does not yank the viewport.

With virtualization:

- Keep `autoscrollEnabled` and `SCROLL_BOTTOM_THRESHOLD`.
- When a new row is appended or the last streaming row grows, call
  `rowVirtualizer.scrollToIndex(rows.length - 1, { align: "end" })` only if
  autoscroll is enabled.
- For a growing markdown row, call `rowVirtualizer.measure()` or re-measure that
  row after content changes.

The last streaming row deserves extra attention. Virtualization reduces total
DOM size, but a single huge streaming markdown block can still be expensive. If
that remains slow, split very large markdown/text events into chunk rows.

---

## Undo / Redo Strategy

Prompt-level undo currently depends on grouped step outputs and "last CLI output
for this step" behavior. Preserve this as side metadata:

- Keep `stepOutputsMap`
- Keep `lastCliIndexPerStep`
- During row projection, mark the final row for a step with available undo/redo
  actions.
- Render prompt-level undo controls either in `cli-header` or `stats` rows.
- Keep `UndoChangesDialog` owned by `OutputSection`, not by virtualized row
  components, so dialogs are not unmounted when their source row scrolls away.

Per-file undo buttons remain on file-operation rows.

---

## Implementation Phases

### Phase 1: Extract Row Projection

Create a pure utility:

```typescript
buildOutputRows(input): OutputRenderRow[]
```

Inputs:

- `allMessages`
- `steps`
- `finalStep`
- streaming chunk maps
- history snapshot/undo data
- `allowUndoActions`
- diff collapse state

Output:

- flat rows with stable keys and enough metadata to render them

Do this before adding virtualization. Initially render `rows.map(...)` to keep
behavior unchanged and make tests easier.

### Phase 2: Split Renderers

Move rendering from `CliOutput` / `StructuredOutput` into row-level components:

- `OutputRow`
- `CliHeaderRow`
- `StructuredEventRow`
- `StatsRow`

Keep the old `CliOutput` temporarily if useful, but avoid duplicate logic long
term.

### Phase 3: Add TanStack Virtual

Add dependency:

```bash
npm install @tanstack/react-virtual
```

Use `useVirtualizer` in `OutputSection`.

Start with:

- `estimateSize`: conservative defaults by row kind
- `overscan`: 8-12 rows
- `measureElement`: enabled for all rows
- `getItemKey`: row stable key

### Phase 4: Restore Minimap from Row Metadata

Replace broad DOM scans with row metadata and virtualizer size estimates:

- step marker positions from row index offsets
- diff block positions from diff row offsets
- viewport thumb still subscribes to scroll directly in `OutputMinimap`

Keep the minimap behind a feature flag during this phase if needed. The primary
performance win is still useful even if diff overlays are temporarily simplified.

### Phase 5: Streaming and Large Markdown Tuning

Optimize the remaining worst cases:

- Re-measure only the active streaming row.
- Consider splitting markdown/text rows over a size threshold, e.g. 8-16 KB.
- Keep raw script output as plain text rows where possible.
- Consider limiting syntax highlighting for very large fenced code blocks.

---

## Testing Plan

Unit tests:

- Row projection preserves chronological order.
- Status, CLI, structured events, and final-step labels produce expected rows.
- Stable keys do not change when unrelated streaming chunks update.
- Undo/redo metadata appears only on the correct step rows.
- Diff rows contain expected added/removed metadata.

Component tests:

- Output renders visible rows.
- Scrolling near bottom follows streaming output.
- Scrolling away disables autoscroll.
- History mode still renders from `historyOutputs`.
- Undo dialogs stay open if their source row scrolls out of view.

Manual tests:

- Long text-only workflow output.
- Long structured-output workflow with many tool calls.
- Large expanded diffs.
- Collapse/expand Output while editor remains open.
- Both Output and Editor collapsed.
- Switching Output/Terminal tabs.
- Run history selection.

---

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Scroll jump from inaccurate estimated heights | Use per-row-kind estimates and `measureElement`; overscan enough rows around viewport |
| Minimap markers move as rows are measured | Accept small refinement movement; cache row measurements by stable key |
| Offscreen diff anchors are unavailable | Drive minimap from row metadata instead of DOM queries |
| Streaming row re-measures too often | Re-measure only the active row, throttled to animation frames |
| Dialogs unmount when source row virtualizes away | Keep dialogs owned by `OutputSection` |
| Feature lands too large | Phase behind a local feature flag until row projection and minimap behavior are stable |

---

## Open Questions

- Should virtualization be always on, or only when row count / output size crosses
  a threshold?
- Should large markdown events be split before or after markdown parsing?
- Should diff overlays in the minimap be exact for offscreen rows, or is an
  estimated block acceptable?
- Should syntax highlighting be disabled above a fenced-code size threshold?
- Should the row model live under `components/output/` or `utils/`? A pure
  projection utility under `utils/` is easier to test.

---

## Rough Effort

This is a medium-large refactor.

- Row projection and non-virtual row rendering: 1-2 days
- TanStack Virtual integration: 1 day
- Minimap and diff overlay integration: 2-4 days
- Streaming polish and large markdown tuning: 1-2 days
- Tests and manual verification: 1-2 days

Expected total: **5-10 engineering days**, depending on how exact the minimap
and diff overlays need to remain in the first implementation.
