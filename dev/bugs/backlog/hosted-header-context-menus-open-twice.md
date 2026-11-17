# Header Run/Stop context menus open twice in the hosted dashboard

- **Found:** 2026-11-17 by Claude (Playwright test of the hosted dashboard, dev build)
- **Area:** `src/ui/webview-react/components/layout/Header.tsx`, `src/ui/webview-react/components/shared/ContextMenu.tsx`
- **Severity:** low

## Symptom

Right-clicking the header's first execution button (Dry Run) or **Stop** (Interrupt Turn)
in the hosted browser dashboard renders two identical `role="menu"` elements at the same
position. Each lists the item once, so the user sees one menu, but there are two menus in the
DOM and two focusable copies of each item. Seen with a single synthetic `contextmenu` event,
so it is not a double event.

## Steps to Reproduce

1. Open the hosted dashboard (dev build) on a running workflow.
2. Right-click the Stop button.
3. `document.querySelectorAll('[role=menu]').length` is 2.

## Root Cause

Not confirmed. The page has two `[aria-label="Workflow execution controls"]` groups and three
`button[aria-label="Stop"]` elements while there is a single `header.header`. A second
execution-control group (and possibly a second `Header` instance or a shared context-menu
state) is rendered elsewhere. Header's vitest coverage renders one menu, so the duplication
comes from the composed app layout.

## Suggested Fix

Find the second execution-controls group and confirm whether it is a hidden second `Header`
(for example a responsive or overlay layout). Render the controls once, or keep each
instance's context-menu state local to the button that opened it.
