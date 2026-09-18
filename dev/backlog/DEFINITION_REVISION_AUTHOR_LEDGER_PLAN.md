# Definition-revision conflicts — make "my own edit can't conflict with me" structural

> **Status:** Not implemented. Design only.
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
// key: WorkflowOrchestrator.describeViewAddress(address)
type RevisionAuthorship = {
  revision: number; // current head this host knows about
  authorClientId: string; // who wrote `revision`
  soleAuthorSince: number; // lowest revision from which authorClientId has been the only writer
};
```

Maintenance is two lines on every successful definition write: if `authorClientId` is unchanged,
keep `soleAuthorSince`; otherwise set it to the new revision.

Acceptance, replacing the bare `!==` at each check site:

```
accept if expected === head                                   // normal case, unchanged
     or (client === authorClientId && expected >= soleAuthorSince - 1)  // catching up to itself
reject otherwise
```

A write this host did not perform (CLI, MCP, another extension host) never enters the ledger, so the
head moves without a matching entry and the ledger is invalidated for that address — those conflicts
stay rejected exactly as today. That is the right failure mode: the ledger is a _whitelist_ of
known-self authorship, not a cache of the head.

### Why in memory and not on the working file

Every dashboard write already funnels through this extension host, so an in-memory map is complete
for the only case the invariant is about. Persisting authorship into `WorkingFile` would mean a
schema field, draft/run/staging plumbing, and a migration, to buy protection against a case
(surviving an extension-host restart mid-edit-burst) that does not exist — a restart drops the
client's revision too, and the next `RUN_VIEW_LOADED` re-seeds both sides.

### What it replaces

- `WorkflowMutationCoordinator.retryWithRefreshedRevisions` — both call sites. A retry stops being
  necessary when the first attempt is not wrongly rejected.
- The need to decide, per new mutation class, whether it is "merge-safe enough" to retry.
- `reportActionFailure`'s revision republish stays; it is still the right recovery for a _genuine_
  cross-writer conflict.

### Check sites to convert

The `expected !== actual` comparison is currently written out 16 times:
`WorkflowOrchestrator.prepareDefinitionMutation` (3 branches), `WorkingFileManager` (6, incl.
`seedNewRun` and its `mutateRunDefinition`), `RunContinuationService` (4, incl. its own
`mutateRunDefinition`), `RunLifecycleService` (2), `WorkflowInstance` (1). They should route
through one shared predicate rather than each re-deriving the rule — that single-sourcing is most of
the work, and is worth doing even if the ledger itself is deferred.

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
