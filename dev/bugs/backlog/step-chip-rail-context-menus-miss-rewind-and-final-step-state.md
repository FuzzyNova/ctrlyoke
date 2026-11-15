# Collapsed step chip rail's context menus miss the pending rewind and running final-step state

- **Found:** 2026-11-14 by smell-hunt final step (pass 19, claude-cli)
- **Area:** `src/ui/webview-react/components/steps/StepChipRail.tsx`
- **Severity:** low

## Symptom

The collapsed steps sidebar (`StepChipRail`) and the expanded one
(`WorkflowStepsPanel`) open the same step and final-step context menus, but the
collapsed rail gives them less state:

1. After a rewind leaves a pending continuation, right-clicking the rewound step's
   chip shows no **Discard Continuation** item. The expanded panel shows it.
   The rail also builds step capabilities (delete, move and so on) without the
   pending-rewind boundary, so those items can be enabled or disabled differently
   from the expanded panel for the same step.
2. While the final step is running, its chip's copy menu is not marked as the
   current step (`isCurrent` stays false), so the copy items use the stored
   context window instead of the live one. The expanded panel's final-step card
   marks it as current.

## Steps to Reproduce

1. Rewind a run to an earlier step so a pending continuation exists
   (`useUiStore().pendingRewind` is set, with `fromStepIndex` naming that step).
2. Collapse the steps sidebar to the chip rail.
3. Right-click step 1's chip: there is no "Discard Continuation". Expand the
   sidebar and right-click the same step: the item is there.

## Root Cause

Both components wire the same hooks by hand, and the rail's copy drifted:

- `WorkflowStepsPanel.tsx` passes `pendingRewind: pendingRewind ?? undefined`
  (from `useUiStore`) to `useStepContextMenu`. `StepChipRail.tsx` (the
  `useStepContextMenu({...})` call around line 450) never reads `pendingRewind`.
  `useStepContextMenu` uses it for `pendingRewindBoundary` in the capability
  context and for the "Discard Continuation" item.
- `WorkflowStepsPanel.tsx` passes `status: finalStepStatus` and
  `phase: finalStepPhase` to `useFinalStepContextMenu`. `StepChipRail.tsx`
  (around line 731) passes neither, so `isCurrent` in
  `useFinalStepContextMenu.tsx` is always false.

## Suggested Fix

Pass the missing options from `StepChipRail`, ideally by moving the shared wiring
into one hook that both components call (queued as the smell-hunt step "Share step
list context-menu wiring"), so the two sidebars cannot drift again. Add a test that
renders the rail with a pending rewind and asserts the menu includes "Discard
Continuation".
