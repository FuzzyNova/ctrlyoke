# Virtualized Output Layout Plan

## Overview

FlightPath's output virtualization fixed major performance problems on long workflows, but it also exposed a new class of minimap bugs: row heights that are not deterministic before render cause pills and diff overlays to drift on first paint, first scroll, and resize.

Recent mitigation work proved two things:

1. **TanStack Virtual should remain the layout owner.**
2. **Whole-list "exact measurement" passes are not the right long-term design.**

Hidden/offscreen exact passes were not layout-equivalent to the live DOM, and even live-container exact passes reintroduce the same class of performance cost that virtualization was supposed to remove.

This plan replaces whole-list exact measurement with a **shared layout-model architecture**:

- `DiffView` and `ToolCallOutput` expose deterministic, pure layout data
- `OutputSection` uses that data as the primary virtualizer/minimap input
- mounted rows can still refine heights with visible-row correction, but no full-list measurement pass is required

---

## Problem Statement

Today, FlightPath has three partially overlapping notions of output layout:

1. **Virtualizer estimate** — `estimateOutputRowHeight()` / `estimateDiffStructuredEventHeight()`
2. **Minimap metadata** — diff runs and overlay sizes derived from row data and/or DOM attributes
3. **Actual rendered DOM height** — what the user really sees after `DiffView`, `ToolCallOutput`, and other expandable outputs settle

These three sources diverge whenever a row owns height-affecting state internally.

### Current trouble spots

#### `DiffView`

- collapsed vs expanded diff
- split vs unified view
- hidden-context decorations between hunks
- chunk expansion and expand-all for hidden context
- syntax-highlighted rendered table with real wrapping/chrome

`diffCollapseState` is already parent-owned, but **post-expansion hidden-context state is not**. `DiffView` currently owns `expandedHunks`, so `OutputSection` cannot know the final height of a partially expanded diff without measuring rendered DOM.

#### `ToolCallOutput`

- parameter block expanded vs collapsed
- output block expanded vs collapsed
- error block expanded vs collapsed
- line truncation rules

These states live in `GenericToolCallOutput` and directly change row height.

### Result

Virtualization remains fast, but the minimap becomes unstable because the parent does not know row height-affecting state until after render.

---

## Goals

- Preserve the performance gains from TanStack Virtual on long workflows
- Eliminate whole-list exact measurement as the long-term layout strategy
- Make minimap layout stable from shared row-layout state, not DOM luck
- Lift height-affecting expansion state out of `DiffView` and `ToolCallOutput`
- Keep a visible-row correction path for mounted rows only
- Support resize, font-size changes, history view, and interaction-driven expansion without reintroducing full-list rendering

---

## Non-Goals

- Pixel-perfect off-screen minimap positions for every possible future DOM mutation
- Replacing TanStack Virtual
- Refactoring every output row type in one pass
- Solving all text/markdown wrapping estimation issues in the first milestone

The first implementation should target the largest instability sources: **diff rows** and **generic tool call rows**.

---

## Design Principles

### 1. TanStack Virtual stays in charge

The virtualizer owns scroll-space and item sizing. FlightPath should provide better, shared input to TanStack Virtual rather than fighting it with duplicate layout systems.

### 2. Layout must be computable from row state

If a user action changes row height, the state for that action must be visible to `OutputSection`.

### 3. Minimap consumes the same model as the virtualizer

The minimap should not depend on separate DOM-derived truth for overlay placement when shared layout metadata can express the same information.

### 4. DOM measurement is correction, not architecture

Mounted rows may still report real height and refine the cache, but that is a visible-row correction path, not a whole-list exact pass.

---

## Proposed Architecture

## 1. Introduce shared row layout state in `OutputSection`

`OutputSection` becomes the single owner of height-affecting row UI state that currently lives inside child renderers.

### New state maps

```typescript
type DiffExpansionState = Map<
  string, // diffKey
  Map<number, number> // gapIndex -> expandedToLine
>;

type ToolCallExpansionState = Map<
  string, // rowKey
  {
    paramsExpanded: boolean;
    outputExpanded: boolean;
    errorExpanded: boolean;
  }
>;
```

### Important distinction

`diffCollapseState` already exists and stays. The missing state is **hidden-context expansion inside expanded diffs**. That is the state that must move out of `DiffView`.

---

## 2. Extend the existing pure diff render-plan pipeline instead of duplicating it

FlightPath already has a strong starting point:

- `computeOutputDiffStats()` in `outputRenderUtils.ts`
- `toRdvHunks()` / `toRdvFromContent()` in `rdvAdapter.ts`
- `getRenderedDiffStats()` in `rdvAdapter.ts`

That pipeline already computes a pure DOM-free render plan for the **base diff state**.

### Refactor target

Do **not** create a redundant parallel helper. Instead, extend the existing pipeline so it can accept post-expansion diff state:

```typescript
interface DiffRenderPlanInput {
  event: CliEvent;
  workspaceSnapshot?: WorkspaceSnapshot;
  viewType: "split" | "unified";
  collapsed: boolean;
  expandedGaps?: Map<number, number>;
  outputFontSize: number;
}

interface DiffRenderPlan {
  estimatedLineCount: number;
  renderedRows: number;
  addedLines: number;
  removedLines: number;
  runs: RenderedDiffRun[];
  headerHeight: number;
  decorationHeight: number;
  bodyHeight: number;
  totalHeight: number;
}
```

### How post-expansion state is applied

- Start from base hunks derived from structured patch or old/new content
- Reapply expanded-gap state using `expandFromRawCode(...)`
- Recompute `getRenderedDiffStats(...)`
- Derive row height from stable layout constants plus rendered-row count

### Required dependency

Partially expanded hidden-context diffs require `oldContent`. That dependency must be explicit in the helper contract.

If `oldContent` is unavailable:

- keep base-hunk render stats
- disable expandable hidden-context controls for that diff
- do not promise exact post-expansion prediction for patch-only diffs

This is a real constraint, especially for harness outputs that provide structured patches without full source content.

---

## 3. Redesign `DiffView` as a renderer over parent-owned layout state

`DiffView` should stop owning height-affecting expansion state internally.

### New responsibilities

#### `DiffView` should keep

- rendering the diff UI
- syntax tokenization
- rendering hidden-context controls
- user interaction handlers

#### `DiffView` should stop owning

- collapsed state that affects parent sizing
- hidden-gap expansion state that affects parent sizing

### Proposed prop shape

```typescript
interface DiffViewProps {
  // existing content props...
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  expandedGaps?: Map<number, number>;
  onExpandGap: (gapIndex: number, mode: "chunk" | "all") => void;
  layoutPlan?: DiffRenderPlan;
}
```

### Internal simplification

`DiffView` can still rebuild `expandedHunks` locally for rendering, but it must do so from parent-owned expansion state, not from its own durable `useState`.

That makes `OutputSection` and the minimap aware of the same expansion state that the user sees.

---

## 4. Add a pure layout model for `GenericToolCallOutput`

`GenericToolCallOutput` currently owns:

- `paramsExpanded`
- `outputExpanded`
- `errorExpanded`

These must move to parent-owned state keyed by stable `rowKey`.

### Stable key requirement

Use the row's existing stable key (for example `queue:0:run0:attempt0:event:5`), not a component-generated ID or list index.

### Proposed helper

```typescript
interface ToolCallRenderPlanInput {
  name: string;
  parameters?: Record<string, unknown>;
  result?: ToolResult;
  expansion: {
    paramsExpanded: boolean;
    outputExpanded: boolean;
    errorExpanded: boolean;
  };
  outputFontSize: number;
}

interface ToolCallRenderPlan {
  summaryHeight: number;
  paramsHeight: number;
  outputHeight: number;
  errorHeight: number;
  totalHeight: number;
  outputLineCount: number;
  errorLineCount: number;
  isOutputTruncated: boolean;
  isErrorTruncated: boolean;
}
```

This plan does not need DOM measurement to know whether the params/output/error blocks are expanded or truncated.

---

## 5. Make `buildOutputRows()` the single source of row layout metadata

`buildOutputRows()` should evolve from "build rows + rough estimates" to "build rows + layout metadata".

### For diff rows

Store:

- `diff.runs`
- `diff.addedLines`
- `diff.removedLines`
- `diff.renderPlan`

### For tool call rows

Store:

- `toolCall.renderPlan`
- expansion flags from parent state

### Estimate usage

`estimateOutputRowHeight()` becomes a thin adapter:

- use `diff.renderPlan.totalHeight` for diff rows
- use `toolCall.renderPlan.totalHeight` for generic tool call rows
- keep simple estimates for simpler row kinds initially

---

## 6. Keep a mounted-row correction path only

Some rows will still diverge from predicted height because of wrapping, browser table layout, or rich content details.

That is acceptable as long as correction is:

- limited to mounted rows
- fed back into TanStack Virtual's cache
- used to refine minimap placement for visible rows

### Recommended mechanism

- keep `measureRowElement`
- add `ResizeObserver` or equivalent mounted-row stabilization for visible rows
- update `measurementCacheRef` when actual height changes materially

### Explicit trade-off

Off-screen rows may remain estimate-based until they mount. That is acceptable. The long-term architecture should optimize for:

- stable initial minimap behavior
- minimal drift on visible content
- no whole-list rendering

It should **not** promise pixel-perfect off-screen overlay placement for rows whose final DOM has never existed yet.

---

## 7. Remove minimap dependence on DOM-published diff metadata where possible

The current DOM attributes were useful for debugging, but the minimap should primarily use shared row state.

### Target state

Minimap diff overlays are computed from row render plans, not from querying live diff DOM.

DOM-derived metadata may remain as optional diagnostics for mounted rows, but not as the primary data path.

---

## Implementation Phases

## Phase 0 — Keep current mitigation, add no new full-list measurement dependency

- Keep the current temporary exact-measure fallback only long enough to land the refactor safely
- Do not build more features around whole-list exact passes
- Keep current debug logging during the rollout

---

## Phase 1 — Lift state and define contracts

### Files

- `src/ui/webview-react/components/layout/OutputSection.tsx`
- `src/ui/webview-react/components/output/DiffView.tsx`
- `src/ui/webview-react/components/output/ToolCallOutput.tsx`

### Tasks

1. Add parent-owned diff hidden-gap expansion state
2. Add parent-owned tool call expansion state
3. Thread these states into `buildOutputRows()`
4. Add stable callback props so child components emit intent, not own durable state

---

## Phase 2 — Extend diff render planning

### Files

- `src/ui/webview-react/utils/outputRenderUtils.ts`
- `src/ui/webview-react/utils/rdvAdapter.ts`
- `src/ui/webview-react/utils/outputRows.ts`

### Tasks

1. Extend `computeOutputDiffStats()` to accept post-expansion state
2. Rebuild expanded hunks from base hunks + sparse gap map
3. Produce a `DiffRenderPlan`
4. Replace ad hoc diff row estimation with the render plan

---

## Phase 3 — Add tool call render planning

### Files

- `src/ui/webview-react/components/output/ToolCallOutput.tsx`
- `src/ui/webview-react/utils/outputRows.ts`
- new pure helper under `src/ui/webview-react/utils/`

### Tasks

1. Create pure tool call layout helper
2. Lift expansion state to parent
3. Replace tool call row estimate with render plan output

---

## Phase 4 — Switch minimap to shared layout metadata

### Files

- `src/ui/webview-react/components/layout/OutputSection.tsx`
- `src/ui/webview-react/components/output/OutputMinimap.tsx`

### Tasks

1. Stop treating diff DOM as the primary source of overlay sizing
2. Use row render plans plus `rowLayout` as the main minimap input
3. Keep mounted-row correction as a refinement path only

---

## Phase 5 — Remove whole-list exact measurement path

Once diff rows and tool call rows are stable under the new model:

1. remove hidden/live exact-measure phases
2. remove scheduler logic for whole-list measurement
3. keep visible-row correction
4. keep only the logging that still helps diagnose mounted-row divergence

---

## Edge Cases

## Diff edge cases

- collapsed diff vs expanded diff
- unified vs split view after resize
- hidden-context chunk expansion
- hidden-context expand-all
- patch-only diffs with no `oldContent`
- large diffs with hundreds of rendered rows
- diffs whose syntax highlighting changes tokens but should not change layout assumptions

## Tool call edge cases

- parameters expanded/collapsed
- output expanded/collapsed
- error expanded/collapsed
- output present with no error
- error present with no output
- large parameter payloads

## Output lifecycle edge cases

- history view vs live view
- streaming rows during active execution
- font-size changes
- rows that intentionally render no visible content
- first paint vs first scroll vs resize

---

## Performance Expectations

This refactor should improve performance relative to the current exact-measure workaround because:

- no hidden/offscreen full-list render pass
- no live-container full-list render pass as steady-state architecture
- only mounted rows pay DOM measurement cost
- most minimap layout work becomes pure computation over existing row data

The cost shifts from "render everything to know heights" to "recompute render plans when row state changes", which is the right trade-off for virtualization.

---

## Risks

### 1. Partially expanded diffs still need `oldContent`

Without source content, hidden-context expansion cannot be modeled exactly. The UI must degrade gracefully and avoid exposing controls it cannot predict.

### 2. Render-plan accuracy is not the same as live DOM height accuracy

The virtualizer can tolerate small estimate drift. The minimap cannot tolerate large visual drift. Visible-row correction remains necessary.

### 3. Scope creep into every output row type

Do not block the refactor on Bash/Markdown/plain-response. Land DiffView and ToolCallOutput first.

---

## Validation Strategy

## Unit-level

Add tests for pure render-plan helpers:

- base diff plan
- partially expanded hidden-context diff plan
- split/unified diff plan
- tool call params/output/error expansion plans

## Integration-level

Validate:

- first paint minimap stability
- first scroll minimap stability
- resize behavior
- diff expand/collapse
- hidden-context expansion
- tool call expand/collapse

## Commands

- `npm run typecheck:webview`
- `npm run build:webview`

---

## Recommended Delivery Order

1. Lift hidden-gap expansion state for diffs
2. Extend existing pure diff plan pipeline
3. Move minimap sizing to row render plans for diffs
4. Lift tool call expansion state
5. Add tool call render plan
6. Remove whole-list exact measurement path

---

## Implementation Notes

- Prefer sparse expansion maps over storing full `HunkData[]` in React state
- Reuse and extend `computeOutputDiffStats()` instead of creating a redundant diff-planning system
- Use stable row keys for parent-owned expansion state
- Treat mounted-row measurement as correction, not architecture

---

## Desired End State

After this refactor:

- virtualization stays fast on long workflows
- minimap overlays are driven by shared layout metadata
- diff and tool call rows report height-affecting state to the parent
- whole-list exact measurement is no longer needed
- first-scroll minimap drift is eliminated or reduced to small visible-row corrections instead of catastrophic post-render jumps
