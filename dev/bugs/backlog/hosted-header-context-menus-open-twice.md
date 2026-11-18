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

Confirmed by reading `Header.tsx` (2026-11-18). Not specific to the hosted dashboard; any
viewport of 1024 px or wider has it. `runControls` is one JSX element rendered in several
layout slots:

- the medium-width center lane (`hidden sm:flex … lg:hidden`) renders `{runControls}` with
  no layout guard;
- the wide lane renders `{isWideLayout && runControls}`;
- the mobile lane renders `{isMobile && runControls}`.

At lg+ the medium lane is hidden with CSS but still mounted, so two execution-control groups
exist. `runControls` also contains the `<ContextMenu>` for `runContextMenu`, and
`ContextMenu` portals to `document.body`, so both mounts render the same menu state into the
body, where neither CSS `hidden` wrapper applies. That is the second `role="menu"`.

## Suggested Fix

1. Guard the medium lane like the others: `{isMediumLayout && runControls}`. Exactly one
   execution-control group is then mounted at every width.
2. Render the header's context menus once, outside `runControls`, so a future second mount
   cannot duplicate a portal again.
3. Add a Header vitest case at the wide breakpoint asserting a single "Workflow execution
   controls" group.

[`header-control-buttons-have-context-menus.md`](header-control-buttons-have-context-menus.md)
removes the last header context menu (Dry Run), which removes this symptom, but the double
mount stays until step 1 is done. Fix both in one commit.
