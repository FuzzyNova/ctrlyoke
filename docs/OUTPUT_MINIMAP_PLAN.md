# Output Minimap — Implementation Plan

## Goal

Replace the current dual prompt-level undo buttons (one in the header, one in the footer of each `CliOutput`) with a **minimap rail** on the right side of the output panel. The minimap shows:

- A proportional position marker for each prompt boundary
- A clickable undo/redo button at each marker
- A viewport indicator (scroll thumb) so users know where they are in the output
- Click-to-scroll navigation on any marker

This solves two problems simultaneously:
1. Consecutive undo buttons from adjacent prompts no longer collide ("end of prompt 1 → start of prompt 2" adjacency confusion)
2. Historical runs become navigable at a glance — users can jump to any prompt even when the sidebar prompt list no longer matches the output positions

---

## Library Research: No Dependency Needed

All mainstream React minimap libraries (`react-minimap`, `react-simple-minimap`) are unmaintained since 2017–2019 and render DOM content thumbnails — the wrong model for this use case. `@replit/codemirror-minimap` is active but requires a `CodeMirror EditorView` instance and cannot be decoupled from it. There are no viable off-the-shelf options.

**Recommendation: zero new dependencies.** The data is already computed in `OutputSection.tsx` (`firstIndexByStep`, `allMessages`, `outputRef`). The visual is ~100 lines of React + Tailwind + VS Code CSS variables.

---

## Architecture

### Layout Change in `OutputSection.tsx`

The output content area changes from a single scrollable div to a side-by-side pair:

```
┌─────────────────────────────────┬────┐
│  #output-content (flex-1)       │ MM │  ← MM = minimap rail (~18px wide)
│  (existing scrollable div)      │    │
│                                 │    │
└─────────────────────────────────┴────┘
```

The outer `<section>` already uses `flex flex-col`. The content row becomes `flex flex-row min-h-0 flex-1`.

### New Files

| File | Purpose |
|------|---------|
| `components/output/OutputMinimap.tsx` | The minimap rail component |

### Modified Files

| File | Change |
|------|--------|
| `components/layout/OutputSection.tsx` | Wrap output content + minimap in a row; pass required props to `OutputMinimap`; move scroll tracking into shared state; remove `promptUndoAction` rendering from `CliOutput` props path |
| `components/output/CliOutput.tsx` | Remove the two prompt-level undo button renders (header button + stats-row button) — replaced by the minimap |
| `store/uiStore.ts` | Add `minimapScrollTop: number` + `setMinimapScrollTop()` (or use a ref passed down) |

---

## Component Design: `OutputMinimap`

### Props

```tsx
interface OutputMinimapProps {
  /** Array of steps in display order, with their first-message index in allMessages */
  steps: Array<{
    key: string;           // e.g. "queue:0", "finalPrompt:1"
    kind: "queue" | "finalPrompt";
    stepIndex: number;
    firstMessageIndex: number;
    /** Undo/redo action for this step, or null if not available */
    undoAction: { label: string; isRedo: boolean; onTrigger: () => void } | null;
  }>;
  totalMessages: number;
  /** Ref to the scrollable output container */
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  /** Current scrollTop of the container (updated via onScroll) */
  scrollTop: number;
}
```

### Proportional Math

```
markerTop%      = (step.firstMessageIndex / totalMessages) * 100
viewportTop%    = (scrollTop / scrollContainer.scrollHeight) * 100
viewportHeight% = (scrollContainer.clientHeight / scrollContainer.scrollHeight) * 100
```

Markers are `position: absolute; top: {markerTop%}%` inside a `position: relative; height: 100%` container.

### Click-to-Scroll

Clicking a marker calls:
```ts
scrollContainer.scrollTo({ top: markerFraction * scrollContainer.scrollHeight, behavior: "smooth" });
```

Clicking an undo button triggers the same `handlePromptUndo` logic currently in `CliOutput`, lifted up to `OutputSection`.

### Overflow: Stacking Markers When Crowded

For workflows with many prompts, markers at the same proportional position would overlap. Strategy:

- **Default**: render all markers at proportional positions. If the rail is too short to show a button at every marker (< 16px gap), collapse adjacent markers into a counter badge (e.g., `+3`) on hover that expands to show individual buttons.
- **Phase 1**: always show all markers at proportional positions; buttons are small (8×8px dot) and undo buttons appear on hover only.
- **Phase 2**: add collision detection and grouping when needed.

---

## Undo Logic Lift

Currently, the prompt-level undo dialog is owned by `CliOutput`. When migrating to the minimap, the undo trigger logic moves to `OutputSection` (or a thin hook), and `CliOutput` loses the header/footer undo buttons.

The `UndoChangesDialog` can remain rendered in `OutputSection` (one instance, shared) rather than per-`CliOutput`. `OutputSection` manages `dialogState`.

Data already available in `OutputSection` for undo:
- `stepOutputsMap` — all CLI outputs per step
- `lastCliIndexPerStep` — identifies the last attempt per step (only last gets undo)
- `allowUndoActions` — gates on execution state
- `workspaceSnapshots` / `undoRecords` from the store

---

## Scroll Tracking

`OutputSection` already has `outputRef` and `handleScroll`. Add a `scrollTop` state:

```ts
const [minimapScrollTop, setMinimapScrollTop] = useState(0);

const handleScroll = useCallback(() => {
  // existing autoscroll logic ...
  setMinimapScrollTop(outputRef.current?.scrollTop ?? 0);
}, []);
```

This state is passed to `OutputMinimap` as `scrollTop`. The minimap re-renders on each scroll event — but since it is a tiny fixed-width rail with N absolutely-positioned dots, re-render cost is negligible.

---

## Visual Design

Use VS Code CSS variables for theme compatibility:

| Element | CSS Variable |
|---------|-------------|
| Rail background | `var(--vscode-scrollbarSlider-background)` at 20% opacity |
| Viewport indicator | `var(--vscode-scrollbarSlider-background)` |
| Marker dot (no undo) | `var(--vscode-descriptionForeground)` |
| Marker dot (has undo) | `var(--vscode-textLink-foreground)` |
| Marker dot (has redo) | `var(--vscode-terminal-ansiGreen)` |
| Undo button hover | `var(--vscode-button-background)` |

The rail width is `14px` (narrower than a standard scrollbar so it does not feel like one). The actual scrollbar of `#output-content` remains visible.

Marker dots are `8×8px` circles. On hover, a tooltip shows the step label and undo count. An undo/redo icon button (12px codicon) appears beside the dot on hover.

---

## Step-by-Step Implementation

### Phase 1: Infrastructure

1. Add `scrollTop` state to `OutputSection` and update `handleScroll`
2. Lift undo dialog state from `CliOutput` up to `OutputSection`
   - Extract `buildPromptUndoAction()` helper used by both `OutputSection` (for minimap) and `CliOutput` (for removal verification)
   - Render `UndoChangesDialog` once in `OutputSection` instead of per-`CliOutput`
3. Build the `steps` array for `OutputMinimap` from existing `firstIndexByStep`, `stepOutputsMap`, `lastCliIndexPerStep`

### Phase 2: `OutputMinimap` Component

4. Create `OutputMinimap.tsx` with:
   - Proportional marker positioning
   - Viewport indicator (scroll thumb)
   - Click-to-scroll on marker
   - Hover-to-show undo button
   - Tooltip with step label
5. Wire into `OutputSection` layout (flex row)

### Phase 3: Remove Old Undo Buttons from `CliOutput`

6. Remove `promptUndoAction` memo from `CliOutput`
7. Remove the header button and stats-row button renders
8. Remove `allStepOutputs` prop from `CliOutputProps` (no longer needed)
9. Update `OutputSection` to stop passing `allStepOutputs`

### Phase 4: Overflow / Grouping (deferred)

10. Add collision detection: if two markers are within 12px of each other, merge into a group badge
11. Group badge expands on hover to show individual markers

---

## Files Affected

```
src/ui/webview-react/components/
├── output/
│   ├── CliOutput.tsx              — remove promptUndoAction, header/footer buttons, allStepOutputs prop
│   └── OutputMinimap.tsx          — NEW
└── layout/
    └── OutputSection.tsx          — add scrollTop state, lift undo dialog, pass minimap props, layout change
```

No store changes required (all needed data is already in `workflowStore` and `uiStore`).

---

## Open Questions

1. **Should the minimap hide when output is collapsed?** Yes — the collapsed state already renders `PanelBar` only, so no change needed.
2. **Should the minimap appear in history view?** Yes — this is one of the primary use cases (navigating historical runs where prompt positions are unknown).
3. **Minimap width when output section is very narrow?** Consider hiding at `< 300px` section width (use existing `useElementNarrow` hook or a `ResizeObserver`).
4. **Keyboard accessibility?** Each marker should be focusable (`tabIndex={0}`) with Enter/Space to scroll and activate undo.
