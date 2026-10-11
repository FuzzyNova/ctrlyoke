# Right-click Dry Run on the header Run button does nothing while the button is disabled

- **Found:** 2026-10-11 by Claude while writing `docs/guide/dry-run.md`
- **Area:** `src/ui/webview-react/components/layout/Header.tsx`
- **Severity:** low

## Symptom

Right-clicking (or long-pressing) the header's first run button opens a **Dry Run** menu. While
that button is disabled, for example during a run, on a run owned by the CLI or another window,
or while external-roots approval is pending, right-click shows the browser's default menu or
nothing at all. The Dry Run entry point silently disappears. The header's separate **Dry Run**
button still works, so there is a workaround.

## Steps to Reproduce

1. Start any workflow so the header's first button (Run / Re-run) becomes disabled.
2. Right-click that button.
3. No Dry Run menu opens.

## Root Cause

`onContextMenu` and `runSlotLongPressHandlers` are attached to the `<button>` itself
(`Header.tsx:543-547`), and the same element gets `disabled={!slot1.enabled || …}`
(`:548-553`). Browsers don't dispatch mouse or pointer events, `contextmenu` included, to a
disabled form control, so neither handler runs.

## Suggested Fix

Either make the behaviour explicit (dry-run preview is only offered from the Run button when it
can run, and `docs/guide/dry-run.md` says so), or move the context-menu and long-press handlers
to a wrapper element around the button so they fire whatever its state, and add a test that
right-clicks a disabled Run button.
