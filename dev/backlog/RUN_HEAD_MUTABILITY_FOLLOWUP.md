# Run-Head Mutability Follow-up

Status: **Proposed — design correction to Working File Per Run.**

## Problem

The completed Working File Per Run implementation treats a promoted run as
effectively immutable except for two narrowly named operations: append and a
nonzero rewind. Its generic-edit gateway instead seeds a lineage draft.

That is not the intended meaning of “one working file per run.” In the common
single-run workflow, a user should be able to finish steps with one harness,
change the run’s workflow settings, append a step, and continue that exact
run with its existing sessions and output. Today, changing a property first
creates a draft, so the following append no longer clearly targets the run the
user was viewing. The dashboard’s Queue from File action also still uses the
legacy instance-bound append path rather than the existing run-addressed
append-and-continue operation.

The result makes a run feel less editable than the old single working file,
despite each run now owning its own working file.

## What remains correct

Do **not** revert the run layout, stable addresses, per-client views, locking,
or revision-tagged timeline work. They solve real problems and are the
mechanism that makes this correction safe:

- A run already owns `workflow.ctrlyoke.json`, its manifest, and its timeline.
- A run already has a mutable `definitionRevision` head.
- Each executed attempt already records the immutable definition revision that
  produced it, so old output is not reinterpreted when the current head
  changes.
- A client can view a historical run without rebinding an executor that owns a
  different run.
- Explicit `RunRef` targeting, optimistic revision checks, locks, and
  `RunContinuationService` already prevent continuation from drifting to a
  newer run.

The design error is the policy in `prepareDefinitionMutation`: it treats every
ordinary mutation of a promoted run as a request to fork a draft. That policy
contradicts the run-file ownership model; it is not required by it.

## Desired mental model

A promoted run is a durable, addressable workflow with:

1. one **current mutable definition head** in its own working file;
2. immutable historical definition revisions for every executed attempt; and
3. resumable runtime/session data for work that has not been deliberately
   invalidated.

Viewing run N means the editor, properties, steps, and output display run N.
Editing an idle run N changes run N’s current head in place. It never changes
old attempt definitions or output. Appending then continues N, including with
the newly selected harness/model/settings.

Only actions that deliberately start execution from the beginning allocate a
new run:

- **Re-run** always seeds a new `RunRef` from the selected run’s current head.
- **Set start position to step 1** always seeds a new run.
- An explicit future **Fork as new run** action may seed a draft/new run when a
  user wants a branch instead of changing the selected run.

Draft is therefore preparation for a new run, not the default destination for
ordinary edits to an existing run.

## Deliberate traceability trade-off

This correction intentionally gives up one convenience of the automatic-draft
policy: after a user rewinds a run, deletes steps, and continues it, the old
full step list is no longer the run's **current working-file head**. For
example, a ten-step run rewound to step 2 and trimmed to two steps becomes a
two-step current definition when it continues. There is no longer a separate
promoted run that automatically preserves the old ten-step head for ordinary
editing.

That is an acceptable product trade-off. ctrlyoke is primarily a tool for
continuing and steering agent work, not a version-control system that forks a
new workflow whenever a user edits it. Requiring a fork to change harness,
model, queue shape, or tail prompts prevents the most common continuation
workflow.

This is a loss of **current-head recoverability**, not permission to lose
historical execution meaning:

- The timeline retains the old attempts, including their output and attempt
  order.
- Each old attempt continues to resolve against its immutable committed
  definition revision, which retains the old prompt, step order, and effective
  workflow properties. An old “step 7” output must therefore remain renderable
  and searchable even after step 7 no longer exists in the current head.
- The current head controls only future edits and future execution. It must
  not be used to relabel or reinterpret prior attempts.
- Discard Continuation retains its existing narrow recovery promise while a
  rewind is pending: it restores the durable pre-rewind base file. Once the
  user continues, that is an intentional commit; restoring an old revision is
  a future explicit operation, not an implicit draft side effect.

The implementation must make this distinction visible in data handling. A
history/output renderer, search result, prior-context resolver, or saved
definition must never assume every historical attempt still has a matching
step in the current run head. It must use the attempt's committed definition
revision. Conversely, prior context for newly continued work must select the
current valid prefix/attempts and must not resurrect output solely because a
deleted step once occupied a reused numeric index.

An explicit **Restore revision as current head** or **Fork revision as new
run** feature may be added later if users need easy recovery of an old
definition. It is not required for this correction and must not reintroduce
automatic forking.

## Mutation policy

### Allowed in place

For an addressed promoted run that is not actively executing, permit these
mutations directly against that run’s working file, with expected definition
and descriptor revisions:

- workflow name and workflow-level properties;
- add, edit, delete, reorder, enable, or disable queue steps;
- create, edit, or delete a final step;
- append one or more runtime-free tail steps; and
- nonzero set-start-position and its subsequent continuation edits.

Every definition mutation increments the run head’s `definitionRevision` and
updates descriptor modification time. Existing runtime data stays attached to
unchanged steps. A later execution records a `DEFINITION_REVISION_COMMITTED`
snapshot before it writes output, so old and new attempts remain auditable.

Changing a property before an append may create an intermediate unexecuted
definition revision. This is correct and simple. A later UX optimization may
batch property changes and tail insertion into one revision, but batching is
not a correctness requirement.

### Still protected

- A run in `RUNNING`, `PAUSING`, or `CANCELLING` remains mutation-locked.
  Dynamic MCP append retains its existing exact-run exception.
- A paused run may continue to use the existing explicit rewind/continue
  handling. Direct mutation during pause needs a separate runtime/session
  safety audit before it is enabled; it must never redirect the lock, watcher,
  PTY, or harness environment to another run.
- Delete and retention still reject executing and transaction-protected runs.
- A full restart from step zero and Re-run still create a new run. They must
  never overwrite the selected run’s output-bearing history.

### Pending rewind

The old plan locked workflow-level properties during a pending rewind because
it assumed the current head was the only description of the preserved prefix.
That assumption no longer holds: prefix attempts already resolve through
their committed definition revisions.

This follow-up should permit property changes during a pending rewind, with
the same optimistic-revision and recovery treatment as suffix edits. The
durable base snapshot remains solely for Discard Continuation; it restores the
pre-rewind head and runtime. Step topology changes remain restricted to the
suffix until the prefix-identity checks are reviewed, but workflow properties
need not be blocked merely to preserve historical meaning.

## Required implementation corrections

### 1. Remove automatic draft for promoted-run edits

Replace the generic promoted-run branch in
`WorkflowOrchestrator.prepareDefinitionMutation()` with addressed in-place
validation. It must:

- verify the client still views the supplied `{ workflowKey, runRef }`;
- read and compare descriptor and definition revisions;
- reject an active execution of a different run in the lineage;
- reject unsafe active states on the target run; and
- route the following queue/property write to the addressed run file without
  loading it into, or rebinding, another client’s execution instance.

`prepareWorkflowPropertiesMutation()` should use the same rule. It must no
longer require the run to already be the execution target merely to save a
workflow property.

The implementation may use a short-lived addressed editing instance only if
it has no watcher, process lock, harness environment, or live terminal
ownership. Prefer a repository/working-file mutation seam over creating
execution instances for definition-only writes.

### 2. Make dashboard append explicitly run-addressed

The `APPEND_FILE` dashboard flow is legacy and currently invokes
`appendFromFileForClient()`. For a displayed promoted run it must parse the
tail and invoke `appendAndContinueAtRun()` with that displayed address and its
optimistic revisions. It must never infer a target from the active instance or
latest run.

The webview should send the displayed run address/revisions for Queue from
File. A draft may keep its normal queue-edit behavior; a promoted run uses the
continuation contract. Rename the UI action to **Append and continue from
file…** when the selected address is a run so its execution effect is clear.

Apply the same addressing rule to the prompt editor’s new-step submission and
step-panel append/paste actions when they are used against a promoted run:
they must append to that run, not silently fork a draft. Mid-list insert,
editing an earlier step, delete, and reorder still edit that run head in place
under this proposal.

### 3. Separate persisted run-head editing from execution ownership

Existing instance methods often write through the queue they own. Add a small
addressed mutation service or extend `WorkingFileManager` so definition-only
changes can operate on a selected idle run’s file directly. Keep these rules:

- `WorkingFileManager` remains the sole writer of a run/draft definition.
- `TimelineRecorder` remains the sole writer of manifests/events.
- No client view change loads a selected run into a shared executor merely to
  perform an edit.
- After a successful mutation, invalidate/reload only views of that exact run;
  other views and an executor running another run stay unchanged.
- Update the manifest’s current definition revision and step count where its
  summary contract requires it, without fabricating execution transitions.

### 4. Narrow the role of drafts

Keep drafts for:

- a never-executed workflow;
- explicit Re-run / run-from-step-one preparation; and
- a future explicit fork operation.

Remove the assumption that a descriptor’s `pendingEdit: { kind: "draft" }`
is created by ordinary edits to a promoted run. Existing drafts should remain
loadable; no storage migration is required for this policy correction.

## UX requirements

- The run label remains visible while an idle run is being edited. Do not
  switch the client to “Draft” after a property or step edit.
- A selected completed run can change from Claude to Codex, receive an
  appended prompt, and continue as the same `RunRef`/`runId`.
- Header Re-run stays unambiguous: it allocates a new run from the selected
  current head.
- A pending rewind banner continues to identify the same run. Its Discard
  action restores the durable base head, including any property changes made
  while the rewind was pending.
- UI state, zundo baseline, selected step, settings, output, and save/export
  framing rebase to the same run address after an in-place mutation; they must
  not take a draft detour.

## Test and acceptance matrix

- Changing harness/model on a completed run keeps its `RunRef`, `runId`, and
  view address; appending a prompt runs the tail with the new effective
  settings while the old attempts retain their original definition revisions.
- Queue from File on a historical completed run addresses that exact run even
  when a different run is latest or executing.
- New-prompt append, paste-at-end, edit, delete, reorder, final-step change,
  and workflow-property change mutate an idle selected run without creating a
  draft.
- Re-run and step-zero rewind still create a new `RunRef`, retain the source
  byte-for-byte, and strip execution runtime in the new run.
- A nonzero rewind keeps its `RunRef`; property changes survive Continue and
  are restored by Discard.
- Two clients can edit/view different idle runs while a third run executes;
  no watcher, lock, terminal, environment, or live message is redirected.
- Stale expected definition/descriptor revisions deterministically reject
  writes, including property-then-append races.
- A run executing in an unsafe active state rejects dashboard edits without
  creating a draft.
- Save/export after an in-place edit serializes the selected run’s current
  head, while output inspection of older attempts resolves their committed
  definitions.
- After rewind → delete suffix → continue, the current run file contains only
  the deliberate new head, while output/search for deleted historical steps
  still uses their earlier committed revision. New prior-context construction
  never selects a deleted attempt just because a later step reuses its index.

## Delivery sequence

1. Add addressed run-head mutation primitives and focused persistence tests.
2. Replace the orchestrator’s automatic-draft policy and cover multi-client
   isolation/state guards.
3. Convert dashboard file/prompt/step append paths to stable addressed
   continuation operations; update UI labels and webview tests.
4. Relax pending-rewind property handling with durable discard/recovery tests.
5. Run full compile, typecheck, lint, extension tests, webview tests, and
   formatting checks. Regenerate only artifacts affected by contract changes.

## Decision

Proceed with this correction rather than reverting the run-scoped storage
work. The current implementation has already paid for the difficult parts:
per-run definitions, definition revisions, exact continuation targeting, and
per-client view isolation. Restoring mutability to a run’s current head makes
those mechanisms serve the intended everyday workflow instead of forcing an
unnecessary fork.

claude --resume 74012a38-21d7-486f-af18-a5c5638b5774
