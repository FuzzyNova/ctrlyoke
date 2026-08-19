# Diff File List Virtualization Plan

> **Status:** Phase 1 items 2–4 implemented; virtualization remains off. This is a focused UI-performance change for the shared
> `DiffFileList`; it does not replace the Output pane's existing virtualization.

## Goal

Keep opening and expanding a multi-file diff responsive when a workflow or commit contains
dozens or hundreds of changed files. Only the file cards near the visible viewport should mount
their `DiffView` trees, while selection, collapse state, group ordering, sticky file headers, and
undo/redo payloads continue to behave exactly as they do today.

The same implementation must cover both current multi-file consumers:

- `UndoChangesDialog.tsx`, including workflow-level undo/redo with 100+ aggregated files.
- `WorkspaceDiffPane.tsx`, including large commit, stash, staged, and working-tree diffs.

Single-file and small multi-file lists should keep their current direct DOM structure; the
virtualizer's setup and absolute-positioned wrappers are not worthwhile there.

## Motivation and Profile Evidence

The Chrome trace in `dev/reference/devtools_analysis.md` captured an undo dialog for a workflow
with more than 100 changed files followed by **Expand all**. The trace contained a 5.81-second
main-thread task, 3.25 seconds of paint, about 1 second of layout, about 1.1 seconds of
layerization, and substantial `react-diff-view` token construction and garbage collection. The
371 ms interaction highlighted by the DevTools assistant was only the dialog-opening slice; the
larger expand-all task is the more important failure.

This is not an `OutputPane` virtualization failure:

- `OutputPane.tsx` renders `virtualRows` when `useOutputVirtualization` enables virtualization.
- `UndoChangesDialog` is rendered through `Modal`, whose portal is attached to `document.body`.
  The dialog's file cards are therefore outside the Output pane's row tree.
- `DiffFileList.tsx` currently maps every non-empty group's complete `files` array directly to a
  `DiffFileCard`, so expanding all mounts every diff table at once.

`DiffView` already memoizes parsing and tokenization and defers syntax highlighting for an
individually large diff. Those optimizations do not prevent the first render of 100 distinct
files, and many individually small diffs still tokenize synchronously. The list must stop
mounting offscreen diff trees.

Collapsing a card is not a substitute for unmounting it. `DiffView`'s `parsedDiff` memo runs
`toRdvHunks` / `toRdvFromContent` on mount **regardless of collapsed state**, because the
collapsed summary header shows exact add/remove counts (`summaryStats` is derived from
`parsedDiff.baseHunks`). A collapsed 120-file list therefore still performs 120 diff
computations. Only not mounting the card avoids that work, which is why the acceptance criterion
below is stated as "no offscreen file performs `toRdvFromContent`".

## Existing Patterns to Reuse

### `VirtualizedDropdownList`

The dropdown component establishes the right baseline for a shared list primitive:

- A count threshold keeps small lists non-virtual.
- Stable item keys back both direct and virtual rendering.
- The parent owns the scroll container.
- A one-shot `useLayoutEffect` re-render is required because a child's layout effects run before
  React attaches the parent's scroll-container ref. Removing this produces a permanently blank
  virtual list on remount.
- Virtual rows are absolutely positioned inside a total-height spacer and measured with
  `rowVirtualizer.measureElement`.

Its current public abstraction should not be used directly for diffs. It assumes one constant
row estimate and fixed-height dropdown rows, uses an overscan of 12, and owns dropdown-specific
`scrollToKey` behavior. Diff cards have highly variable heights and are expensive enough that a
much smaller overscan is necessary.

### `useOutputVirtualization` and `outputRows`

The Output pane supplies the dynamic-height lessons:

- `estimateSize` must be **O(1) per virtualizer call**. TanStack can rebuild estimates from the
  lowest changed row through the end of the list whenever one row reports a size.
- Projection publishes a pre-warmed `estimateSize` on each immutable output row. Expensive text
  and diff analysis is not repeated in the virtualizer callback.
- Realized rows are measured and their actual heights replace estimates.
- Estimates use the shared measured geometry in `outputLineMetrics.ts` and render-plan helpers in
  `rdvAdapter.ts`, rather than inventing new line-height multipliers.
- Overscan is deliberately small for expensive output rows.

Do **not** reuse the Output pane's complete hook or scroll correction system. Its measurement
cache, streaming-row staging, fast-scroll placeholders, minimap layout, and single-owner anchor
lock solve Output-specific problems. A modal or workspace diff list has no streaming append or
minimap and should allow TanStack's ordinary item-size compensation. In particular, do not add a
second `scrollTop` writer copied from `useOutputScrollTarget`.

## Proposed Architecture

### 1. Extract a small generic measured-list primitive

Extract the reusable mechanics in `VirtualizedDropdownList` into a component such as
`VirtualizedList<T>` under `components/shared/`. Its contract should include:

- `items`, `getItemKey`, and `renderItem`.
- `scrollContainerRef` owned by the caller.
- `estimateItemSize(item, index)`, whose result is already precomputed or otherwise O(1).
- `threshold` and `overscan`.
- An optional layout/reset key that invalidates measured sizes when every row's geometry changes
  (global expand/collapse, view-type change, or material content-width change).
- The existing one-shot post-mount re-render that resolves the parent's scroll element.
- The existing stale-index guard.
- Optional one-shot `scrollToKey` behavior so `VirtualizedDropdownList` can remain a thin wrapper
  without losing its current API.

Refactor `VirtualizedDropdownList` onto this primitive and retain its current defaults and tests.
This makes the parent-ref lifecycle rule single-sourced without forcing dynamic diff behavior
into a dropdown-named component.

### 2. Project groups into a flat virtual row model

Add a small projection utility (for example `utils/diffFileRows.ts`) that flattens the display
into a discriminated union:

```ts
type DiffFileListRow =
  | { kind: "selection-summary"; key: string; estimateSize: number }
  | {
      kind: "group-heading";
      key: string;
      estimateSize: number; /* heading data */
    }
  | { kind: "file"; key: string; estimateSize: number /* card data */ };
```

Include the existing 12 px inter-item spacing in the row wrapper/estimate instead of relying on
`gap-3` between absolutely positioned children. The direct-render path must use the same row
projection and spacing so the threshold does not change visual geometry.

Give `DiffFileGroup` a stable semantic key. Build file row keys from the group key plus the
existing file key; do not use heading text or the current array index as persistent state
identity. The same path can legitimately appear in more than one semantic group.

The virtualization threshold should be based on **file count**, not the number of projected
summary/heading rows. Start with 30 files and an overscan of 2, then calibrate both values with
the performance fixture described below. Keep these as module constants rather than user
settings until profiling demonstrates a user-facing tuning need.

### 3. Keep estimates cheap and reusable

Each projected row must publish its estimate once. `estimateItemSize` should only return the
number stored on that row.

For file rows:

- Define and measure card-specific chrome once: card borders, the two-line path header, optional
  note, `DiffView` summary row, margins, and the list-row gap.
- Reuse `rdvAdapter.ts`'s existing render-plan pipeline for the expanded body rather than
  re-deriving line geometry: `getRenderedDiffStats(hunks, viewType)` →
  `buildDiffRenderPlanFromStats(stats, { viewType, collapsed, outputFontSize, outputContentWidth,
hunks, layoutMode: "file-edit" })`, and take **`plan.diffBlockHeight`** (summary header + body).
  Do not take `plan.totalHeight`: it adds `toolLineHeight` for the Output pane's `● Edited <path>`
  header, which a `DiffFileCard` does not render. Card chrome (border, two-line path header,
  optional note, `my-1` margin, list-row gap) is added on top of `diffBlockHeight`.
- For an existing `hunks` source, derive an accurate render plan without reparsing content.
- For a structured patch, count patch display lines without syntax tokenization.
- For raw old/new content, use a cheap line-count/change-density estimate; do not run
  `toRdvFromContent` merely to estimate an offscreen row. Cache source metrics by the stable
  `source` object so checkbox changes that rebuild card props do not rescan both strings.
- Key geometry caches by source identity, collapsed state, view type, font size, and the relevant
  content-width bucket. Never return an estimate produced for unified layout after switching to
  split layout.

The realized card remains authoritative. Attach `measureElement` to the outer virtual row so
expansion, gap expansion, wrapped notes, responsive view changes, and deferred syntax tokens all
update the actual height.

Do not import `estimateOutputRowHeight` for a card. An Output structured-event row includes the
tool-call gutter/header and OutputRow group padding, while a `DiffFileCard` has different chrome.
The plan should share measured line geometry and render statistics, not a numerically incorrect
top-level estimate.

### 4. Preserve state across virtual unmounts

`DiffView` **already supports** controlled `collapsed` / `onCollapsedChange` / `expandedGaps` /
`onExpandGap` (the virtualized Output rows use them today) and already accepts
`localResetVersion`. `DiffFileCard` forwards `globallyCollapsed`, `localResetVersion` and
`viewType` but **not** the controlled-state props, so a card's expansion and gap maps are
uncontrolled and would reset whenever a file scrolls out of the render window. The work here is
threading and list-level ownership, not new `DiffView` capability — do not add a second control
mechanism.

Lift the following state to `DiffFileList`, keyed by the composite file-row key:

- Per-file collapsed override.
- Per-file expanded-gap state.

Thread the existing controlled `collapsed`, `onCollapsedChange`, `expandedGaps`, and
`onExpandGap` capabilities through `DiffFileCard` to `DiffView`. Prune entries when their file
keys disappear.

Represent Expand all / Collapse all as a list-level command containing `{ version, collapsed }`.
Both consumers already hold exactly this pair as two separate `useState` values
(`dialogDiffsCollapsed` + `dialogDiffResetVersion`, `commitDiffsCollapsed` +
`commitDiffResetVersion`) and copy them onto every card's props; formalize that pair as one
list-level prop instead of inventing a third concept.
Store local overrides with the command version that created them. When the version changes, old
overrides and gap expansions are ignored immediately in render and then discarded; do not wait
for 100 child effects to synchronize uncontrolled state. This also preserves the existing
behavior where pressing Expand all again resets manually collapsed files even when the global
boolean was already `false`.

Checkbox state and undo/redo instructions already live above the cards and are keyed by file, so
offscreen selection must remain fully functional. Select all and confirm must continue to operate
over the complete model, never only `rowVirtualizer.getVirtualItems()`.

### 5. Measure responsive layout once per list

When `viewType` is not supplied, every mounted `DiffView` currently installs its own
`useElementNarrow` observer and takes an initial `getBoundingClientRect()` measurement. The Output
pane avoids this by measuring once and passing its chosen view type to every diff.

Apply the same ownership to `DiffFileList`:

- Observe the list/scroll content width once.
- Resolve split versus unified view once and pass it to every visible `DiffFileCard`.
- Use the observer entry's `contentRect` for subsequent notifications.
- Invalidate row estimates/measurements when view type, font size, or a material width bucket
  changes.

One initial synchronous measurement may still be needed to avoid a wrong-layout first paint. It
is preferable to one measurement and observer per visible card, and virtualization keeps the DOM
against which that measurement runs small.

### 6. Wire each scroll owner explicitly

`DiffFileList` should accept a `scrollContainerRef`; it should not create a nested scroller.
Nested scrolling would break the modal footer/header layout, sticky file headers, touch behavior,
and workspace viewer sizing.

- Add an optional body ref to `Modal` and pass it from `UndoChangesDialog` to `DiffFileList`.
- Add refs to the existing `overflow-auto` wrappers in both `WorkspaceDiffPane` modes.
- Keep selection summary and group headings in the same scroll coordinate space by projecting
  them as rows rather than placing an unaccounted normal-flow prefix before the virtual canvas.

The list may accept an absent ref only as an explicit non-virtual fallback for isolated tests or
future callers. All production multi-file callers should provide the real scroll owner.

### 7. Preserve the user's visible anchor on global resets

Expand all can be clicked from the fixed dialog or workspace header while the user is midway
through the list. Changing every estimate from collapsed to expanded must not silently move the
visible file several screens away.

Before applying a global layout command, capture the first visible file key and its offset within
the scroll viewport. After invalidating estimates, restore that key and offset once, then let
normal row measurement refine sizes. Keep this as a small list-local operation; do not copy the
Output pane's continuously committed scroll-target state or its custom `scrollTop` ownership.

Individual expansion and measurement should use TanStack's normal dynamic-size behavior. Avoid
smooth scrolling while row heights are still being measured because TanStack cannot make smooth
scrolling reliable with changing item sizes.

## Phased Implementation

### Phase 1 — Shared primitive and row projection

1. [x] Extract `VirtualizedList<T>` and migrate `VirtualizedDropdownList` without behavior changes.

   Landed in Phase 1 item 1: the shared primitive now owns threshold branching,
   parent-owned scroll-element re-resolution, dynamic row measurement, layout-reset
   invalidation, stale-index protection, and one-shot `scrollToKey` handling. The
   dropdown remains a thin wrapper with its existing defaults and DOM output. The
   primitive's estimate callback is documented as O(1) and receives the item/index
   contract needed for precomputed diff-row estimates.

2. [x] Add stable group keys and the flat `DiffFileListRow` projection.
3. [x] Add card-specific estimate utilities with O(1) virtualizer callbacks.
4. [x] Keep `DiffFileList` on its direct-render path while testing projection geometry independently.

Phase 1 items 2–4 landed in the shared `diffFileRows` projection. The direct path now renders
the same flat rows that will later feed `VirtualizedList`; each row publishes its estimate once,
and the future virtualizer callback can return that stored number without doing diff work. Empty
groups and the existing heading/spacing rules are preserved. Semantic group keys are supplied by
the workspace and undo consumers, while the projection's fallback uses only the stable file-key
signature (never heading text or array position).

The measured card-chrome constants are: 2px for the outer one-pixel borders, 1px for the header
border, 8px for header `py-1`, 16px per `text-xs` line, 2px for the header `gap-0.5` before a
note, 8px for `DiffView`'s `my-1`, and 12px for the existing `gap-3` list spacing. Raw-content
metrics are cached by source object identity; render geometry additionally keys on collapsed
state, view type, font size, and a 32px content-width bucket.

### Phase 2 — Controlled per-file state (before any virtualization)

1. Lift collapse and gap-expansion state into the list, threading `DiffView`'s existing controlled
   props through `DiffFileCard`.
2. Convert global collapse resets to the versioned list command.

Per the risk register below, controlled per-file state is a **precondition** for enabling
virtualization: shipping the threshold first would land an intermediate state where scrolling a
file out of the window silently discards its expansion and gap state. This phase changes no
rendering structure and is independently verifiable.

### Phase 3 — Scroll ownership and single width measurement

1. Add the `scrollContainerRef` contract and wire `Modal`, `UndoChangesDialog`, and
   `WorkspaceDiffPane`.
2. Resolve split/unified once in `DiffFileList` and pass `viewType` to every card.

### Phase 4 — Conditional virtualization

1. Turn on virtualization at the file-count threshold.
2. Measure realized variable-height rows and invalidate on width/view-type changes.
3. Confirm sticky file headers remain constrained to their own card inside absolute row wrappers.
4. Expose list position metadata on realized rows.

### Phase 5 — Interaction correctness under virtualization

1. Preserve the visible file anchor across Expand all / Collapse all.
2. Ensure selecting, opening, and confirming an offscreen file still uses the complete model.

### Phase 6 — Profile and tune

1. Add a development fixture with at least 120 files containing a mix of small patches, large
   raw-content diffs, multiple hunks, renamed files, long paths, and wrapped notes.
2. Record dialog open, Expand all, fast scroll, individual gap expansion, Collapse all, and close.
3. Tune the threshold, overscan, and estimates from measured versus estimated heights.
4. Only after this pass, consider a bounded cache for parsed raw-content diffs if scrolling back
   repeatedly causes meaningful reparsing. Consider a Web Worker only if lazy mounting leaves a
   material initial diff-construction task; it is not part of the first implementation.

## Test Plan

### Shared virtual list

- Preserve the existing below-threshold direct-render behavior.
- Preserve the parent-owned-ref regression test: a virtual list must render rows on its first
  mount without relying on an unrelated update.
- Cover stale virtual indexes, stable keys, dynamic measurement, layout-key invalidation, and
  one-shot `scrollToKey` behavior.
- Verify the dropdown wrapper retains its existing defaults and DOM behavior.

### `DiffFileList`

- Render 100 files with a mocked `DiffView` and assert that only the viewport plus overscan is
  mounted; do not merely assert that the first row exists.
- Scroll to a later range and verify earlier cards unmount and later cards mount.
- Verify headings, heading hints, selection summary, and file order on both sides of the
  virtualization threshold.
- Verify actual row measurements replace estimates after a card expands or a note wraps.
- Verify split/unified and width changes invalidate stale measurements.
- Verify a manually collapsed file and expanded gap retain their state after virtual unmount and
  remount.
- Verify a new global reset version overrides all local states, including files currently
  offscreen.
- Verify Expand all does not mount every `DiffView`.
- Verify empty and single-file behavior remains non-virtual.

JSDOM has no layout. Follow `VirtualizedDropdownList.test.tsx` by stubbing the scroll container's
`offsetHeight`/`offsetWidth` and row measurements explicitly; otherwise TanStack will see a
zero-height viewport and a passing test can hide a blank production list.

### Consumer behavior

- Keep all existing undo/redo payload tests. Add a 100-file case proving Select all and Confirm
  include offscreen files.
- Verify Open File operates on a virtualized visible row.
- Verify workflow undo remains newest-step-first and workflow redo remains oldest-step-first.
- Verify workspace commit diff Expand all / Collapse all and download behavior are unchanged.
- Add a smoke scenario that mounts the whole app with a large undo dialog state so unstable
  selectors or measurement effects cannot hide behind component mocks.

### Accessibility and manual checks

- Expose list position metadata (`aria-setsize`/`aria-posinset`, or equivalent semantics) for
  realized file rows so assistive technology is not told the visible subset is the entire list.
- Confirm keyboard focus is never discarded when a focused card approaches a virtual boundary;
  overscan must keep the focused row mounted until focus leaves it.
- Confirm the fixed modal header/footer, sticky per-file header, touch scrolling, browser zoom,
  and high-contrast outlines work in both hosted Chrome and the VS Code webview.
- Document that browser Find can only inspect mounted diff bodies; application-level find, if
  added later, must search the complete data model rather than the DOM.

## Performance Acceptance Criteria

Using the 120-file fixture on the same reference desktop/browser:

- Mounted `DiffView` count is bounded by the viewport plus overscan and does not grow with total
  file count.
- Expand all performs work proportional to visible files, not all 120 files.
- No offscreen file performs `toRdvFromContent`, syntax tokenization, or renders a diff table.
- The DOM node count and layer count stay approximately flat when comparing 60, 120, and 240
  files at the same viewport size.
- Opening the dialog and Expand all each meet the 200 ms responsiveness target unless the single
  visible diff alone exceeds that budget; record such a file separately rather than hiding it in
  aggregate results.
- Scrolling does not show blank ranges, repeated large jumps, or loss of per-file expansion state.
- Closing the dialog promptly releases mounted diff trees and observers.

## Affected Files

| Area                                                 | Planned change                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `components/shared/VirtualizedDropdownList.tsx`      | Move generic virtualization mechanics into the shared measured-list primitive                    |
| `components/shared/VirtualizedList.tsx`              | New thresholded, dynamically measured generic list                                               |
| `components/diff/DiffFileList.tsx`                   | Flat row projection, conditional virtualization, centralized width and persistent per-file state |
| `components/diff/DiffFileCard.tsx`                   | Thread controlled collapse and gap-expansion props into `DiffView`                               |
| `utils/diffFileRows.ts`                              | New row model and O(1) published estimates                                                       |
| `utils/rdvAdapter.ts` / `utils/outputLineMetrics.ts` | Reuse or extend measured diff geometry without duplicating constants                             |
| `components/shared/Modal.tsx`                        | Expose the existing body scroll element through a ref                                            |
| `components/output/UndoChangesDialog.tsx`            | Supply scroll ref and versioned global collapse command                                          |
| `components/workspace-viewer/WorkspaceDiffPane.tsx`  | Supply scroll refs and versioned global collapse command                                         |
| UI tests under `test/components/**`                  | Virtual range, state persistence, consumer behavior, and parent-ref regression coverage          |

## Non-Goals

- Replacing or simplifying `useOutputVirtualization`.
- Virtualizing individual lines inside one enormous diff. This plan virtualizes file cards; one
  visible file can still contain a very large `react-diff-view` table.
- Moving diff algorithms to a Web Worker in the first implementation.
- Changing undo/redo aggregation, ordering, or protocol payloads.
- Adding a user-facing virtualization threshold setting.
- Persisting dialog expansion state after the dialog closes or after a different workspace diff
  replaces the current one.

## Risks and Guardrails

- **State loss on unmount:** controlled per-file state is required before enabling virtualization.
- **Bad estimates causing scrollbar jumps:** publish estimates once, measure realized rows, and
  invalidate by layout key. Do not perform content parsing inside `estimateSize`.
- **Blank first mount:** retain the parent-ref one-shot layout re-render from
  `VirtualizedDropdownList` and its regression test.
- **Sticky header regression:** measure the entire file row and keep virtual wrappers free of
  overflow that would create a new sticky containing block.
- **Selection limited to mounted rows:** all commands must operate on the source model, never the
  virtual item range.
- **Over-generalizing Output behavior:** share geometry and generic list mechanics only; keep the
  Output pane's anchor-lock and streaming logic isolated.
- **Recomputation while scrolling back:** profile before adding caching. If needed, use a bounded
  or source-identity cache rather than keeping every offscreen React tree mounted.

## Definition of Done

- Both multi-file consumers virtualize above the chosen threshold.
- Small lists preserve their existing rendering and interaction behavior.
- Expand all on 100+ files mounts only visible diff trees.
- Per-file collapse and gap state survive virtual unmount/remount.
- Selection and undo/redo payload behavior remains unchanged for offscreen files.
- Estimates are O(1) in the virtualizer callback and use shared measured geometry.
- Automated tests cover parent-ref resolution, dynamic height changes, global resets, offscreen
  selection, and both consumers.
- Automated, deterministic evidence replaces the multi-second expand-all task: a test over the
  120-file fixture asserts that the mounted `DiffView` count and rendered DOM node count stay
  bounded by viewport + overscan and do **not** grow when the fixture doubles from 120 to 240
  files, and that Expand all mounts no additional offscreen cards.
- A wall-clock before/after Chrome trace on a reference desktop remains valuable but is a manual
  follow-up, not a gate — it cannot be produced reproducibly from a headless test run, and the
  bounded-mount assertions above are the criterion the implementation is held to.
