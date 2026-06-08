# Output Section Refactor Plan

## Goal

Shrink `src/ui/webview-react/components/layout/OutputSection.tsx` from a
4,400+ line all-in-one component into focused components, hooks, and utilities
without changing output behavior. The current file owns presentation, terminal
tab controls, export UI, undo/redo dialogs, output row projection, virtualized
measurement, scroll-target persistence, minimap data, and performance logging.

This should be done as a staged refactor, not a single broad rewrite. The
scroll and virtualization code is behavior-heavy and has enough edge-case fixes
that moving it safely requires small commits with targeted verification after
each step.

---

## Proposed Shape

### Keep in `OutputSection.tsx`

`OutputSection` should become the composition root:

- store selector wiring
- top-level refs needed across child hooks
- passing derived state into child components/hooks
- final layout shell (`section`, header, output tab, terminal tab, dialogs)

Target size: 300-600 lines after all planned extractions.

### New components

- `components/layout/output-section/OutputSectionHeader.tsx`
  - collapsed header
  - output/terminal tab buttons
  - font-size controls
  - execution mode toggle
  - terminal compact session controls
  - output action buttons: workflow undo/redo, run selector, expand/collapse diffs, export

- `components/layout/output-section/OutputPane.tsx`
  - scroll container
  - empty state
  - `Profiler`
  - virtualized vs non-virtual row rendering
  - virtualization overlay
  - `OutputMinimap`

- `components/layout/output-section/ExportOutputModal.tsx`
  - export option state can either stay in parent initially or move into this component once stable
  - range validation display
  - VS Code export vs standalone download button copy

- `components/layout/output-section/OutputUndoDialogs.tsx`
  - prompt-level undo/redo dialog
  - workflow-level undo/redo dialog

- `components/layout/output-section/OutputScrollSeekPlaceholder.tsx`
  - placeholder renderer and label helper for scroll-seek mode

### New hooks

- `hooks/useOutputRowsModel.ts`
  - maps live/history entries into `OutputMessage[]`
  - calls `buildOutputRows`
  - returns `rows`, `uniqueStepTargets`, `stepOutputsMap`, `lastCliIndexPerStep`, and `firstRowIndexByTarget`
  - owns diff/tool/bash expansion maps only if doing so does not make row measurement invalidation awkward

- `hooks/useOutputVirtualization.ts`
  - row height measurement cache
  - adaptive height bucket stats
  - virtualizer instance
  - non-virtual staged rendering count
  - measurement invalidation callbacks for row expansion

- `hooks/useOutputScrollTarget.ts`
  - persistent `OutputScrollTarget` ref/store sync
  - `captureViewportRowAnchor`
  - `resolveScrollTopForTarget`
  - `applyScrollTarget`
  - user-scroll settled target commit

- `hooks/useOutputScrollSeek.ts`
  - fast-scroll placeholder state
  - overscan mode transitions
  - wheel/touch pre-arm handlers
  - restore timers and cleanup

- `hooks/useOutputNavigation.ts`
  - pending navigation stabilization
  - `setActiveOutputNavigationController`
  - minimap click navigation

- `hooks/useOutputExport.ts`
  - export modal state
  - step range parsing
  - markdown generation
  - VS Code postMessage/download handling

- `hooks/useOutputUndoActions.ts`
  - workflow-level undo/redo aggregation
  - prompt undo/redo handlers
  - file-level undo handler
  - minimap undo action construction, if it can be separated cleanly from minimap step derivation

### New utilities

- `utils/outputDom.ts`
  - `getMeasuredElementHeight`
  - `getResizeObserverEntryHeight`
  - `findRenderedRowElement`
  - `findRenderedRowElementByKey`
  - `alignRowElementToViewport`
  - `getRowScopedScrollTop`
  - `getEstimatedRowScopedScrollTop`

- `utils/outputScrollSeek.ts`
  - scroll-seek constants
  - `getWheelDeltaPixels`
  - `shouldRenderScrollSeekPlaceholder`
  - `getScrollSeekRowLabel`

- `utils/outputLayoutModel.ts`
  - `getRowHeightBucket`
  - row layout map construction
  - pure helpers for minimap scroll fractions

Keep constants close to the hook that owns them when they are not shared. Do not
create a generic dumping-ground utility file.

---

## Work Breakdown

### Prompt 1: extract pure helpers and small presentation components — Done

- Move DOM helper functions into `@utils/outputDom`.
- Move scroll-seek placeholder labeling/rendering into a small component.
- Extract `ExportOutputModal`.
- Extract `OutputUndoDialogs`.
- Keep state and handlers in `OutputSection` for this pass.
- Run `npm run build:webview` and targeted webview tests if imports touch tested code.

Completed:

- Added `src/ui/webview-react/utils/outputDom.ts`.
- Added `components/layout/output-section/OutputScrollSeekPlaceholder.tsx`.
- Added `components/layout/output-section/ExportOutputModal.tsx`.
- Added `components/layout/output-section/OutputUndoDialogs.tsx`.
- Left all state/behavior ownership in `OutputSection`.
- Verified with `npm run build:webview`.

Expected risk: low. This reduces file size without changing ownership of behavior.

### Prompt 2: extract the header — Done

- Create `OutputSectionHeader`.
- Pass explicit props rather than letting the header read stores directly.
- Move terminal spawn/close button UI into the header, but keep close/spawn helper callbacks in the parent for the first pass.
- Preserve narrow/very-narrow behavior from `useElementNarrow`.
- Verify output/terminal tab switching, font size controls, execution mode toggle, run selector, workflow undo/redo buttons, export button, and diff expand/collapse button.

Completed:

- Added `components/layout/output-section/OutputSectionHeader.tsx`.
- Replaced the expanded inline header in `OutputSection` with `OutputSectionHeader`.
- Kept terminal spawn/close, run-history messaging, workflow undo/redo dialog opening, collapse animation, font-size updates, tab selection, and execution-mode updates as parent-owned callbacks.
- Left the collapsed header inline in `OutputSection` for now because it is tiny and tied to the top-level early return.
- Verified with `npm run build:webview`.

Expected risk: low to medium because the header has many small controls but limited scroll behavior.

### Prompt 3: extract export and undo hooks — Done

- Move export state and handlers to `useOutputExport`.
- Move workflow/prompt/file undo state and handlers to `useOutputUndoActions`.
- If minimap undo action construction remains coupled to minimap data, leave it in the minimap hook planned later instead of forcing an awkward split.
- Add focused tests for range parsing/export helper behavior if a pure seam appears.

Completed:

- Added `hooks/useOutputExport.ts` for export modal state, step range parsing, markdown generation, VS Code export messaging, and standalone download handling.
- Added `hooks/useOutputUndoActions.ts` for prompt/file undo handlers, workflow-level undo/redo aggregation, workflow dialog opening, and undo dialog state.
- Kept minimap undo action construction in `OutputSection` because it remains coupled to `minimapSteps`; it should move with Prompt 6's minimap model extraction.
- Verified with `npm run build:webview`.

Expected risk: medium. These paths post messages and build undo payloads, but they are localized.

### Prompt 4: extract row model and row expansion state — Next

- Move `allMessages` derivation and `buildOutputRows` orchestration into `useOutputRowsModel`.
- Move diff/tool/bash expansion maps only with the row model if the hook can expose row invalidation callbacks cleanly.
- Keep measurement and scroll hooks in `OutputSection` until row keys and invalidation behavior are stable after extraction.
- Verify diff collapse/expand-all, per-diff collapse, diff gap expansion, tool call expansion, bash expansion, live output streaming, and history browsing.

Expected risk: medium. Row keys and expansion maps are shared with measurement invalidation.

### Prompt 5: extract virtualized rendering into `OutputPane`

- Move the JSX that renders virtual and non-virtual rows into `OutputPane`.
- Keep virtualizer creation and scroll handlers in `OutputSection` initially.
- Pass `rows`, `virtualRows`, measurement refs, row handlers, expansion maps, and minimap props.
- This should make the parent easier to read before moving the behavior-heavy hooks.

Expected risk: medium. The rendering path is large but mostly mechanical.

### Prompt 6: extract minimap model

- Move `stepScrollFractions` and `minimapSteps` construction into `useOutputMinimapModel`.
- Keep dialog state and navigation callbacks outside the hook unless the hook can expose a small, testable API.
- Add unit tests for label selection and diff block mapping if practical.

Expected risk: medium. The minimap combines row layout, step metadata, diff blocks, and undo affordances.

### Prompt 7: extract scroll target and navigation behavior

- Move persistent scroll-target state into `useOutputScrollTarget`.
- Move pending navigation stabilization into `useOutputNavigation`.
- Keep the public API small:
  - `applyScrollTarget`
  - `commitScrollTargetFromViewport`
  - `scheduleScrollTargetCommit`
  - `navigationController`
  - `navigationPendingRowIndex`
- Do this after the rendering and row-model extractions so the hook dependencies are obvious.
- Verify scroll position persistence across workflow switches, live/history switches, output width changes, diff view type changes, minimap navigation, and new output autoscroll.

Expected risk: high. This is where most subtle output-position regressions can happen.

### Prompt 8: extract virtualization and scroll-seek behavior

- Move measurement caches, adaptive row estimates, pending measurement flush, and `useVirtualizer` setup into `useOutputVirtualization`.
- Move fast-scroll overscan and placeholder timers into `useOutputScrollSeek`.
- Keep performance logging behavior unchanged.
- Add focused tests around pure helpers, but rely on manual/browser verification for scroll and virtualizer behavior.

Expected risk: high. Virtualizer timing, ResizeObserver behavior, and scroll correction suppression are fragile.

---

## Validation Checklist

- `npm run build:webview`
- `npm run compile`
- Existing output component tests that touch `OutputRow`, diffs, bash output, file operation output, markdown output, and undo dialogs
- Manual dashboard checks:
  - live output appears and streams
  - output autoscroll follows the bottom while running
  - user scroll away from bottom stays put when new output arrives
  - output scroll position restores after switching workflows
  - history run selection and back-to-live work
  - output/terminal tab switch preserves terminal sessions and output DOM
  - virtualized large output scrolls without blank flashes beyond existing behavior
  - minimap navigation lands on the requested step
  - diff split/unified switches when resizing the output panel
  - per-row expand/collapse does not jump unexpectedly
  - export works in VS Code and standalone hosted mode
  - prompt/file/workflow undo and redo dialogs still open with correct targets

---

## Recommendation

Make the plan first, then implement in small passes. A direct "take a stab"
refactor is not worth the regression risk here because the largest parts of the
file are not just JSX; they are timing-sensitive scroll, measurement, and
virtualization behavior. The first useful implementation pass should be Prompt 1:
extract pure helpers and small presentational components while preserving all
state ownership in `OutputSection`.
