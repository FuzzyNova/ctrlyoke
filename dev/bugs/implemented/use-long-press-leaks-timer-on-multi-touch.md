# useLongPress leaks the first timer on a second touchstart, firing the context menu after a multi-touch gesture

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/hooks/useLongPress.ts`
- **Resolution:** fixed in this commit

## Decision

Every touchstart cancels the prior gesture, and multi-touch starts do not arm
a new timer. Unmount cleanup clears any remaining timer.

## Symptom

On a touch device, a two-finger gesture (pinch-zoom or two-finger scroll) that starts on an element using `useLongPress` opens that element's context menu about 500 ms after the first finger touched down. This happens even though the user lifted or moved both fingers and never long-pressed. A pending timer can also call the callback after the component has unmounted.

## Steps to Reproduce

1. Open the hosted dashboard on a touch device, or in Chrome DevTools touch emulation with multi-touch.
2. Place one finger on a workflow step card (`WorkflowStep`) or a prompt chip (`PromptChipRail`).
3. Within 500 ms, place a second finger on the same element, as when starting a pinch or two-finger scroll.
4. Lift both fingers, or move them more than 10 px, before 500 ms have passed since the first touch.
5. About 500 ms after the first touchstart, the context menu opens at the first finger's position.

## Root Cause

`onTouchStart` in `src/ui/webview-react/hooks/useLongPress.ts:64` assigns a new `setTimeout` to `timerRef.current` without clearing a timer that is already pending. `touchstart` fires again for each extra finger, so the second touchstart orphans the first timer.

`cancel()` (lines 47-53) clears only the handle currently in `timerRef.current`. It serves as `onTouchEnd` and `onTouchCancel` (lines 88-89) and is called by `onTouchMove` (line 80), so none of them can reach the orphaned timer. That timer still runs `callback(x, y, opener)` at line 67.

The hook also has no unmount cleanup, and `onTouchStart` never checks `e.touches.length`, so it treats a multi-touch gesture as the start of a long press.

## Suggested Fix

- In `onTouchStart`, call `cancel()` first. If `e.touches.length > 1`, return without starting a timer, because a multi-touch gesture is not a long press. The second finger then cancels the pending timer.
- Add `useEffect(() => cancel, [cancel])` so a pending timer is cleared on unmount.
- Add a Vitest test under `src/ui/webview-react/test/` that fires two touchstarts followed by a touchend, advances fake timers, and asserts the callback was never called.
