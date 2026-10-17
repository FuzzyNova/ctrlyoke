# WorkflowStatus run-panel exit tests race the 320 ms fallback timer

- **Found:** 2026-10-17 by Claude Code during a full `npm test`
- **Area:** `src/ui/webview-react/test/components/workflow/WorkflowStatus.test.tsx`
- **Resolution:** fixed in this commit

## Symptom

Under a loaded full `npm test` (the test took 7.8 s), this test failed intermittently:

```
WorkflowStatus — run navigation panel > re-clicking the chevron while the run panel is open switches back to the workflow list
Error: expect(received).toBeInTheDocument()
Received has value: null
 ❯ test/components/workflow/WorkflowStatus.test.tsx:1767:7
```

It passed in the two runs immediately before it, with no dashboard code changed.

## Steps to Reproduce

1. Run `npm test` on a loaded machine (all three suites run concurrently).
2. Occasionally the assertion that `.animate-slide-out-right` is present fails.

## Root Cause

`WorkflowStatus.handleBackToWorkflowList` sets `isRunPanelLeaving`. It then schedules `finishRunPanelExit` after a real-time `RUN_PANEL_EXIT_FALLBACK_MS` (320 ms), because jsdom never fires `animationend`. The test makes a synchronous assertion on that short-lived class after `await user.click(...)`. When the click's event dispatch and React flush take longer than 320 ms of wall time, the panel has already been removed.

The same pattern is used at lines 1817, 1865 and 2189 of the test file, so those tests share the race.

## Suggested Fix

Drive the exit with fake timers in these tests: `vi.useFakeTimers({ shouldAdvanceTime: true })` plus `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`. The departing state then lasts until the test advances time past `RUN_PANEL_EXIT_FALLBACK_MS`, and the "present, then gone" assertions become deterministic.

## Resolution notes

The suggested `shouldAdvanceTime: true` does not remove the race: it advances the fake clock
with wall time, so a slow click still fires the 320 ms fallback before the assertion. Fully fake
timers hang instead, because RTL's async act wrapper (used by every `user.*` call) waits on a
`setTimeout(0)` it only advances when a global `jest` exists. The tests now open the panel with
real timers, then switch to `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` and
trigger the exit with a synchronous `fireEvent`, so only the test's `advanceTimersByTime` can
end the departing state. The 2189 test only asserts absence and is not affected.
