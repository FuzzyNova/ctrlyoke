# Context menus expose their items as plain buttons, not a menu

- **Found:** 2026-10-19 by Claude Code while scripting the prompt editor clip (`media/shots/prompt-editor.capture.ts`)
- **Area:** `src/ui/webview-react/components/shared/StepContextMenu.tsx`
- **Resolution:** fixed in this commit

## Symptom

Every right-click menu built on `StepContextMenu` (step list, workflow list, output pane,
workspace viewer editor and Explorer, commit history) renders as a `role="presentation"` `<div>`
of plain `<button>`s. Screen readers announce a run of unrelated buttons rather than a menu, and
there is no arrow-key navigation between items: focus stays wherever it was when the menu opened.

## Steps to Reproduce

1. Open a file in the workspace viewer and right-click in the editor.
2. Inspect the accessibility tree: the items ("Cut", "Copy", "Add Selection to ctrlyoke", ...)
   are `button`s whose nearest ancestor with a role is the document.
3. Press ArrowDown: nothing moves.

## Root Cause

`StepContextMenu` sets `role="presentation"` on the container and gives the items no role, so
they keep the implicit `button` role. It never moves focus into the menu.

## Suggested Fix

Follow the WAI-ARIA menu pattern: `role="menu"` with an `aria-label` on the container,
`role="menuitem"` on items, focus the first enabled item on open, ArrowUp/ArrowDown/Home/End to
move, Escape to close and return focus to the invoker. About 20 Vitest files and
`media/shots/prompt-editor.capture.ts` query these items with `getByRole("button", ...)` and
need to switch to `menuitem`.

## Fix

`StepContextMenu` is now a `role="menu"` (named by an optional `label`, "Context menu" by
default) of `role="menuitem"` buttons with `tabIndex={-1}`. Once the menu is measured and
visible it focuses the first enabled item. ArrowUp/ArrowDown wrap through enabled items,
Home/End jump to the ends, and Escape or Tab closes it. Escape, Tab and choosing an item
return focus to the element that held it when the menu opened, _before_ the item's action
runs. The workspace editor's Cut runs `execCommand("cut")`, which needs CodeMirror focused
again. The Vitest queries and `media/shots/prompt-editor.capture.ts` now use `menuitem`.
