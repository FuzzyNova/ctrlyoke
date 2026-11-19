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

Not confirmed. Running the file alone (75 times) is the wrong reproduction. The UI suite runs
with `isolate: false`, so a failure seen only in the full run is almost always a leak from an
earlier file in the same worker (see the `isolate: false` bullet in
`.github/instructions/webview-react.instructions.md`).

Ruled out by code inspection (2026-11-18 final-step review):

- **A late animation-frame measurement after the stub is restored.** The setup file's global
  `ResizeObserver` mock (`test/setup.ts`) has a no-op `observe`, so
  `createAnimationFrameResizeObserver` never schedules a frame in this file. Every width
  measurement (the ref-attach snapshot and the `useElementTier` effect) runs synchronously
  inside `render()`'s `act()`, while the stub is still in place. The failing assertion at
  line 292 also runs before the `finally` restores the prototype.
- **Time or staleness.** `getHarnessUsageDisplay` applies no freshness rule to `percentOnly`.
  It drops only a past `resetAt` suffix.
- **Persisted-store rehydration.** Neither `harnessUsageStore` nor `settingsStore` uses
  `persist`.

So in the failing run, either the rendered div did not resolve `getBoundingClientRect` to the
`Element.prototype` stub, or the badge's inputs were different: the usage snapshot was missing,
or `percentDirection` was not `remaining`, which renders `25%`. The truncated DOM dump does not
show which. Candidates, all of which are cross-file leaks:

- An own `getBoundingClientRect` on a prototype between `Element` and the div that
  `test/fileIsolation.ts` does not guard. `GUARDED_PROTOTYPES` covers `Node`, `Element`,
  `HTMLElement`, `HTMLCanvasElement`, `Range` and `Document`, but not `HTMLDivElement` and
  the other concrete element prototypes. No test patches those today by name, so check
  helpers and `Object.defineProperty(proto, …)` calls on computed prototypes too.
- A `ResizeObserver` installed by direct `window.ResizeObserver =` assignment
  (`test/hooks/useElementNarrow.test.ts` does this and restores it in `afterEach`), or any
  other global that `vi.unstubAllGlobals()` does not undo.
- A store or module instance that the component and the test resolve differently after
  `vi.resetModules()`.

## Suggested Fix

1. Try to reproduce the failure deterministically in a single worker. Run the whole UI suite
   with one worker (`npx vitest run --maxWorkers=1` from `src/ui/webview-react`) a few times.
   If it fails, bisect the files that ran before it with an ordered `BaseSequencer` subclass,
   as the instruction file describes. Fix the leak at its source, or extend
   `test/fileIsolation.ts` if the leak is a class of state it should already cover.
2. Whether or not it reproduces, make the test self-diagnosing and less fragile:
   - Move the width stub into the test's setup and teardown using
     `test/fixtures/elementLayout.ts` or `vi.spyOn`, not a hand-rolled prototype swap.
   - Before rendering, assert that a freshly created `div` measures 300px. That makes a
     prototype-shadowing leak fail with its own message.
   - If `75%` is missing, report the badge inputs (the store's Claude snapshot and the
     settings `percentDirection`) and the row's text, so the next failure names its cause.
3. Do not weaken the `75%` assertion or the 180px threshold.
