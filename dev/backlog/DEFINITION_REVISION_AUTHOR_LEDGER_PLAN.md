# Definition-revision conflicts — make "my own edit can't conflict with me" structural

> **Status:** Steps 1–2 implemented; step 3 remains. Design finalized 2026-09-18; staged as the three steps in
> **Implementation plan** below.
>
> **Prerequisites already landed** (bug-fix branch, Sept 2026): no-op writes no longer bump
> `definitionRevision` (`applyWorkflowPropertyWrites`, and the no-op short-circuits in both
> `mutateRunDefinition` implementations), and `WorkflowMutationCoordinator.retryWithRefreshedRevisions`
> absorbs a stale revision for property writes and Re-run. Those two remove the reported failures.
> This doc covers the part that is still structural.

## The invariant we want

> A single user editing one workflow from one dashboard must never see
> `Definition revision conflict`.

Today that is true only by accumulation of patches, and every new mutation class has to re-earn it.

## Why the protocol can't deliver it on its own

`definitionRevision` is an optimistic-concurrency token the client **echoes**: it holds the revision
it was last told about, attaches it to the next mutation, and the server rejects a mismatch. The
client can only learn a new revision by round trip (`WORKFLOW_VIEW_IDENTITY`, or the revisions inside
`RUN_VIEW_LOADED`).

So the moment a user acts faster than that round trip — which is every drag of a slider, every
Ctrl+Z burst, every "edit a property then immediately press Re-run" — they post a message carrying a
revision their _own previous message_ already superseded. The client cannot detect this: nothing in
its state distinguishes "I am behind because of my own in-flight write" from "I am up to date". A
purely client-side fix is impossible, and a server-side per-call retry (what we do now) has to be
opted into one handler at a time.

The check itself is worth keeping. It is what stops a CLI run, an MCP append, a second VS Code
window, or a hosted browser tab from overwriting content the acting client never saw. The problem is
that it cannot currently tell _who_ moved the revision.

## Proposal: an author ledger, in memory, in the orchestrator

Record, per addressed definition, who wrote each revision — then accept a stale revision when every
revision between the client's expectation and the current head was written by **that same client**.

```ts
// WorkflowOrchestrator (or a small collaborator it owns)
// definition key: WorkflowOrchestrator.describeViewAddress(address)
// descriptor key: the WorkflowKey (the descriptor is lineage-scoped, not run-scoped)
type RevisionAuthorship = {
  revision: number; // current head this host knows about
  authorClientId: string; // who wrote `revision`
  soleAuthorSince: number; // lowest revision from which authorClientId has been the only writer
};
```

Maintenance is two lines on every successful write this host performed on behalf of a client: if
`authorClientId` is unchanged, keep `soleAuthorSince`; otherwise set it to the new revision.

### Reconcile at the boundary, do not thread `clientId` downward

The ledger needs the acting `clientId`, and that identity exists **only at the orchestrator's
client-facing entry points**. `WorkingFileManager`, `RunContinuationService` and `WorkflowInstance`
receive a bare `expectedDefinitionRevision` and have no client concept at all; giving them one would
push a UI-session identity into the persistence layer to serve a check that can be made before the
call is ever issued.

So the ledger does not replace the comparison at the deep check sites. It *reconciles the expected
value* at the boundary, and the deep sites keep comparing against disk exactly as they do today:

```
reconcileExpectedDefinitionRevision(key, clientId, expected):
  entry = ledger.get(key)
  if entry && entry.authorClientId === clientId && expected >= entry.soleAuthorSince - 1:
    return entry.revision      // the client is catching up to itself
  return expected              // unchanged; the deep check decides
```

`soleAuthorSince - 1` is the floor because the expectation a client holds *before* its first write
is the revision preceding that write.

This is what makes the "whitelist, not a cache" property fall out for free. A write this host did not
perform — CLI, MCP, another extension host — never enters the ledger, so `entry.revision` goes stale
while the head moves. The reconciled value then fails the deep comparison against disk, and the
conflict is rejected exactly as today. **A design that only compared `expected` against the ledger
would silently accept over a foreign writer**; reconciling into the existing on-disk check is what
prevents that, with no extra read.

### The descriptor revision is in scope too

Run-*starting* actions (`seedAndExecuteAtRun`, `startNewRunInsteadAtRun`, `continueAtRun`,
`appendAndContinueAtRun`, `setStartPositionAtRun`, `discardContinuationAtRun`,
`executeDraftAtAddress`) carry **both** tokens, and `retryWithRefreshedRevisions` refreshes both. A
ledger covering only `definitionRevision` would therefore regress the moment the retry is deleted:
a client's own previous Re-run bumps the lineage descriptor via `allocateRun`, so a second press
before the identity round trip posts a stale `expectedDescriptorRevision`. The ledger keeps a second
map, keyed by `WorkflowKey`, with the same authorship rule.

### No locking is required

`WebviewMessageRouter.route` chains every webview message onto a single `routeQueue` promise, so
dashboard mutations are strictly serialized within the extension host. The ledger is read and
written inside that serialized region and needs no lock or async guard of its own.

### Why in memory and not on the working file

Every dashboard write already funnels through this extension host, so an in-memory map is complete
for the only case the invariant is about. Persisting authorship into `WorkingFile` would mean a
schema field, draft/run/staging plumbing, and a migration, to buy protection against a case
(surviving an extension-host restart mid-edit-burst) that does not exist — a restart drops the
client's revision too, and the next `RUN_VIEW_LOADED` re-seeds both sides.

### What it replaces

- `WorkflowMutationCoordinator.retryWithRefreshedRevisions` — both call sites
  (`prepareWorkflowPropertiesMutation`, and `WorkflowStepHandlers.handleSeedNewRun`). A retry stops
  being necessary when the first attempt is not wrongly rejected.
- The need to decide, per new mutation class, whether it is "merge-safe enough" to retry.
- `reportActionFailure`'s revision republish stays; it is still the right recovery for a _genuine_
  cross-writer conflict.

### Check sites to convert

The `expected !== actual` comparison is currently written out 16 times for the definition revision:
`WorkflowOrchestrator.prepareDefinitionMutation` (3 branches), `WorkingFileManager` (6, incl.
`seedNewRun` and its `mutateRunDefinition`), `RunContinuationService` (4, incl. its own
`mutateRunDefinition`), `RunLifecycleService` (2), `WorkflowInstance` (1) — plus 5 more for the
descriptor revision across `WorkflowOrchestrator`, `RunLifecycleService` and
`WorkflowLineageRepository`. They should route through one shared predicate rather than each
re-deriving the rule — that single-sourcing is most of the work, and is worth doing even if the
ledger itself is deferred.

Step 1 provides `assertDefinitionRevision` and `assertDescriptorRevision` in
`src/core/orchestration/RevisionPrecondition.ts`. Steps 2–3 should use these guards for every
new revision precondition rather than adding local comparison-and-throw logic.

Two of the 16 do not produce the standard message and must be normalized as part of that pass:
`RunLifecycleService`'s draft check throws the bare `"Definition revision conflict while running
draft"`, and `WorkflowInstance.assertExpectedDefinitionRevision` consumes a primed expectation
rather than taking one as an argument. `WorkflowMutationCoordinator` matches conflicts by the
substring `"revision conflict"`, so any new message must keep it.

## Smaller, independently useful alternative

If the ledger is judged too broad: give run-_starting_ actions no definition precondition at all.
Re-run (`seedAndExecuteAtRun`) and start-position-zero copy a run's persisted definition forward into
a **brand-new** run. There is nothing to clobber, so the precondition protects no data — its only
effect is to refuse when the user's view is stale, and "run the newest definition" is what the button
means. The `pendingEdit` gate and the descriptor reservation in `seedNewRun` are separate guards and
must stay.

## Testing

The regression that matters is a _sequence_, not a single call: post N property writes for the same
address without draining the identity responses, then a run-start, and assert none of them is
rejected. A unit test that feeds one stale revision to one handler cannot catch the class.
`src/test/integration/helpers/propertyRoundTrip.ts` and
`workflowPropertyRoundTrip.integration.test.ts` already build the client/orchestrator pairing this
needs.

The test must be written with `retryWithRefreshedRevisions` already removed, otherwise it passes for
the wrong reason.

A second case guards the whitelist property: move the head from outside the ledger (write the run
file directly, as a CLI/MCP writer would) and assert the client's stale revision is still rejected.

## Implementation plan

1. **Done — single-source the revision preconditions.** One shared guard for the 16
   definition-revision and 5 descriptor-revision comparisons. Pure refactor, no behavior change.
2. **Done — add the author ledger.** `src/core/orchestration/DefinitionAuthorLedger.ts` exports
   `DefinitionAuthorLedger`, owned by `WorkflowOrchestrator`. It reconciles at
   `prepareDefinitionMutation` (and therefore `prepareWorkflowPropertiesMutation`),
   `setStartPositionAtRun`, `seedAndExecuteAtRun`, `executeDraftAtAddress`,
   `startNewRunInsteadAtRun`, `appendAndContinueAtRun`, `continueAtRun`, and
   `discardContinuationAtRun`. Definition-address entries use
   `RunLifecycleService.describeViewAddress`; descriptor entries use `WorkflowKey`.
   Deep check sites remain unchanged.
3. **Retire `retryWithRefreshedRevisions`** and prove the invariant with the sequence regression
   test above.

Each step keeps this document current and commits its own work.
