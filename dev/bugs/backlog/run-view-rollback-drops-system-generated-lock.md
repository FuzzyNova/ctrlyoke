# A failed workflow switch unlocks editing on a read-only system-generated workflow

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with a scratch vitest test against `useUIStore`)
- **Area:** `src/ui/webview-react/store/uiStore.ts` (`RunViewLoadRollback`, `requestRunViewLoad`, `rollbackRunViewLoad`)
- **Severity:** medium

## Symptom

While the dashboard shows a system-generated workflow (its editing controls
locked), the user starts switching to another workflow and the switch fails.
The failure can be a watchdog give-up or a `WORKFLOW_ACTION_FAILED`. The view
rolls back to the system-generated run, but `viewedLineageIsSystemGenerated`
is now `false`, so `useIsSystemGeneratedWorkflow` unlocks the workflow-editing
controls on a workflow that must stay read-only.

## Steps to Reproduce

1. `setDisplayedRunView(addressA, …, isSystemGenerated = true)`.
2. `requestRunViewLoad(addressB, …)`.
3. `rollbackRunViewLoad()`.
4. `displayedViewAddress` is back to `addressA`, but
   `viewedLineageIsSystemGenerated === false`. Expected: `true`.

## Root Cause

`requestRunViewLoad` (~2220-2229) calls `setDisplayedRunView(address, …)`
without the `isSystemGenerated` argument, which sets
`viewedLineageIsSystemGenerated` to `false` (~2060). The rollback snapshot
type `RunViewLoadRollback` (~71-83) and the snapshot built in
`requestRunViewLoad` don't include that field, so `rollbackRunViewLoad`
(~2262) never restores it. The comments at ~66-70 and ~2034-2037 require that
every field `setDisplayedRunView` writes also be in the rollback snapshot.

## Suggested Fix

Add `viewedLineageIsSystemGenerated` to `RunViewLoadRollback` and capture it
in `requestRunViewLoad`. Better, derive the snapshot from a single list of
the fields `setDisplayedRunView` writes, so the two can't drift again. Test in
`src/ui/webview-react/test/store/uiStore.test.ts`.
