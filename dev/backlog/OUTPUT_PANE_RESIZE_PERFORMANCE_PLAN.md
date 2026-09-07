# Output-Pane Resize & Mount Performance Plan

**Status:** Partially implemented — the dominant cost was found and fixed
2026-09-07 (see "Fixed" below). The remaining items are real but an order of
magnitude smaller than they looked.
**Priority:** P2 (was P1 before the fix)

## Relationship to the paging plan

`dev/backlog/RUN_VIEW_PAYLOAD_PAGING_PLAN.md` is about the **payload** — the
54.5 MB `RUN_VIEW_LOADED` message. This plan is about what the **client does
with the rows after they arrive**. On the reproduction run the client side was
by far the larger cost: 15.6 s of blocked main thread against 1.5 s of
extension-host work.

## Fixed 2026-09-07: undo actions recomputed once per message

`buildOutputRows` called `computePromptUndoActions(allStepOutputs, undoRecord,
workspaceSnapshot)` inside its per-message loop. All three arguments are
per-**target**, and `stepOutputsMap` is fully populated by an earlier pass, so
the answer cannot change mid-loop — but `computePromptUndoActions` walks every
structured event of every attempt the target owns, so the constant answer was
re-derived once per message.

On the reproduction run that is **4 652 calls with 19 distinct answers between
them**. Memoizing per target key collapses it to 19.

### Measured, in the hosted dashboard

Real browser against the shared dev host, `PARALLEL_STEPS_PLAN` /
`run-2026-09-04T01-35-57-252Z`, instrumented through the built-in profiler
(`window.ctrlyokeProfiler`) plus a temporary breakdown probe inside
`buildOutputRows`:

| Phase                                            | Before                | After        |
| ------------------------------------------------ | --------------------- | ------------ |
| **worst blocked frame, click → settled**         | **15 599 ms**         | **2 142 ms** |
| `buildOutputRows`, per build (2 builds per load) | 6 506 / 6 913 ms      | 139 / 120 ms |
| — `computePromptUndoActions`                     | 6 413 ms／4 652 calls | 19 calls     |
| — `computeOutputDiffStats`                       | 25 ms／776 calls      | unchanged    |
| — `buildToolCallRenderPlan`                      | 23 ms／1 820 calls    | unchanged    |
| — the rest of the main loop                      | ~90 ms                | ~90 ms       |
| — the three pre-scan loops                       | ~2 ms                 | ~2 ms        |
| `minimapSteps`                                   | 21–29 ms              | unchanged    |
| `rowLayout`                                      | 2–3 ms                | unchanged    |
| extension host — history read                    | 297 ms                | unchanged    |
| extension host — build + redact + send           | ~1 190 ms             | unchanged    |

Shape of the run: 4 653 messages, 5 256 rows, 19 targets, 773 diff rows.

### Why this was missed the first time

The original pass measured `buildOutputRows` from a Node/vitest probe that
passed `allowUndoActions: false`, which gates the entire undo path. Every other
number the probe produced matched the browser exactly — 4 653 messages, 5 256
rows, 776 diff-stat calls, 1 820 tool-call plans, ~130 ms of remaining loop —
so the probe looked trustworthy while silently omitting 98 % of the cost.
**A row-building measurement that does not set `allowUndoActions: true` is not
measuring the run-view path**, because the run view always allows undo.

## What remains

### Problem 1: every width change still rebuilds every row

`OutputSection.tsx`'s width layout effect writes `outputContentWidth` whenever
the measured pane width moves by ≥ 0.5 px, behind a rAF-coalesced
ResizeObserver, so a drag produces roughly one write per frame.
`outputContentWidth` is a dependency of the `buildOutputRows` memo in
`useOutputRowsModel.ts`.

Post-fix that is **~110–130 ms per width change** rather than ~6.5 s. Two
viewport changes driven through Playwright produced blocked frames of 477, 290,
193, and 119 ms. Still worth fixing — a continuous drag fires one rebuild per
frame — but it is no longer a freeze.

The rebuild cascades: a new `rows` array invalidates `rowLayout`, which
invalidates `minimapSteps`, which hands `OutputMinimap` a brand-new `steps`
array (defeating its `memo`), and every mounted `OutputRow` re-renders.

Almost none of the ~120 ms is genuinely width-dependent. Width feeds height
_estimates_ and the two render plans; the row set, keys, ordering, and content
are identical across a drag.

#### The mechanism already exists in this codebase

`useElementTier` (`src/ui/webview-react/hooks/useElementNarrow.ts`) was written
for this. Its docs: _"The tier — not the raw width — is what enters React
state, so a resize only re-renders when it actually crosses a boundary."_
`DiffFileList.tsx` already uses it with a 32 px width bucket
(`DIFF_FILE_CONTENT_WIDTH_BUCKET`, commented "to avoid retaining one geometry
entry per pixel resize"). The output pane is the one width-sensitive surface
that bypasses it, with a bespoke ResizeObserver layout effect writing raw
sub-pixel width into state.

Three properties make it a drop-in rather than a rewrite:

- It measures **on callback-ref attach**, during commit and before paint. That
  satisfies the requirement the 2026-08-13 comment in `OutputSection.tsx`
  documents — the reason that effect is a `useLayoutEffect` — so adopting the
  hook preserves it rather than regressing it.
- Its `measureWidth` is the element's border box, the same box
  `el.getBoundingClientRect().width` reads today. No estimate drift.
- It already has a **`deferWhile`** parameter: _"suppresses tier updates until
  it becomes false, then applies the most recent observed width. Useful for
  avoiding layout churn while a higher-priority resize (e.g. a panel drag) is
  active."_ Built, and still with no production caller.

#### Proposal 1A — bucket the width through `useElementTier`

Decisions, so this is not re-litigated at implement time:

- **Bucket size: 32 px**, reusing the existing value. A second bucket size
  would let a boundary fall between the output pane and the diff list it
  embeds.
- **Round with `floor`**, matching `DiffFileList`. Flooring assumes a slightly
  narrower pane, so wrap counts and heights are over-estimated rather than
  under-estimated — the safe direction, given the 78 %-under-count regression
  the 2026-08-13 comment records.
- **Single-source the bucketing.** `DiffFileList.tsx:53`
  (`resolveDiffFileContentWidthBucket`) and `diffFileRows.ts:122`
  (`contentWidthBucket`) are today two copies of `Math.floor(width / BUCKET)`.
  Move the constant to `outputLineMetrics.ts` — which already owns
  `DEFAULT_OUTPUT_CONTENT_WIDTH`, `MIN_OUTPUT_CONTENT_WIDTH`, and
  `resolveOutputContentWidth` — as `OUTPUT_CONTENT_WIDTH_BUCKET`, add a
  `bucketOutputContentWidth(width)` helper beside it, and delete both copies.
- **`initialTier: 0`, meaning unmeasured — and keep `0`, not `undefined`, as
  the width the pane passes down.** Convert with
  `bucket * OUTPUT_CONTENT_WIDTH_BUCKET`, which is already `0` when unmeasured.
  `DiffFileList.tsx:110` maps its own unmeasured bucket to `undefined` because
  `projectDiffFileListRows` takes an optional width; the output pane's two
  consumers do not — `useOutputRowsModel.ts:72` and
  `useOutputVirtualization.ts:75` both declare `outputContentWidth: number`,
  and `OutputSection` has passed `useState(0)` since it was written. `0` and
  `undefined` are already equivalent everywhere downstream
  (`resolveOutputContentWidth` and `outputRows.ts`'s `showParamsLabel` branch
  both test `== null || === 0`), so keeping `0` preserves behaviour exactly
  while avoiding a widening of two hook prop types to `number | undefined`
  that buys nothing.
- **Expect the bucketed width to reach the virtualizer too.**
  `useOutputVirtualization.ts:236` feeds `outputContentWidth` into
  `estimateOutputRowHeight`, so flooring applies there as well. That is the
  same safe direction as everywhere else — a narrower assumed pane
  over-estimates wrapped height — and the bulk-remeasure path already corrects
  the residual.
- **Derive `outputDiffViewType` from the bucketed width and delete its
  `useState`.** It is a second piece of state recomputed in the same effect and
  a second rebuild trigger. `DIFF_SPLIT_VIEW_MIN_WIDTH`
  (`OutputSection.tsx:95`) and `DIFF_SPLIT_VIEW_THRESHOLD`
  (`DiffFileList.tsx:44`) are two module-private constants both equal to
  `1024`; promote one alongside the bucket. Take the same opportunity to drop
  the inline `"split" | "unified"` literal unions at `OutputSection.tsx:366`
  and `useOutputRowsModel.ts:70` in favour of the existing `DiffViewType` /
  `DIFF_VIEW_TYPES` in `DashboardConstants.ts`, which `diffFileRows.ts` and
  `outputLineMetrics.ts` already use.
- **Fire the scroll correction once per bucket change**, not once per frame.
  `applyScrollTargetRef.current("width-change")` currently runs every frame,
  forcing a synchronous layout against a ~500 000 px scroll canvas each time.

#### Proposal 1B — defer rebuilds while a resize is in flight

Pass `deferWhile` to hold updates while a resize is active, letting the hook
apply the most recent observed width on release.

The signal must be **source-agnostic**. The originally reported symptom is
resizing the VS Code panel, which never touches `react-resizable-panels`; its
`onLayoutChanged` settle callback (v4.11.1 has `onLayoutChange` /
`onLayoutChanged`, no `onDragging`) covers only the internal splitter. Use a
"pane width moved within the last ~150 ms" flag instead.

What goes stale mid-drag is bounded and self-correcting: row **content** does
not depend on width (the DOM reflows via CSS); height **estimates** go stale,
which the bulk-remeasure path in `useOutputVirtualization.ts` already exists to
correct; `toolCall.renderPlan.maxResultChars` and `diff.renderPlan` geometry
are stale until settle.

**Recommendation: ship 1A, then re-measure before doing this.** At ~120 ms a
rebuild, 1A alone may be enough, and `deferWhile` has no production caller
today, so 1B is the only item here carrying unproven-code risk.

### Problem 2: the minimap renders ~7 100 elements into an ~1 000 px rail

The minimap's _computation_ is not the problem — `minimapSteps` measures
21–29 ms in the real app, and `estimateOutputDiffBlockHeight` just reads a
precomputed `renderPlan.diffBlockHeight`. The nested
`uniqueStepTargets × rows` scan is genuinely quadratic but irrelevant at this
size.

The cost is the **DOM**. `OutputMinimap.tsx` renders one absolutely-positioned
div per diff block and one per run inside it: 773 + 6 345 ≈ 7 100 elements with
percentage `top`/`height`, into a rail roughly 1 000 px tall — ~7 elements per
rail pixel, six of every seven indistinguishable on screen. They are created on
mount and fully reconciled on every resize frame, because `minimapSteps`
depends on `rowLayout` and `rows`.

**This is now the leading suspect for the remaining post-fix cost.** After the
undo fix the worst blocked frame is 2 142 ms, of which the two
`buildOutputRows` passes account for only ~260 ms; the other ~1.9 s is React
commit, virtualizer measurement, and style/layout, and nothing else in the
mount path scales with run size the way the minimap tree does. That is a
hypothesis, not a measurement — confirm it before or while implementing 2A.

#### Proposal 2A — quantize to rail pixels

Collapse diff blocks and their runs to the rail's pixel resolution before
rendering, capping total elements at roughly the rail height.

- **Quantize in `OutputMinimap.tsx`, not in `useOutputMinimapModel.ts`.** The
  rail height is only known to the component, which already tracks it as
  `railHeightPx` state. The hook's ~25 ms is not worth restructuring.
- **A `useMemo` over `steps` + `railHeightPx`**, producing a flat array of at
  most `railHeightPx` bars. For each rail row, accumulate `addedLines` /
  `removedLines` from every overlapping block and run, then emit one div per
  occupied row using the gradient rule the collapsed-block branch already uses.
- **Flattening across steps is safe.** The per-step `React.Fragment` is keying
  only — blocks are absolutely positioned in one shared track and are all
  `pointer-events-none`, so no hit-testing or hover behaviour depends on it.
- **`railHeightPx === 0` renders nothing.** Percentage positions cannot resolve
  before the rail is measured.

#### Proposal 2B — separate stable step data from positions

Split `minimapSteps` so labels, undo actions, hidden/selected state, and diff
line counts memoize independently of `rowLayout`, leaving only
`scrollFraction`/`heightFraction` recomputed when geometry moves, and memoize
each step's subtree. Conditional on 2A leaving resize commits heavy.

#### How this unblocks paging

The paging plan flags the minimap as the hard part of windowing: it is a
whole-run overview by definition. Rail-pixel buckets are a compact whole-run
summary a windowed reader could produce from a `TimelineRecorder.streamEvents`
pass without materializing every row, so the minimap can stay whole-run while
the row list pages. **Design 2A's bar array as something a summary projection
could also produce**, not as a view detail private to the component.

### Problem 3: two full row builds per load, at the same width

Every load runs `buildOutputRows` twice over all 4 653 messages, at an
identical measured width (`747.59` in one session, `753.58` in another) — so
this is _not_ a width-0-then-measured sequence, and the "skip the unmeasured
build" idea from the first draft of this plan was wrong. Some other memo
dependency changes between the two passes. At ~120 ms each this is now ~240 ms,
worth finding but no longer urgent; the dependency array in
`useOutputRowsModel.ts` is the place to start.

## Non-goals

- **Do not optimize the `minimapSteps` nested scan.** 21–29 ms. A single
  grouped pass would be a tidier shape and change nothing measurable.
- **Do not rewrite the minimap as a canvas.** Quantized bars are bounded by
  rail height, which the DOM handles fine; canvas would give up the theme CSS
  tokens the bars are painted with and the hover/pin affordances over the
  track.
- **Do not move row building to a worker.** The output is 5 256 row objects
  carrying render plans; structured-cloning them back costs more than the
  ~120 ms saved, the same trap the paging plan's non-goals record.
- **Do not couple this to paging.** Every proposal lands independently of
  `RUN_VIEW_PAYLOAD_PAGING_PLAN.md` and makes that plan cheaper, not harder.

## Sequencing

1. **2A** — quantize the minimap. Largest remaining cost if the hypothesis
   holds, and the prerequisite for a whole-run minimap over a paged row list.
2. **1A** — bucket the width through `useElementTier` and single-source the
   bucket and split-view threshold.
3. **Problem 3** — find the second build's trigger.
4. **1B** — `deferWhile`, only if 1A leaves a drag that still stutters.
5. **2B** — split minimap memoization, only if 2A leaves resize commits heavy.

## Acceptance criteria

- [x] Opening the reproduction run no longer blocks the main thread for 15 s
      (15 599 ms → 2 142 ms, measured in the hosted dashboard).
- [x] Undo actions are computed once per target rather than once per message,
      with coverage in
      `src/ui/webview-react/test/utils/outputRowsUndoMemo.test.ts`.
- [ ] Minimap element count is bounded by rail height rather than run size, and
      the rendered minimap is visually indistinguishable from today's at the
      same pane size.
- [ ] The ~1.9 s of non-`buildOutputRows` time in the remaining 2 142 ms frame
      is attributed to named phases and recorded here.
- [ ] `buildOutputRows` runs at most once per 32 px of width change during a
      gesture — asserted by spying on the builder, not by wall-clock timing.
- [ ] Exactly one bucketing helper and one split-view threshold constant across
      `OutputSection.tsx`, `DiffFileList.tsx`, and `diffFileRows.ts`.
- [ ] Dragging the panel splitter, the VS Code panel edge, and the window with
      the reproduction open holds interactive frame rates.
