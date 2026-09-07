# Output-Pane Resize & Mount Performance Plan

**Status:** Backlog — ready to implement, proposed 2026-09-07
**Priority:** P1 — resizing the panel with a large run open freezes the UI for
the duration of the drag, which is worse than the slow initial load that
`RUN_VIEW_PAYLOAD_PAGING_PLAN.md` covers.

## Relationship to the paging plan

`dev/backlog/RUN_VIEW_PAYLOAD_PAGING_PLAN.md` is about the **payload** — 54.5 MB
crossing redaction, serialization, and the extension-host IPC boundary once per
run-view load. This plan is about what the **client does with the rows after
they arrive**, and none of it is fixed by making the payload smaller:

- Problem 2 there (on-demand `workspaceSnapshot` contents) removes 16 MB of
  transport but leaves the same row count. It would incidentally drop the
  23 ms/frame of `computeOutputDiffStats` below, because a diff row with no
  snapshot cannot build a render plan — that is a side effect to _plan for_,
  not a fix to rely on.
- Problem 1B (dropping the duplicated `activityEntries` encoding) shrinks the
  payload without changing how many rows `buildOutputRows` produces.
- Only Problem 1A (windowing) reduces row count, and it is sequenced last there
  precisely because the minimap has no range story.

**The resize freeze is independent, client-side, and cheaper to fix.** Do it
first; it also shrinks the minimap problem that 1A is currently blocked on.

## Measurements

Measured 2026-09-07 against the same reproduction as the paging plan —
`PARALLEL_STEPS_PLAN` / `run-2026-09-04T01-35-57-252Z` — with a throwaway vitest
probe driving the real `OutputHistoryTimelineAdapter.loadHistory`,
`mapOrderedHistoryEntriesToMessages`, and `buildOutputRows`:

| Phase                                  | Cost                            |
| -------------------------------------- | ------------------------------- |
| `loadHistory`                          | 337 ms                          |
| `mapOrderedHistoryEntriesToMessages`   | 38 ms → 4 653 messages          |
| `buildOutputRows` (cold)               | 215 ms → 5 256 rows             |
| **`buildOutputRows` per width change** | **130 ms**                      |
| — of which `computeOutputDiffStats`    | 23 ms over 776 calls            |
| — of which `buildToolCallRenderPlan`   | 16 ms over 1 820 calls          |
| `rowLayout` height-estimate pass       | 1 ms over 5 256 rows            |
| `minimapSteps` nested target×row scan  | 6 ms (19 × 5 256 = 99 864 iter) |

Shape of the run: 19 targets, 5 256 rows, 773 diff rows, and — the number that
matters — **773 minimap diff blocks carrying 6 345 run bars, ≈ 7 100
absolutely-positioned elements in the minimap alone**.

Ten simulated width steps (one drag) cost **1 303 ms of `buildOutputRows` alone**,
before React re-renders anything.

## Problem 1: every width change rebuilds every row

`OutputSection.tsx`'s width layout effect writes `outputContentWidth` whenever
the measured pane width moves by ≥ 0.5 px, and the ResizeObserver behind it is
rAF-coalesced — so a drag produces roughly one write per animation frame.
`outputContentWidth` is a dependency of the `buildOutputRows` memo in
`useOutputRowsModel.ts`, so **each frame of a drag rebuilds all 5 256 rows at
130 ms**, ~8× the frame budget. That is the freeze.

The rebuild then cascades: a new `rows` array invalidates `rowLayout`, which
invalidates `minimapSteps`, which hands `OutputMinimap` a brand-new `steps`
array (defeating its `memo`), and every mounted `OutputRow` re-renders because
every row object has a new identity.

Note that almost none of the 130 ms is genuinely width-dependent. Width feeds
height _estimates_ and the two render plans; the row set, keys, ordering, and
content are identical across the whole drag.

### The fix already exists in this codebase

`useElementTier` (`src/ui/webview-react/hooks/useElementNarrow.ts`) was written
for exactly this. Its own docs: _"The tier — not the raw width — is what enters
React state, so a resize only re-renders when it actually crosses a
boundary."_ `DiffFileList.tsx` already uses it with a 32 px width bucket
(`DIFF_FILE_CONTENT_WIDTH_BUCKET`, commented "to avoid retaining one geometry
entry per pixel resize"). The output pane is the one width-sensitive surface
that bypasses it, with a bespoke ResizeObserver layout effect writing raw
sub-pixel width into state.

Three properties make it a drop-in rather than a rewrite:

- It measures **on callback-ref attach**, which runs during commit before
  paint. That satisfies the requirement the 2026-08-13 comment in
  `OutputSection.tsx` documents — the reason that effect is a `useLayoutEffect`
  and not a `useEffect` — so adopting the hook preserves it rather than
  regressing it.
- Its `measureWidth` is the element's border box, the same box
  `el.getBoundingClientRect().width` reads today. No estimate drift.
- It already has a **`deferWhile`** parameter: _"suppresses tier updates until
  it becomes false, then applies the most recent observed width. Useful for
  avoiding layout churn while a higher-priority resize (e.g. a panel drag) is
  active."_ That is Proposal 1B, already built and waiting for its first caller.

### Proposal 1A — bucket the width through `useElementTier`

Replace the bespoke width layout effect with `useElementTier` and a
module-level bucket resolver, so a 300 px drag costs ~9 rebuilds instead of
~60.

Decisions, so this is not re-litigated at implement time:

- **Bucket size: 32 px**, reusing the existing value. A second bucket size would
  let a boundary fall between the output pane and the diff list it embeds.
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
  Pre-release, so update the call sites rather than aliasing.
- **`initialTier: 0`, meaning unmeasured.** Convert to a width with
  `bucket > 0 ? bucket * OUTPUT_CONTENT_WIDTH_BUCKET : undefined`, mirroring
  `DiffFileList.tsx:110`. Passing `undefined` (not `760`) keeps
  `buildOutputRows`'s existing unknown-width branch — the `showParamsLabel`
  behaviour at `outputRows.ts:2146` — behaving exactly as it does today.
- **Derive `outputDiffViewType` from the bucketed width and delete its
  `useState`.** It is currently a second piece of state recomputed in the same
  effect, and a second rebuild trigger. `DIFF_SPLIT_VIEW_MIN_WIDTH`
  (`OutputSection.tsx:95`) and `DIFF_SPLIT_VIEW_THRESHOLD`
  (`DiffFileList.tsx:44`) are two module-private constants both equal to
  `1024`; promote one to `outputLineMetrics.ts` alongside the bucket. The flip
  then lands on a bucket boundary instead of the exact pixel, which is already
  how the diff list behaves.
- **Fire the scroll correction once per bucket change**, not once per frame.
  `applyScrollTargetRef.current("width-change")` currently runs every frame,
  forcing a synchronous layout against a 466 685 px scroll canvas each time.

### Proposal 1B — defer rebuilds while a resize is in flight

Bucketing bounds the damage; it does not get a drag to one rebuild. Pass
`deferWhile` to hold updates while a resize is active, then let the hook apply
the most recent observed width on release — behaviour it already implements.

The signal has to be **source-agnostic**. The reported symptom is resizing the
VS Code panel, which never touches `react-resizable-panels`; its
`onLayoutChanged` settle callback (v4.11.1 has `onLayoutChange` /
`onLayoutChanged`, no `onDragging`) only covers the internal splitter. Use a
"pane width moved within the last ~150 ms" flag instead, which covers the
splitter, the VS Code panel, and the window alike.

What goes stale mid-drag is bounded and self-correcting:

- Row **content** does not depend on width — the DOM reflows natively via CSS.
- Row **height estimates** go stale, which the existing bulk-remeasure path in
  `useOutputVirtualization.ts` already exists to correct.
- `toolCall.renderPlan.maxResultChars` (a truncation limit) and
  `diff.renderPlan` geometry are stale until settle. `renderPlan.viewType` is
  the one part that visibly changes rendering, and it flips on a bucket
  boundary, so a deferred update cannot strand a diff in the wrong view for
  longer than the settle window.

**Recommendation: ship 1A and 2A first, then re-measure before doing this.**
1A alone leaves ~9 × 130 ms across a 300 ms drag — janky, not frozen — and 2A
removes the minimap reconcile stacked on top of it. `deferWhile` also has no
production caller today, so 1B is the only item here carrying unproven-code
risk; it deserves its own measurement rather than being bundled.

## Problem 2: the minimap renders ~7 100 elements into an ~1 000 px rail

The first guess was that the minimap _recompute_ was the cost. It is not — the
nested `uniqueStepTargets × rows` scan in `useOutputMinimapModel.ts` measures
**6 ms**, and `estimateOutputDiffBlockHeight` just reads a precomputed
`renderPlan.diffBlockHeight`. The quadratic shape is real but irrelevant at this
size; leave it alone.

The cost is the **DOM**. `OutputMinimap.tsx` renders one absolutely-positioned
div per diff block and one per run inside it: 773 + 6 345 ≈ 7 100 elements with
percentage `top`/`height`, into a rail roughly 1 000 px tall. That is ~7
elements per rail pixel — six of every seven cannot be distinguished on screen.
They are created on mount (a large share of the unattributed initial-load time
below) and fully reconciled on every resize frame, because `minimapSteps`
depends on `rowLayout` and `rows`.

### Proposal 2A — quantize to rail pixels

Collapse diff blocks and their runs to the rail's pixel resolution before
rendering, capping total elements at roughly the rail height.

Decisions:

- **Quantize in `OutputMinimap.tsx`, not in `useOutputMinimapModel.ts`.** The
  rail height is only known to the component, which already tracks it as
  `railHeightPx` state via its own ResizeObserver. The hook's 6 ms of block
  allocation is not worth restructuring, and leaving the model untouched keeps
  the diff to one component.
- **A `useMemo` over `steps` + `railHeightPx`**, producing a flat array of at
  most `railHeightPx` bars. For each rail row, accumulate `addedLines` /
  `removedLines` from every overlapping block and run, then emit one div per
  occupied row using the gradient rule the collapsed-block branch already uses.
- **Flattening across steps is safe.** The per-step `React.Fragment` is keying
  only — blocks are absolutely positioned in one shared track and are all
  `pointer-events-none`, so no hit-testing or hover behaviour depends on the
  grouping.
- **`railHeightPx === 0` renders nothing.** Percentage positions cannot be
  resolved before the rail is measured; today's code would place them at 0
  anyway.

### Proposal 2B — separate stable step data from positions

Split `minimapSteps` so labels, undo actions, hidden/selected state, and diff
line counts are memoized independently of `rowLayout`, leaving only
`scrollFraction`/`heightFraction` recomputed when geometry moves. Then memoize
each step's subtree so React reconciles ~19 memoized children instead of the
full block/run tree.

Conditional on 2A leaving resize commits heavy — after quantization the tree
being reconciled is bounded by rail height, which may make this unnecessary.

### How this unblocks paging

The paging plan flags the minimap as the hard part of windowing: it is a
whole-run overview by definition. A quantized minimap is the answer to that
too — rail-pixel buckets are a compact whole-run summary that a windowed reader
could produce from a `TimelineRecorder.streamEvents` pass without materializing
every row, so the minimap can stay whole-run while the row list pages. **Design
2A's bar array as something a summary projection could also produce**, not as a
view detail private to the component.

## Problem 3: ~7 s of the initial load is still unattributed

From the 2026-09-07 session log (`ctrlyoke-1788805001145.log`), opening this run
in the panel:

| Span                                             | Elapsed   |
| ------------------------------------------------ | --------- |
| click → `readAddressedRunView` definition read   | 0.36 s    |
| definition → summaries/descriptor/history read   | 0.36 s    |
| → `deliverRunView` snapshot sent                 | 1.47 s    |
| → `workflowStore.loadWorkflow` on the client     | 0.69 s    |
| **`loadWorkflow` → next logged client activity** | **7.5 s** |

The probe accounts for only ~600 ms of that last span in pure JS (two
`buildOutputRows` passes — one at unmeasured width, one at the real width —
plus the message projection). The remaining ~7 s is React commit, virtualizer
measurement, and style/layout. The prediction is that Problem 2's ~7 100
minimap elements dominate it, but that is a hypothesis: it is one large
synchronous tree with percentage geometry, mounted once, which matches the
shape of the gap, and nothing else in the mount path scales with run size the
same way. It is spent behind `showVirtualizationOverlay`, so the user sees a
loading state rather than a frozen one — which is why this is an investigation
item and not a blocker.

Confirm it with `window.ctrlyokeProfiler.enable({ logLongFrames: true, logMeasurements: true })`
in the webview devtools console
(`src/ui/webview-react/utils/performanceProfiler.ts`), then reopen the run. The
`measurePhase` instrumentation already wrapping `buildOutputRows`, `rowLayout`,
`minimapSteps`, and `stepScrollFractions` reports itself, and
`minimapViewportUpdate` already logs its own block count. **Do this after 2A
lands, not before** — if the prediction holds, 2A is also the fix, and
measuring after gives a before/after to record here.

Independently: skip the unmeasured `buildOutputRows` pass. Under 1A the
`useElementTier` callback ref measures during commit, so the unmeasured render
never reaches the screen — but it still costs 215 ms. Gate the memo to return
an empty row set when `contentWidthBucket === 0 && !outputCollapsed`. The
`outputCollapsed` escape is required: when the pane is collapsed the ref may
never attach, and without it the gate would strand `rows` empty permanently,
breaking find, export, and navigation, which read the same array.

## Non-goals

- **Do not optimize the `minimapSteps` nested scan.** 6 ms. Rewriting it to a
  single grouped pass would be a tidier shape and change nothing measurable.
- **Do not rewrite the minimap as a canvas.** Quantized bars are bounded by
  rail height, which is small enough for the DOM; canvas would give up the
  theme CSS tokens the bars are painted with and the hover/pin affordances
  layered over the track.
- **Do not move row building to a worker.** The output is 5 256 row objects
  carrying render plans; structured-cloning them back costs more than the
  130 ms saved, the same trap the paging plan's non-goals record.
- **Do not couple this to paging.** Every proposal here lands independently of
  `RUN_VIEW_PAYLOAD_PAGING_PLAN.md` and makes that plan cheaper, not harder.

## Sequencing

1. **1A** — bucket the width through `useElementTier`, single-source the bucket
   and the split-view threshold into `outputLineMetrics.ts`, derive
   `outputDiffViewType`, and gate the unmeasured build. One change: they all
   touch the same effect and the same memo.
2. **2A** — quantize the minimap to rail pixels.
3. **Problem 3** — profile the reopened run and record the attributed
   breakdown here.
4. **1B** — `deferWhile`, only if 1 and 2 leave a drag that still stutters.
5. **2B** — split minimap memoization, only if 2A leaves resize commits heavy.

## Acceptance criteria

- [ ] Dragging the panel splitter, the VS Code panel edge, and the window with
      the `PARALLEL_STEPS_PLAN` reproduction open holds interactive frame
      rates.
- [ ] `buildOutputRows` runs at most once per 32 px of width change during a
      gesture — asserted by spying on the builder while driving width changes
      through the hook, not by wall-clock timing.
- [ ] No `buildOutputRows` pass runs at an unmeasured width, and find, export,
      and output navigation still work with the output pane collapsed.
- [ ] Minimap element count for that run is bounded by rail height rather than
      by run size, and the rendered minimap is visually indistinguishable from
      today's at the same pane size.
- [ ] Exactly one bucketing helper and one split-view threshold constant exist
      across `OutputSection.tsx`, `DiffFileList.tsx`, and `diffFileRows.ts`.
- [ ] The ~7 s post-`loadWorkflow` span is attributed to named phases and
      recorded here the way the measurements above are.
- [ ] Coverage in `src/ui/webview-react/test/**` for the width bucketing (a
      sub-bucket resize does not rebuild; a bucket-crossing one does), the
      unmeasured-width gate including its collapsed-pane escape, and minimap
      quantization at a rail height smaller than the block count.
