# HarnessDropdown quota-badge test fails intermittently under full-suite load

- **Found:** 2026-11-18 by the bug-drain final-step review (`npm test` after ~c48b4a673)
- **Area:** `src/ui/webview-react/test/components/shared/HarnessDropdown.test.tsx`,
  `src/ui/webview-react/hooks/useElementNarrow.ts`
- **Severity:** low

## Symptom

`HarnessDropdown > shows a percentage badge before the status dot when usage data exists`
failed once in a full `npm test` run:

```
TestingLibraryElementError: Unable to find an element with the text: 75%.
  at test/components/shared/HarnessDropdown.test.tsx:292
```

The other 4834 UI tests passed. Run alone with
`npx vitest run test/components/shared/HarnessDropdown.test.tsx` from
`src/ui/webview-react`, all 14 tests in the file pass. No commit in that round touched the
dropdown, the usage store or `useElementNarrow`, so this is a timing or isolation flake rather
than a regression. A flaky test in the `npm test` gate makes every bug-fix step's verdict
unreliable.

## Steps to Reproduce

1. Run `npm test` (all three suites run concurrently) a few times, or run the UI suite under
   CPU load, for example `npm run test:ui` while the extension suite runs.
2. The test above sometimes fails. The full log is under `.ctrlyoke/logs/test-runs/`.

### Investigation attempt (2026-11-18)

- Tried the documented `npx vitest run test/components/shared/HarnessDropdown.test.tsx --repeat 50`
  from `src/ui/webview-react`; the installed Vitest 5.1.0 rejects `--repeat` as an unknown
  option.
- Replaced it with 50 sequential runs of `npx vitest run
  test/components/shared/HarnessDropdown.test.tsx`; all 50 passed.
- Repeated the file 25 times while a CPU-bound PowerShell job ran alongside it; all 25 passed.
- The reported failure was not reproduced. Do not treat the suspected cause below as confirmed.

## Root Cause

Not confirmed: the failure did not reproduce in 75 repeat runs, including 25 under CPU load.
Code inspection identifies a plausible timing hazard, but it has not been observed causing this
failure. The badge only renders when `useElementNarrow(180)` reports a wide element. The test
makes the element wide by replacing `Element.prototype.getBoundingClientRect` and restores it as
soon as its synchronous assertions finish, while the hook also measures from an animation-frame
ResizeObserver callback. If that callback runs after restoration, it can measure jsdom's default
0px width and hide the badge. Confirm this path with a reproduction or failure-time instrumentation
before calling it the root cause. Other items to check:

- `useElementTier` measures once on ref attach, then again from
  `createAnimationFrameResizeObserver`. If a deferred frame or observer callback from this
  test or an earlier one runs while a different stub (or the original jsdom 0-width rect) is
  in place, `isNarrow` flips to true and hides the badge. Under load the frame timing changes.
- Store state (`useHarnessUsageStore`, `useSettingsStore`) or the prototype patch leaking
  between tests in the file. The file's `afterEach` resets usage and settings state, and no other
  test in the file patches `getBoundingClientRect`.
- Anything time-based in the badge: `fetchedAt`/`updatedAt` use `Date.now()` with a 5-minute
  `staleAfterMs`, so staleness is unlikely, but confirm the badge has no tighter freshness rule.

## Suggested Fix

Reproduce first: loop the file (for example `npx vitest run <file> --repeat 50`, or run it
under `--pool=threads` with a CPU-heavy process alongside) until it fails. Then make the width
deterministic without a global prototype patch outliving the render: stub
`getBoundingClientRect` with `vi.spyOn` and restore it in `afterEach`, flush pending animation
frames or observer callbacks inside `act()` before asserting, and use `findByText` if the badge
legitimately appears after a frame. Do not weaken the assertion or the 180px threshold.
