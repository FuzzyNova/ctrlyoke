# Context menus expose their items as plain buttons, not a menu

- **Found:** 2026-10-19 by Claude Code while scripting the prompt editor clip (`media/shots/prompt-editor.capture.ts`)
- **Area:** `src/ui/webview-react/components/shared/StepContextMenu.tsx`
- **Severity:** low

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
