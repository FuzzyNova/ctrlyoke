# Opening a failed run from history does not clear its failure from the status bar

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli), reviewing b2371ff1f; reproduced with a throwaway Mocha test using the real `WorkflowInstanceRegistry` and `WorkflowActivityTracker`
- **Area:** `src/core/orchestration/WorkflowInstanceRegistry.ts` (`adoptInstanceLineageAddress`, `setViewAddress`), `src/core/orchestration/RunViewPublisher.ts`, `src/core/orchestration/WorkflowActivityTracker.ts`
- **Resolution:** fixed in this commit

## Symptom

Commit b2371ff1f says a session failure on the status bar "clears when a
client navigates to that run". In the most common case it doesn't. If the run
failed while nobody was viewing it and the user later opens it from history,
the bar stays red with "1 failed" while the panel shows that exact run. Only
clicking the bar clears it.

## Steps to Reproduce

1. Run a workflow and switch the panel to a different workflow (or close the panel) before the run fails, so the failed instance is retired and disposed (`WorkflowInstanceRegistry.ts` ~343-348).
2. The run fails, and the status bar shows the failure (correct).
3. Open that failed run from history.
4. Expected: the failure is acknowledged and the bar returns to normal.
5. Actual: the bar stays red.

## Root Cause

With no resident instance, `RunViewPublisher.bindClientToAddressedLineage`
(~line 319) goes through `WorkflowOrchestrator.loadFreshInstanceAndReplay`
(~line 1309). From there:

1. `setViewedWorkflowId(client, N)` acknowledges with the _new_ instance id `N`
   and a `null` address, which matches no tracked failure. The tracker matches
   failures by the failed instance's id or by run address.
2. `instance.loadWorkingFile` emits a state change carrying the run's
   `workflowKey`/`runRef`, so `adoptInstanceLineageAddress` (~line 552-568)
   writes the run address **directly** into `viewAddressRegistry`
   (`this.viewAddressRegistry.set(clientId, address)`) without acknowledging.
3. `deliverRunView` then calls `setViewAddress(client, R)` (`RunViewPublisher.ts` ~469). The address is already `R`, so
   `if (!sameViewAddress(previous, address))` is false and
   `host.acknowledgeWorkflowView(null, address)` never runs.

The only address-based acknowledgement is skipped because an earlier,
unacknowledged write already moved the address. The existing test
(`WorkflowInstanceRegistry.test.ts` ~155) calls `setViewAddress` directly, so it
never exercises this bind → adopt → deliver order.

## Suggested Fix

Make every place that changes a client's view address go through one method
that acknowledges a real change: have `adoptInstanceLineageAddress` call
`setViewAddress`, or the same private helper, instead of writing the map
directly. Starting a run (draft → run address) also passes through adoption.
Acknowledging there is harmless, because a new run has no failure yet, but
check it doesn't clear the failure of the _previous_ run of the same lineage
unexpectedly, beyond the documented "a new run of the lineage starts" rule.
Add a registry/orchestrator test that drives the real history-open order
(fresh instance → `loadWorkingFile` state change → `deliverRunView`) and
asserts the tracker has no unseen failure afterwards.

Related, lower confidence and not covered here: see
`status-bar-failure-survives-run-deletion.md`.
