# Header Run and Stop buttons hide actions behind right-click and long press

- **Found:** 2026-11-17 by Nathan (design review while planning End Step Early)
- **Area:** `src/ui/webview-react/components/layout/Header.tsx`
- **Resolution:** fixed in this commit

## Symptom

The header's workflow control buttons double as context-menu anchors:

- Right-clicking or long-pressing **Run** / **Re-run** (slot 1) opens a menu with
  **Dry Run**.
- Right-clicking or long-pressing **Stop** (slot 3) opens a menu with **Interrupt Turn**.

Getting to the menu means aiming a secondary gesture at a button whose primary action is
consequential. A slightly short long press, or a left click instead of a right click, starts
a run or stops every active step. Users avoid the menus for this reason. Dry Run is already
on the workflow context menu (`useWorkflowContextMenu`), which carries no such risk. The Stop
button needs an 800 ms guard (`stopMenuOpenedAtRef`) just so a long press that opened the menu
doesn't also stop the workflow when the finger lifts. Needing that guard shows the design is
fighting itself.

## Root Cause

Design choice: Dry Run (released) and Interrupt Turn (unreleased) were attached to the
nearest related button instead of to the object they act on. Dry Run acts on the workflow,
and Interrupt Turn acts on one step.

**Status:** the Stop half is done (Interrupt Turn moved to End Step Early on the step menu,
and Stop has no context menu). The Run button's Dry Run menu remains. Fix it together with
[`hosted-header-context-menus-open-twice.md`](hosted-header-context-menus-open-twice.md),
whose root cause is a second mount of the same run controls in this file.

## Suggested Fix

The header control buttons get no context menus. Each action lives on the context menu of
what it acts on.

- **Dry Run** stays on the workflow context menu (header workflow name and list rows,
  `useWorkflowContextMenu`) and on each step's **Dry Run Step**. Remove `openRunDryRunMenu`,
  its `onContextMenu` and `runSlotLongPressHandlers` from slot 1.
- **Interrupt Turn** becomes **End Step Early** on the running step's context menu
  (`useStepContextMenu`). The plan is in
  [`parallel-headless-steer-always-targets-lowest-step.md`](../implemented/parallel-headless-steer-always-targets-lowest-step.md).
  Remove `openStopInterruptMenu`, its `onContextMenu`, `stopSlotLongPressHandlers` and the
  `stopMenuOpenedAtRef` click guard from slot 3.
- Let a right click on the control buttons fall through to the default behavior (no menu)
  rather than opening an empty ctrlyoke menu.
- **No per-step stop button on the running step row.** An always-visible icon on the step
  that does End Step Early has the same misclick risk this bug is removing, adds clutter to
  every running row, and would sit next to a header Stop that does something much bigger.
  The context menu is enough. Reconsider only if users can't find End Step Early.
- Docs: update `docs/guide/dashboard.md` (the "Right-click (or long-press) the first button"
  paragraph) and the Dry Run entry-point table in `docs/guide/dry-run.md`. Record the removal
  of Dry Run from the Run button under **Changed** in `CHANGELOG.md`, because it shipped in
  0.7.x.
- Tests: drop the header context-menu cases. Add step-menu cases for End Step Early: shown
  only on a running step, enabled only with an interruptible target, and sends
  `INTERRUPT_HEADLESS_TURN` with that step's control session id.
