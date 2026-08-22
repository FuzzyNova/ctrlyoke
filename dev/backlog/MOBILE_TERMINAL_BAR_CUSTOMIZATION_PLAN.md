# Mobile Terminal Bar Customization Plan

## Goal

Let users fully control the mobile terminal control bar: reorder the buttons shown in the bar itself, and promote/demote/hide any built-in key, built-in shortcut, or custom shortcut between the bar, the "..." popup menu, and a hidden state — instead of today's fixed bar layout plus an unsortable custom-shortcuts list.

## Current Behavior (baseline)

`TerminalControlBar.tsx` (rendered by `TerminalView.tsx` when `useMobileTerminalBar()` says to show it) hardcodes three tiers, none of them user-configurable in order or placement:

- A pinned **Ctrl** toggle button, always first (`TerminalControlBar.tsx:178-192`). Clicking it arms a one-shot ctrl-chord capture (`ctrlActive` state), it is not a "send this sequence" button like the rest.
- `PRIMARY_KEYS` (`TerminalControlBar.tsx:33-41`): Esc, Tab, ↑, ↓, ←, →, Enter — always rendered in the bar, in this fixed order.
- A **"..."** (More) button that opens a popup menu containing, in this fixed order: `BUILT_IN_SHORTCUTS` (`TerminalControlBar.tsx:24-31`: Shift+Tab, Ctrl+C, Ctrl+Z, Ctrl+L, Ctrl+R, Ctrl+A) followed by `terminal.mobileCustomShortcuts` from settings, followed by an "Add shortcuts..." link into settings.

`TerminalSection.tsx`'s "Mobile Control Bar" section (`TerminalSection.tsx:643-766`) only lets users pick overall bar visibility (`terminal.mobileControlBar`: auto/always/never, via `useMobileTerminalBar.ts`) and add/edit/remove entries in `terminal.mobileCustomShortcuts` (`{ label, sequence }[]`, no stable id, no ordering relative to the built-ins, always lands in the popup). There is no way to reorder the bar, move a built-in into the popup, promote a popup item into the bar, or hide an item without deleting it.

`StatusLineFormatEditor.tsx` already solves the adjacent problem (reorderable, includable/excludable closed-vocabulary segments) with `@dnd-kit/core` + `@dnd-kit/sortable`, `verticalListSortingStrategy`, a `SortableSegmentRow`, and an "Available fields" pool below the sortable list for items not currently included. This plan reuses that pattern, adapted to a horizontal bar and a three-way placement (bar / popup / hidden) instead of a two-way include/exclude.

## Decisions

### Unify built-ins and custom shortcuts behind one registry + closed vocabulary

Today `PRIMARY_KEYS` and `BUILT_IN_SHORTCUTS` are two separate hardcoded arrays with no ids, and custom shortcuts are a third, differently-shaped list. Introduce one registry, mirroring `STATUS_LINE_FIELD_REGISTRY` in `src/utils/StatuslineFormat.ts`, in a new `src/utils/TerminalControlBarFormat.ts`:

- `TERMINAL_BAR_KEY_IDS` / `TERMINAL_BAR_SHORTCUT_IDS`: closed-vocabulary string ids for the 7 primary keys (`key:esc`, `key:tab`, `key:up`, `key:down`, `key:left`, `key:right`, `key:enter`) and the 6 built-in shortcuts (`shortcut:shift-tab`, `shortcut:ctrl-c`, `shortcut:ctrl-z`, `shortcut:ctrl-l`, `shortcut:ctrl-r`, `shortcut:ctrl-a`).
- `TERMINAL_BAR_ITEM_REGISTRY`: id → `{ label, glyph?, sequence, description? }`, single-sourcing what's currently split between `TerminalControlBar.tsx`'s two arrays and its inline glyph-swap ternary (`TerminalControlBar.tsx:203-213`).

Custom shortcuts remain user data (`TerminalSettings.mobileCustomShortcuts`), not registry entries, but gain a stable `id` (see below) so they can be referenced from the same placement lists as built-ins.

The Ctrl modifier button gets its own constant, `TERMINAL_BAR_CTRL_ID` (e.g. `modifier:ctrl`), exported alongside the registry but *not* part of `TERMINAL_BAR_ITEM_REGISTRY`'s key/shortcut entries — it has no `sequence` and a different click behavior (arms `ctrlActive` rather than sending a fixed sequence), so it doesn't fit the `{ label, sequence }` shape the rest of the registry shares. See the Ctrl decision below for the placement rules specific to this id.

### Three-list placement model, not a single list with a placement field

Add one new setting, `terminal.mobileBarLayout`:

```typescript
export interface TerminalMobileBarLayout {
  bar: string[]; // ordered ids shown in the control bar
  popup: string[]; // ordered ids shown in the "..." menu
  hidden: string[]; // ids shown nowhere
}
```

Three parallel ordered arrays (rather than one flat list with a per-item `placement` field) because:

- Reordering within the bar (drag-and-drop) is then a plain `arrayMove` on `bar`, identical to `StatusLineFormatEditor`'s existing pattern — no need to filter/re-merge a mixed list on every drag.
- Promote/demote/hide become "move this id from one array to another, appended at the end," which is simple to implement and simple to reason about (no ordering ambiguity about where a promoted item should land in a merged list).
- Schema/validation stays simple: three arrays of known ids.

Default value reproduces exactly today's hardcoded layout — including `TERMINAL_BAR_CTRL_ID` pinned first in `bar`, matching its current always-first rendering and the "insert at front of bar" fallback in the Defensive/Edge-Case Handling section below:

```typescript
bar: ["modifier:ctrl", "key:esc", "key:tab", "key:up", "key:down", "key:left", "key:right", "key:enter"],
popup: ["shortcut:shift-tab", "shortcut:ctrl-c", "shortcut:ctrl-z", "shortcut:ctrl-l", "shortcut:ctrl-r", "shortcut:ctrl-a"],
hidden: [],
```

Existing/new custom shortcut ids are appended to `popup` at creation time, matching current behavior (custom shortcuts have only ever appeared in the popup).

### The Ctrl toggle is bar-resident and hide-only — sortable, but never demotes to the popup list

The Ctrl button isn't a "send this sequence" item like the rest — it arms `ctrlActive` and changes how the *next* keypress or button tap behaves. That makes it structurally different from every other bar item, but it's still a real button occupying real space in the bar, and the user should be able to reposition or hide it like anything else.

Rule: `TERMINAL_BAR_CTRL_ID` may only ever be a member of `bar` or `hidden` — it can never be added to `popup`. Concretely:

- While in `bar`, its chip in the horizontal bar editor is fully draggable like any other bar item, so users can reposition it.
- Its chip's bottom control is a **hide** button, not the delete/demote button every other bar chip gets — clicking it moves `TERMINAL_BAR_CTRL_ID` straight to `hidden` (skipping `popup` entirely). It carries a tooltip explaining why: "Modifier key — must be in the bar to be shown; hide it here instead of moving it to the shortcut list."
- To restore it, it appears in the same "hidden" pool at the bottom of the vertical popup-list editor as any other hidden item (see below), rendered the same grayed-out way — but its restore button appends it back to the end of `bar`, never to `popup`. The pool doesn't need to record where a hidden id came from as separate metadata: the restore handler just special-cases `TERMINAL_BAR_CTRL_ID` to target `bar` instead of `popup`.
- `TerminalControlBarEditor.tsx` must reject (or the reconciliation pass below must correct) any state where `TERMINAL_BAR_CTRL_ID` ends up in `popup` — e.g. from hand-edited settings.json.

### Built-ins (including Ctrl) can be hidden but never deleted; custom shortcuts can also be permanently deleted

`hidden` is a placement, not a deletion, for built-in keys/shortcuts and the Ctrl id — they're closed vocabulary and always addressable again via the hidden pool at the bottom of the vertical popup-list editor. Custom shortcuts additionally keep today's permanent-delete affordance (the trash icon in `TerminalSection.tsx:740-756`), which removes the `TerminalShortcut` from `mobileCustomShortcuts` *and* removes its id from whichever of `bar` / `popup` / `hidden` currently contains it.

### Both the bar and the popup list are drag-sortable

The bar is a horizontal sortable row (drag handle top, delete/demote bottom), matching the original ask. The popup list is *also* drag-sortable, using a plain vertical sortable list — directly reusing `StatusLineFormatEditor`'s existing pattern (`verticalListSortingStrategy`, y-only transform restriction) rather than inventing a new layout. In the settings page this list is not rendered as an actual popup/dropdown — it's just a vertical list of shortcut rows, always visible in the editor. This only changes how the *settings editor* presents these items; `TerminalControlBar.tsx`'s runtime "..." menu is still a real dropdown popup, just rendered in the user-defined `popup` order instead of a fixed one.

This also gives removing an item from the bar an obvious destination: demoting a bar item moves its id to the end of `popup`, so it immediately reappears as a row in the vertical list, where it can be reordered, promoted back to the bar, or hidden.

Below the sortable `popup` rows, the same vertical list renders a **hidden pool** — every id currently in `hidden` (built-ins, custom shortcuts, and the Ctrl id when hidden), grayed out, one per row, each with a single restore control. This directly mirrors `StatusLineFormatEditor`'s "Available fields" section below its sortable list. The pool is a flat, unordered list (order among hidden items is never rendered anywhere, so it doesn't need to be preserved) — no drag-and-drop inside it. Restoring a row appends its id to the end of `popup`, except for the Ctrl id, which appends to the end of `bar` (see the Ctrl decision above). There is no bulk "unhide all" action — items are restored one at a time, matching the expected item count (~13 built-ins plus a handful of custom shortcuts).

New items promoted from `popup` to `bar` always append to the end of `bar`, regardless of where they sat in `popup` — the user can then drag them into position. Promotion never tries to preserve or infer an insertion index.

### "Reset to default" restores built-in placement/order, not custom shortcuts

`StatusLineFormatEditor`'s reset (`StatusLineFormatEditor.tsx:347-358`) fully replaces the segment list because statusline segments are trivial to re-add. Custom terminal shortcuts are user-authored data (captured key sequences, typed labels) that are comparatively expensive to reconstruct. "Reset to default" on the bar editor resets only the built-in ids' distribution across `bar` / `popup` / `hidden` back to the default arrangement above, and re-appends any existing custom shortcut ids to the end of `popup` (i.e. equivalent to "un-hide and un-promote everything, but keep my custom shortcuts").

### Stable ids

Add `id: string` to `TerminalShortcut` (`CtrlYokeTypes.ts` / `CtrlYokeSettings.ts`). Generate new ids with the existing `generateId()` in `src/ui/webview-react/utils/string.ts` (prefers `crypto.randomUUID()`, already has an older-webview fallback) rather than writing a second id generator — do not reuse `StatusLineFormatEditor`'s per-session `nextId()` counter pattern, since that counter isn't stable across reloads and these ids must persist in settings.json to be referenced from `mobileBarLayout`.

Existing settings files predating this feature may have `mobileCustomShortcuts` entries without an `id`. Since the project has no backward-compatibility constraint pre-release, don't build a migration system — normalize defensively wherever the list is read for editing (assign a fresh id to any entry missing one, same idea as the unknown-id reconciliation below).

## Settings / Schema Changes

- `src/types/CtrlYokeSettings.ts`:
  - `TerminalShortcut` gains `id: string`.
  - `TerminalSettings` gains `mobileBarLayout: TerminalMobileBarLayout`.
  - Default settings object (`DEFAULT_...`, around `CtrlYokeSettings.ts:431-443`) gains the default `mobileBarLayout` above.
- `schemas/settings-schema.json`: under `terminal` (`settings-schema.json:564-632`), add `mobileBarLayout` (object of three string arrays) and add `id` (string, required) to `mobileCustomShortcuts.items.properties`.
- `src/utils/TerminalControlBarFormat.ts` (new): id constants (including `TERMINAL_BAR_CTRL_ID`) + registry + `DEFAULT_TERMINAL_BAR_LAYOUT` constant, single-sourced for both the settings editor and `TerminalControlBar.tsx`.

No new schema fields are needed to express the Ctrl rule — it's a business rule enforced in code (editor UI never offers "move to popup" for `TERMINAL_BAR_CTRL_ID`; the reconciliation pass below corrects any state that violates it), not a new column in `mobileBarLayout`.

No changes needed to the generic settings write path — `TerminalSection.tsx` already writes arbitrary setting paths through `onUpdate(path, value)` / `onReset(path)` with scope resolution (`SettingWriteScope`); the new editor reuses that same prop contract.

## Affected Components

| Component | Change |
| --- | --- |
| `src/utils/TerminalControlBarFormat.ts` (new) | Registry of built-in key/shortcut ids → label/sequence, plus `DEFAULT_TERMINAL_BAR_LAYOUT`. Single source for both settings UI and runtime rendering. |
| `src/types/CtrlYokeSettings.ts` | Add `TerminalShortcut.id`, `TerminalSettings.mobileBarLayout`, default layout value. |
| `schemas/settings-schema.json` | Add `mobileBarLayout` schema under `terminal`; add `id` to `mobileCustomShortcuts` items. |
| `src/ui/webview-react/components/settings/TerminalControlBarEditor.tsx` (new) | Two dnd-kit sections: a horizontal sortable bar row (drag handle top, delete/demote bottom — except the Ctrl chip, which gets a hide button + tooltip instead of delete, per the Ctrl decision above) mirroring `SortableSegmentRow`; and a vertical sortable list for `popup` (drag to reorder, promote to bar, hide) with a grayed hidden-pool section below it (one restore button per hidden id, no bulk unhide) mirroring `StatusLineFormatEditor`'s "Available fields" pool. Also hosts the existing "add custom shortcut" label+`KeyCaptureInput` form, appending new shortcuts to `popup`. |
| `src/ui/webview-react/components/settings/TerminalSection.tsx` | "Mobile Control Bar" section (`TerminalSection.tsx:643-766`) keeps the visibility `CustomSelect` and delegates the shortcuts UI to `TerminalControlBarEditor`. Extract `KeyCaptureInput`, `keyEventToCapture`, `sequenceToHumanLabel`, `updateShortcut` (`TerminalSection.tsx:118-414`) out of this file since the new editor becomes their primary consumer — move them into `TerminalControlBarEditor.tsx` or a shared helper module. |
| `src/ui/webview-react/components/output/TerminalControlBar.tsx` | Replace hardcoded `PRIMARY_KEYS`/`BUILT_IN_SHORTCUTS` arrays with resolution against `TERMINAL_BAR_ITEM_REGISTRY` + `terminal.mobileBarLayout.bar` / `.popup`, filtering out unresolvable ids defensively. Hide the "..." button entirely when the resolved popup list is empty (today it's never empty, since `BUILT_IN_SHORTCUTS` is hardcoded and non-empty). |
| `src/ui/webview-react/hooks/useMobileTerminalBar.ts` | No change. It only gates whether the whole bar renders (`auto`/`always`/`never`), not per-item placement — that filtering lives entirely in `TerminalControlBar.tsx`. |
| `src/ui/webview-react/components/output/TerminalView.tsx` | No change. It only mounts `TerminalControlBar` when `showControlBar` is true (`TerminalView.tsx:308-312, 385-390`); item-level content is `TerminalControlBar`'s concern. |

## Defensive / Edge-Case Handling

- **Unknown ids**: an id present in `mobileBarLayout` that doesn't resolve in the registry or in current `mobileCustomShortcuts` (stale data, a future release renaming/removing a built-in id) must be skipped when rendering the bar/popup and skipped (or flagged) in the editor — never crash.
- **Missing ids**: a known id (registry entry or existing custom shortcut) absent from all three of `bar`/`popup`/`hidden` (e.g. a custom shortcut created before this feature shipped, or a new built-in id added in a later release) should be treated as implicitly `popup` and reconciled into `popup` the first time the layout is read for editing — mirrors how `StatusLineFormatEditor` surfaces not-yet-included fields rather than silently dropping them.
- **Empty popup**: `TerminalControlBar.tsx` must hide the "..." button when the resolved popup list is empty, since a user can now demote every built-in popup item into the bar or hidden.
- **Deleting a custom shortcut**: must remove its id from whichever of `bar`/`popup`/`hidden` currently holds it, not just from `mobileCustomShortcuts`.
- **`TERMINAL_BAR_CTRL_ID` in `popup`**: only reachable via hand-edited settings.json, since the editor never offers that move. The reconciliation pass must move it to `bar` (append) if found there.
- **`TERMINAL_BAR_CTRL_ID` missing from both `bar` and `hidden`**: treat as implicitly hidden-that-was-never-set-up and insert it at the front of `bar`, matching the default layout's position, rather than silently losing the button.

## Implementation Steps

Status: Step 1 landed in `src/utils/TerminalControlBarFormat.ts`; settings plumbing and schema fields are included.

1. **Registry module**: add `src/utils/TerminalControlBarFormat.ts` with the id constants, `TERMINAL_BAR_ITEM_REGISTRY`, and `DEFAULT_TERMINAL_BAR_LAYOUT`.
2. **Settings plumbing**: add `TerminalShortcut.id`, `TerminalSettings.mobileBarLayout`, defaults, and the schema entries. Update `DEFAULT_STATE`-style fixtures/tests that construct full `TerminalSettings` objects.
3. **Runtime rendering**: update `TerminalControlBar.tsx` to resolve `bar`/`popup` ids through the registry + `mobileCustomShortcuts`. The Ctrl button is no longer hardcoded first — render it at its resolved position within `mobileBarLayout.bar` (per the Ctrl decision above, it's a sortable bar member, not a pinned leading element). Hide "..." when popup resolves empty, decode custom-shortcut sequences as today.
4. **Settings editor**: build `TerminalControlBarEditor.tsx` with two `DndContext`/`SortableContext` pairs — horizontal (`horizontalListSortingStrategy`, x-only transform restriction) for `bar`, with the Ctrl chip's demote button replaced by a hide button + tooltip; vertical (`verticalListSortingStrategy`, y-only transform restriction, matching `StatusLineFormatEditor.tsx:271-274`) for `popup`, with per-row promote-to-bar and hide controls, plus the relocated custom-shortcut add form appending to `popup`. Below the vertical list, render the flat, non-sortable hidden pool (grayed rows, one restore button each, no bulk unhide; Ctrl's restore targets `bar`, everything else targets `popup`). Add a "Reset to default" action per the Decisions section above.
5. **Wire into `TerminalSection.tsx`**: replace the current shortcuts UI block (`TerminalSection.tsx:671-765`) with `<TerminalControlBarEditor ... />`, keep the control-bar-visibility `SettingInputRow`/`CustomSelect` above it unchanged.
6. **Tests**: extend `src/ui/webview-react/test/**` coverage for `TerminalControlBar.tsx` (renders configured bar order, hides "..." when popup empty, ignores unknown ids) and add new tests for `TerminalControlBarEditor.tsx` (drag reorder in both the bar and the popup list, promote, hide/restore including the Ctrl-specific restore-to-bar path, permanent delete, reset-to-default preserves custom shortcuts, `TERMINAL_BAR_CTRL_ID` never offered a "move to popup" control). Follow `.github/instructions/webview-react-components.instructions.md` for component-vs-hook boundaries.

## Non-Goals

- A bulk "unhide all" action — hidden items are restored one row at a time from the hidden pool.
- Inserting a promoted/restored item at a specific bar or popup position — promotion and restoration always append to the end of the destination list; repositioning afterward is a drag.
- Per-workspace or per-harness bar layouts — this is one global `terminal.mobileBarLayout`, same scope as the rest of `TerminalSettings`.
- Changing what `useMobileTerminalBar.ts` gates (whole-bar auto/always/never visibility is unrelated to per-item placement and is out of scope here).
- Icon/glyph customization for custom shortcuts — they keep rendering as text labels, matching today.
