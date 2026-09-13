# Output Scroll Target Persistence Plan

## Overview

The Output panel's virtualized row list (`OutputSection.tsx`) currently fights to keep
the user's view stable across layout perturbations — horizontal panel drags, row
remeasurement bursts, scroll-seek restores — using an ephemeral **viewport anchor
guard** (`viewportAnchorGuardRef`: activate → refresh → expire/clear → restore). This
plan proposes replacing that reactive, perturbation-specific machinery with a single
**persistent scroll target**: a small piece of state describing _what the user is
looking at_, which only changes on explicit triggers (user scroll, new-output
autoscroll, programmatic step navigation) and is otherwise just continuously
re-resolved to a `scrollTop` as layout shifts underneath it.

As a side effect, because the target is a stable, named thing rather than a
recomputed-per-resize artifact, it becomes natural to persist it **per workflow** —
giving us "remember my scroll position when I switch away and back" for free.

---

## Current Behavior & Why It's Fragile

`OutputSection` tracks an `ActiveViewportRowAnchor` in `viewportAnchorGuardRef`:

- **`activateViewportAnchorGuard`** captures `{ rowKey, offsetTop, rowOffsetPx,
viewportOffsetTop, reason, expiresAt }` from the current DOM via
  `captureViewportRowAnchor()` (line ~280) whenever a disruptive event starts
  (width-change, measurement-flush, scroll-seek-restore — see the `reason` union).
- **`refreshViewportAnchorGuard`** extends the TTL (`expiresAt`, currently
  `OUTPUT_SCROLL_SEEK_INTERMEDIATE_OVERSCAN_DELAY_MS + OUTPUT_SCROLL_SEEK_FULL_OVERSCAN_DELAY_MS
  - 800` ≈ 3200ms) on the _same_ anchor while the disruption continues.
- **`restoreViewportAnchorGuard`** (3 call sites: `shouldAdjustScrollPositionOnItemSizeChange`,
  a `useLayoutEffect`, and the `updateDiffViewType` ResizeObserver callback) tries to
  pin `scrollTop` so the anchor row stays at `viewportOffsetTop`, using either
  `getBoundingClientRect()` (DOM-rect mode) or TanStack's `measurementsCache`/`delta`
  (delta-anchor mode).
- **`clearViewportAnchorGuard`** drops it on expiry or terminal events.

This has produced (and keeps producing) an entire class of bugs, two of which were
just fixed in this session:

1. **Racing correctors**: multiple `restoreViewportAnchorGuard` call sites firing
   concurrently during a horizontal drag, each reading `getBoundingClientRect()`
   mid-burst (TanStack hasn't re-laid-out yet), each "correcting" against the other's
   just-applied correction → visible oscillation/jumps (commit 3de5776 + this
   session's `isHorizontalResizeCompensationActive` fixes).
2. **TTL-expiry re-anchor**: if the user pauses mid-drag for >3.2s, the guard expires,
   `refreshViewportAnchorGuard` returns `false`, and a **brand new anchor on a
   different row** gets captured (`updateDiffViewType` line ~1866-1871) — discontinuous
   with what the user was actually tracking, producing a jump _in the middle of a
   continuous interaction_.
3. **No persistence**: `OutputSection` is not keyed/remounted per workflow (rendered
   at `App.tsx:519/593/851`), so switching the viewed workflow just re-renders with a
   different `rows` array — there is no concept of "where was I in workflow A" to
   restore when you switch back to it.
4. **Coverage gaps**: `horizontalPanelResizeActive` is only set by
   `react-resizable-panels` drag events (`Group.onLayoutChange`/`onLayoutChanged`,
   `Separator.onPointerDown` — `App.tsx:744-752,789,915`). An OS/window-level resize
   reaches `OutputSection` only via the `ResizeObserver` in `updateDiffViewType` and is
   _not_ covered by `isHorizontalResizeCompensationActive()` — so window resizes can
   still hit the racing-correctors problem via a different path.

The root issue: the anchor is modeled as a **rescue mechanism that must be
recreated and defended for the duration of each disruption**, rather than as a
**standing description of user intent** that disruptions merely need to respect.

---

## Proposed Model: Persistent Scroll Target

Replace the anchor guard with a single piece of state — the **scroll target** —
that answers "what should be visible, and where":

```typescript
type OutputScrollTarget =
  | { kind: "row"; rowKey: string; viewportOffsetPx: number }
  | { kind: "bottom" };
```

- `{ kind: "row", ... }` — pin a specific row at a specific pixel offset from the
  top of the viewport (mirrors today's `anchorViewportOffsetTop` semantics, minus
  the TTL/reason/expiry baggage).
- `{ kind: "bottom" }` — the "follow the tail" mode that today is `autoscrollEnabled`.

**The target changes ONLY when:**

1. **The user scrolls** — capture the new target (debounced until the scroll
   gesture settles, mirroring the existing `lastScrollEventAtRef` /
   `OUTPUT_USER_SCROLL_INPUT_GRACE_MS` machinery) as `{ kind: "row", ... }`, or
   `{ kind: "bottom" }` if they land within some threshold of the bottom.
2. **New output arrives while already at the bottom** — target stays/becomes
   `{ kind: "bottom" }` (this is today's `autoscrollEnabled`/`autoScroll FIRING` path
   — see `[cy-SCROLL-DEBUG] autoScroll FIRING` log entries).
3. **Programmatic navigation** — clicking a step in the minimap
   (`handleMinimapStepClick` → `onStepClick`, line ~3629/4152) or any other
   "jump to X" action sets `{ kind: "row", rowKey: <first row of step X>,
viewportOffsetPx: <some sensible default, e.g. near top> }`.

**Everything else — width changes, row remeasurement, scroll-seek
mount/unmount cycles, overscan changes — does NOT touch the target.** It only
triggers a _recomputation_ of `scrollTop` from the existing target against the
current layout. This is the key inversion: today, disruptions _create and chase_
anchors; in the new model, disruptions _read_ a stable target and adjust `scrollTop`
to match it — there is nothing to race against because there is exactly one
function that ever writes `scrollTop` for "stay where I was" purposes.

---

## Implementation Sketch

### 1. Define the target type and a single resolver

```typescript
function resolveScrollTopForTarget(
  target: OutputScrollTarget,
  ctx: { rowLayout; measurementsCache; scrollElement; rows }
): number | null;
```

For `{ kind: "row" }`: look up the row's current `start` (prefer
`measurementsCache`, fall back to `rowLayout.rowStartsByKey` — reusing the exact
lookup-with-fallback logic already in `shouldAdjustScrollPositionOnItemSizeChange`,
lines ~1579-1590) and compute `start - viewportOffsetPx`.
For `{ kind: "bottom" }`: `rowLayout.totalSize - clientHeight`.

This single function subsumes what `restoreViewportAnchorGuard`'s delta-anchor mode
and DOM-rect mode both currently try to do, minus the DOM-rect timing-gap problem
entirely (we never read `getBoundingClientRect()` for correction purposes — only
TanStack's internal measurement state, which is always self-consistent).

### 2. One write path for "stay in place"

Replace the three `restoreViewportAnchorGuard` call sites
(`shouldAdjustScrollPositionOnItemSizeChange` line ~1547,
the `useLayoutEffect` line ~1480, and `updateDiffViewType` line ~1872) with calls
into the same `applyScrollTarget()` helper that calls `resolveScrollTopForTarget`
and sets `scrollElement.scrollTop` if it differs from the current value beyond a
small epsilon. Because there's one function and one target, there is no
"which corrector wins" question — call it as often as needed; it's idempotent.

### 3. Target-update triggers

- **User scroll**: extend the existing scroll-event handling (`lastScrollEventAtRef`,
  `hasRecentScrollEvent`) to, once a scroll gesture settles, call
  `captureViewportRowAnchor()` (already exists, line ~280) and store the result as
  the new target (or `{ kind: "bottom" }` if `atBottom`).
- **Autoscroll**: where `autoscrollEnabled.current` is currently flipped (search
  `autoScroll FIRING` / `autoscrollEnabled changed` logs around line ~2098-2109,
  ~2522), set the target to `{ kind: "bottom" }` instead of/in addition to the ref.
- **Programmatic nav**: in the `scrollToIndex` paths (lines ~2453, ~2485, ~2523,
  ~2706) and `handleMinimapStepClick`, set the target directly rather than relying
  on a post-hoc anchor capture.

### 4. Per-workflow persistence

- Add a slice to `uiStore` (or a `Map<workflowId, OutputScrollTarget>` ref scoped to
  `OutputSection`, if we want to avoid global store churn): `outputScrollTargets:
Record<workflowId, OutputScrollTarget>`.
- On target change, write `outputScrollTargets[currentWorkflowId] = target`.
- On `activeWorkflowId`/viewed-workflow change (the value read at `App.tsx` /
  `setViewedWorkflowId` per the session log's `[setViewedWorkflowId]` entries),
  read `outputScrollTargets[newWorkflowId] ?? { kind: "bottom" }` and apply it once
  the new workflow's rows have measured.
- This is **in-memory only** for v1, per the user's explicit "don't need to persist
  to local storage yet" — it survives workflow switches within a session but not
  extension restarts.

### 5. Remove the old machinery

Once the new path is verified to handle every scenario the anchor guard handled
(width-change, measurement-flush, scroll-seek-restore — the three `reason` values),
delete: `viewportAnchorGuardRef`, `activateViewportAnchorGuard`,
`refreshViewportAnchorGuard`, `clearViewportAnchorGuard`, `restoreViewportAnchorGuard`,
`ActiveViewportRowAnchor`/`ViewportRowAnchor` guard-specific fields (`expiresAt`,
`reason`, `restoreCount`), `isHorizontalResizeCompensationActive`,
`horizontalResizeSettleUntilRef`, `previousHorizontalPanelResizeActiveRef`, and the
`OUTPUT_SCROLL_SEEK_*_DELAY_MS` / `OUTPUT_HORIZONTAL_RESIZE_SETTLE_MS` TTL constants
that exist solely to bound the guard's lifetime.

---

## Affected Components

| File                                                       | Change                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Major rewrite of the scroll-stability subsystem (anchor guard → target resolver)                                    |
| `src/ui/webview-react/store/uiStore.ts`                    | New `outputScrollTargets` state slice + setter                                                                      |
| `src/ui/webview-react/App.tsx`                             | Possibly: hook target restore into `setViewedWorkflowId`/workflow-switch flow if not handled inside `OutputSection` |

---

## Migration Strategy

Do **not** do a big-bang rewrite — the anchor guard has accreted handling for many
hard-won edge cases (scroll-seek placeholder restore, measurement-flush bursts,
fast-scroll suppression). Recommended path:

1. Build `resolveScrollTopForTarget` + `applyScrollTarget` alongside the existing
   guard, behind a flag or in a way that can run in parallel without writing
   `scrollTop` (log-only "shadow mode") to compare its output against the current
   system's corrections across all three `reason` scenarios.
2. Once shadow-mode output matches (or improves on) the current behavior for
   width-change, measurement-flush, and scroll-seek-restore, flip the write path
   over to the new resolver and stop calling `restoreViewportAnchorGuard`.
3. Wire up target-update triggers (user scroll / autoscroll / programmatic nav)
   and per-workflow persistence.
4. Delete the old machinery (step 5 above) once nothing references it.
5. Manually verify via `/verify`: horizontal drag (slow + fast, with pauses),
   window resize, new-output autoscroll, step-click navigation, and
   switch-away/switch-back scroll memory — across both running and historical
   (completed) workflows.

---

## Edge Cases & Open Questions

- **Target row pruned from history** (output truncation / replay window changes):
  need a fallback — e.g., walk to the nearest still-present row, or fall back to
  `{ kind: "bottom" }`.
- **Workflow re-run replaces rows**: row keys are
  `queue:<idx>:run<run>:attempt<attempt>:event:<n>` — a re-run changes the `run`
  segment, so a saved target from a prior run will not resolve. Decide whether to
  invalidate the saved target on re-run, or translate it (e.g., by step index +
  relative offset) to the new run's equivalent row.
- **"User scroll" debounce threshold**: how long to wait after the last scroll
  event before committing it as the new persisted target, so we don't thrash on
  momentum-scroll/wheel jitter? (The existing `OUTPUT_USER_SCROLL_INPUT_GRACE_MS`
  is a reasonable starting point but was tuned for a different purpose.)
- **Window-resize coverage gap**: while migrating, also fold OS-level window
  resizes into whatever signal gates "don't fight the target right now" — today
  `horizontalPanelResizeActive` doesn't cover them (see Current Behavior #4).
- **First-ever view of a workflow** (no saved target): default to `{ kind: "bottom" }`
  for running workflows, and arguably also for historical/completed ones unless we
  later decide a "resume where the last session left off" default is more useful.

---

## Non-Goals (v1)

- Persisting scroll targets to `localStorage` / disk — explicitly deferred; this is
  in-memory, per-session state only.
- Surfacing the scroll target/position in the UI (e.g., a "jump back to where you
  were" affordance) — purely an internal stability + memory mechanism for now.
