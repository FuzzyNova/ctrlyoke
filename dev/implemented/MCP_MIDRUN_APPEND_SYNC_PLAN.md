# MCP Mid-Run Append — Sync and Identity Fixes

## Background

Discovered 2026-09-04 while an orchestrator step used `ctrlyoke_append_queue` to insert a
corrective step into its own running workflow — the spec-driven-loop shape, and the first time
anything had appended to a run _between_ step boundaries rather than at one.

The append itself worked: the run file was written correctly, `definitionRevision` incremented,
and `ctrlyoke_queue_status` reported the new step immediately. But `WorkflowStepsPanel` kept
showing the old step count for the rest of the running step. Navigating away and back flashed the
correct count, then reverted. The count corrected itself at the next step transition.

Defects 1–5 are implemented, and a review pass corrected three defects the fixes introduced (see the
closing section). Line references were originally taken against `b1223284` and re-verified
against `560957d0` on 2026-09-05, which corrected defect 5's scope, added the merge-novelty and
prefix-agreement constraints under defect 4, and moved defect 5 to the front of the sequencing.

---

## Not the bug: `descriptorRevision`

Stated first because it is the obvious suspect and it is wrong, and the next person to look at this
should not spend the time.

On a mid-run append `definitionRevision` increments while `descriptorRevision` does not. That is
correct and deliberate, documented at `RunContinuationService.ts:176-185`: appending never writes
the lineage descriptor, because a run's own steps are not descriptor content, and coupling the two
would make appending to one run spuriously conflict with unrelated lineage activity (renames,
favorites, other runs).

The two counters version two different documents and are both load-bearing:

|           | `definitionRevision`                                                            | `descriptorRevision`                                       |
| --------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Lives in  | the run's `workflow.ctrlyoke.json` (`CtrlYokeTypes.ts:707-717`)                 | the lineage's `workflow.json` (`CtrlYokeTypes.ts:457-458`) |
| Versions  | this run's step list                                                            | descriptor metadata and run allocation                     |
| Bumped by | `PromptQueue.bumpDefinitionRevision` (9 sites), `RunContinuationService.ts:271` | `WorkflowLineageRepository` :270, :429, :451, :487         |

The webview uses `definitionRevision` alone for step-list staleness
(`uiStore.appliedDefinitionRevision`, `useMessageHandler.ts:2380-2403`). `descriptorRevision` is only
an optimistic-concurrency precondition on lineage-level writes. There is nothing to unify.

---

## What is actually wrong

The MCP server is a separate child process with no IPC to the extension host (`mcp-server.ts:1-12`);
the filesystem is the only channel. `RunContinuationService.appendStepsToRun` writes
`run-<ts>/workflow.ctrlyoke.json` atomically — `writeFile(.tmp)` then `rename` (`:324`) — and never
touches the host's in-memory `PromptQueue`. So the host learns about an append only by watching that
file. Five defects sit on that path.

| #   | Defect                                                            | Effect                                                                                                   |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `promoteToNewRun` never re-points `PromptFileWatcher`             | the proactive push never fires at all                                                                    |
| 2   | `PromptFileWatcher` registers no `onDidCreate`                    | Windows `rename` writes missed even once #1 is fixed                                                     |
| 3   | `SESSION_RESTORED` overwrites fresh disk state, unguarded         | the correct count flashes then reverts on remount                                                        |
| 4   | `mergeDiskSteps` uses content hash as step identity               | an appended step with duplicate text is **silently dropped**                                             |
| 5   | Three `updateStepsExtended` call/impl sites drop `parallelGroups` | broadcast + hosted clients lose parallel-group topology, and the MCP-append push never carries it at all |

### 1. The watcher is pointed at the draft, not the run

**Status: Implemented (2026-09-05).** `PromptFileWatcher` now subscribes to
`PromptQueue.onDidChangeState` and treats `state.workingFilePath` as the single source of truth for
its watched path. Promotion therefore moves the watcher from the draft to the newly allocated run
without adding another scattered `setupPromptFileWatcher` call site. A real VS Code extension-host
test showed that this external, non-recursive single-file `RelativePattern` does **not** reliably
deliver the atomic replacement event, so `PromptFileWatcher` now has the same 1s polling fallback
shape used by runner discovery for external working files.

`WorkflowInstance.setupPromptFileWatcher` (`:5415`) is called from seven sites —
`initializeFileWatcher` :1282, `loadPromptFile` :1334, `loadFromTemplate` :1361,
`restoreWorkflowFromWorkingFile` :1464, `autoLoadFromWorkingFile` :1523, the append-file path :2769,
and `initializeNewWorkflow` :5843. **None is on the run-promotion path.**

`WorkflowInstance.ts:2011` calls `promptQueue.promoteToNewRun(...)`, which switches
`state.workingFilePath` from `draft/workflow.ctrlyoke.json` to `run-<ts>/workflow.ctrlyoke.json`
(`PromptQueue.ts:1775`), then calls only `syncCurrentPromptFileFromQueue` (`:2018`). The watcher is
left on the draft.

The codebase already knows this. `WorkflowInstance.ts:5434-5440` says so outright, in a comment
explaining why a delete event for the draft must not clear `currentPromptFile`:

> "`WorkingFileManager.finalizeRun` removes `draft/workflow.ctrlyoke.json` once its content lives on
> in `run-<ts>/workflow.ctrlyoke.json`, and the watcher is never re-pointed off the draft"

**Why this is intermittent:** a run re-adopted after a window reload goes through
`restoreWorkflowFromWorkingFile` / `autoLoadFromWorkingFile`, which _do_ set the watcher on the run
file. So the bug reproduces for a run started in the current session and not for one picked back up
later — which is why it survived this long.

**Fix.** Re-point the watcher when the queue's working file changes. Doing it inside
`promoteToNewRun`'s caller (`WorkflowInstance.ts:2015-2018`, beside `syncCurrentPromptFileFromQueue`)
is the narrowest change, but prefer making the watcher follow `state.workingFilePath` as a single
rule rather than adding an eighth call site — seven scattered call sites is how the one that mattered
got missed. Note the run file lives outside the workspace in default user mode
(`<ctrlyokeStateHome>/projects/<slug>-<hash12>/.runs/...`), which is the external-`RelativePattern`
territory that already forced the 1s polling fallback at `WorkflowOrchestrator.ts:6529-6531`; verify
the watcher actually fires there rather than assuming.

### 2. `PromptFileWatcher` is missing `onDidCreate`

**Status: Implemented (2026-09-05).** `PromptFileWatcher` registers `onDidCreate` with the same
reload handler as `onDidChange`, using the same Windows atomic-rename explanation as
`ExternalRunWatchSession`. A focused handler test confirms that an `onDidCreate` callback reaches
the reload handler; the real external-path test showed that VS Code may deliver neither event for
the atomic replacement, which is why the polling fallback is also required.

`PromptFileWatcher.ts:51-57` registers `onDidChange` and `onDidDelete` only. On Windows,
`fs.rename()` over an existing file — exactly what `writeWorkingFileAtomic` does — fires
`onDidCreate`, not `onDidChange`.

This is a known, already-solved problem in the sibling watcher. `ExternalRunWatchSession.ts:137-145`:

> "Also handle onDidCreate: on Windows, `fs.rename()` over an existing file (used by the MCP server's
> atomic temp-file write) fires `onDidCreate` instead of `onDidChange`, so MCP queue appends would
> otherwise be missed until the next natural queue write."

**Fix.** Register `onDidCreate` on `PromptFileWatcher` with the same handler as `onDidChange`.
Defects 1 and 2 must land together — either alone leaves the push broken.

Downstream of the watcher the path is already correct and needs no changes:
`WorkflowInstance.setupPromptFileWatcher` → `PromptFileLoader.reloadFromWorkingFile` (`:277`) → merge
mode while running (`:311-315`, `:347`) → `PromptQueue.mergeStepsFromDisk` → `updateStepsExtended`
(`:364`) → `STEPS_EXTENDED`.

### 3. `SESSION_RESTORED` clobbers fresh disk state on remount

**Status: Implemented (2026-09-05).** `SESSION_RESTORED` now carries the queue's
`definitionRevision` and shares the requestless regressive-snapshot guard with
`RUN_VIEW_LOADED`. Replays preserve the addressed view state while genuine
workflow changes continue to clear it.

This is the flash. `WorkflowOrchestrator.replayWorkflowStateTo` (`:945`) does three things in order:

1. `:995` `loadRunViewForClient` → `readAddressedRunView` reads the run file **from disk** →
   `RUN_VIEW_LOADED` with the correct steps and `definitionRevision`. Applied at
   `useMessageHandler.ts:2317`.
2. `:1011` `instance.replayFullStateTo(sink)` → `WorkflowInstance.ts:952` builds `SESSION_RESTORED`
   from `this.promptQueue.getState()` — the **stale in-memory queue**.
3. `:1026-1029` re-publishes `WORKFLOW_VIEW_IDENTITY`, whose `definitionRevision` is read from disk
   again.

`SESSION_RESTORED`'s handler (`useMessageHandler.ts:804`) carries **no `definitionRevision` and no
regression guard at all**, and unconditionally calls `loadWorkflow({ steps: message.steps })`. It
then calls `applyWorkflowChange()` (`:826`), which nulls `appliedDefinitionRevision` and
`displayedDefinitionRevision` (`:373-374`).

Net result: the client displays revision 3's number with revision 2's steps. Worse, because
`appliedDefinitionRevision` is left `null`, the `RUN_VIEW_LOADED` regressive-snapshot guard
(`useMessageHandler.ts:2380`, which requires a non-null current revision) is **disarmed for the rest
of that view**.

The ordering is already documented from the receiving side, in `uiStore.setDisplayedViewIdentity`'s
comment — the existing mitigation re-publishes the identity to restore the _numbers_, but nothing
restores the _step list_.

**Fix.** `SESSION_RESTORED` is the only message carrying a step list with no revision and no guard.
Give it a `definitionRevision` and apply the same regressive-snapshot guard `RUN_VIEW_LOADED` uses,
so a replay built from a stale in-memory queue cannot overwrite a newer disk snapshot. Do **not**
simply reorder the two sends — the ordering is relied on elsewhere, and a guard fixes the class of
bug rather than one instance of it. Separately, reconsider whether `applyWorkflowChange()` should be
nulling the applied revision on a _replay_ at all; that side effect disarming the other guard is its
own defect.

**Cost of carrying the revision.** `IDashboardSink.updateSessionRestored` (`:46-63`) already takes
**twelve** positional parameters; a `definitionRevision` makes thirteen, and defect 5's gotcha applies
in full — an implementation that declares fewer parameters compiles clean. Every site must be updated
by hand: producers `WorkflowInstance.ts:923` and `:958`, `PromptFileLoader.ts:336`,
`WorkflowOrchestrator.ts:6936`; forwarders `WorkflowTaggedSink.ts:76`, `CtrlYokeHostedServer.ts:417`,
`CtrlYokeWebviewProvider.ts:584`, `PostMessageDashboardSink.ts:93`; plus the deliberate no-op
`DashboardBroadcastHub.ts:167`, which stays a no-op. Thirteen positional parameters is past the point
where an options object is the right shape, but converting this signature is a separate refactor with
its own blast radius — do not fold it into the guard fix. Note the producers already have the value to
hand: `promptQueue.getState().definitionRevision`, the same source
`getDefinitionRevisionContext` uses.

### 4. Content hash as step identity — remove it

**Status: Implemented (2026-09-05).** `PromptQueue.mergeDiskSteps` now merges `_runtime` by index
only across the shared completed prefix and takes disk wholesale beyond it. The shared prefix rule
lives in the exported `immutablePrefixLength` helper in `RunContinuationService.ts`; the queue uses
the minimum disk/memory boundary. Novelty is detected structurally from disk steps beyond that
prefix (missing indices or differing step structures), preserving the count used by
`mergeStepsFromDisk` and the proactive `STEPS_EXTENDED` push. The MCP completed-text rejection was
removed, so repeated prompts are accepted while the queue-size limit remains enforced.

`PromptQueue.mergeDiskSteps` (`:1380-1470`) keys step identity on `hashPromptContent(prompt|script)`
in four places, and every one of them misbehaves when two steps share text:

- **`:1386-1391`** — `memoryPromptMap` is keyed by hash, so two identical in-memory steps collapse to
  one entry.
- **`:1397-1402`** — a disk step whose text matches any in-memory step is not counted as new. If that
  leaves `newStepsFromDisk` empty, the early return at `:1404-1414` updates `parallelGroups` **and
  nothing else** — `this.state.steps` is never touched, so the appended step never enters memory at
  all.
- **`:1420-1434`** — `_runtime` is reattached by hash, so two identical prompts would be handed the
  _same_ session ID and `completedAt`.
- **`:1438-1458`** — `findIndex` returns the first matching result, so duplicates share a status.

The second bullet is the silent one, and it is the dangerous one: no error, no rejection count, no
stale-count symptom. The step is simply gone from the panel until the next disk merge, and its
`_runtime` may be wrong afterwards.

**Fix: drop content hashing from the merge entirely.** Disk is already authoritative for order and
topology (`:1416-1418`), and the only thing memory contributes is `_runtime` for steps that have
already run. Completed steps are an index-stable immutable prefix by construction —
`RunContinuationService` clamps every splice point past `immutablePrefixLength` (`:244-260`, `:314`),
so an append can never renumber a completed step. So: **merge `_runtime` by index across the
immutable prefix, take disk wholesale beyond it.** No hashing, no identity ambiguity, and the results
array rebuilds on the same index basis.

Two constraints on that rewrite, both verified and both easy to miss:

- **The prefix must be the one disk and memory agree on.** `immutablePrefixLength`
  (`RunContinuationService.ts:307-316`) is computed from the _disk_ file's `_runtime.completedAt`,
  which can lag memory when a step has just finished and its runtime has not been flushed. Deriving
  the merge prefix from memory alone would let an append that legitimately spliced at disk's
  (shorter) boundary shift a step memory believes is completed, and index-merge `_runtime` onto the
  wrong step. Take `min` of the two boundaries.
  **Corrected during review:** "and merge only there" was wrong, and following it caused a
  regression — see review item 1 in the closing section. The completed boundary is the right _shared_
  prefix, but the index-stable region extends to the execution head
  (`max(completedBoundary, currentIndex + 1)`), because the running step cannot be renumbered either
  and its in-memory `_runtime` and `results` entry are newer than disk's.
- **Removing the hash removes the novelty signal, so a replacement is required.**
  `mergeDiskSteps` returns "new steps", `mergeStepsFromDisk` (`PromptQueue.ts:1496-1517`) turns that
  into a count, and `PromptFileLoader.ts:360` sends `STEPS_EXTENDED` **only when that count is > 0**.
  The count is currently derived from precisely the hash test being deleted. Replace it with a
  structural comparison against the merge prefix — disk length vs. memory length, plus any difference
  in the steps beyond the shared prefix — and keep returning a count so the existing logging, the
  `queueExtensions` counter, and that push guard all still work. A rewrite that drops the hash and
  leaves the guard reading a now-always-zero count silently disables the proactive push, converting
  defect 4 into defect 1 by another route.

There is a second, separate dedupe in the MCP server itself: `validatePrompts`
(`mcp-server.ts:660-692`) rejects a new prompt when any existing step with `_runtime.completedAt` has
identical `prompt` text, and `handleQueueAppend` throws if that rejects everything (`:452-462`).

**This guard has outlived its purpose and should be removed.** It dates from testing the MCP against
low-capability models: when the server failed to return a result, those models read the silence as an
error and re-appended the identical prompt in a loop. The server now returns properly, so the spam
mode it defended against no longer exists — and the guard actively blocks a legitimate case, an
orchestrator deliberately re-queueing a step it has run before (a repeated test gate, a retried
verification). Unlike defect 4 this one at least fails loudly via `stepsRejected`, so it is lower
severity — but it is the same mistaken premise, that prompt text is a step identity, and both should
go in the same change. Keep the loud-rejection shape for the queue-size limit at `:471-478`; that one
is real.

### 5. Three sites drop `parallelGroups`

**Status: Implemented (2026-09-05).** `parallelGroups` now flows through the broadcast hub and
hosted server delegates, and the `PromptFileLoader` MCP-append push passes the post-merge topology
with its workflow-id slot explicitly set to `undefined`. Regression coverage verifies both the
broadcast forwarding and proactive `STEPS_EXTENDED` payload.

`IDashboardSink.updateStepsExtended` takes six parameters, the sixth being
`parallelGroups?: ParallelGroupDefinition[]` (`IDashboardSink.ts:159-166`). Three sites ignore it:

| Site                               | Shape                                   | Effect                                            |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------- |
| `DashboardBroadcastHub.ts:357-372` | declares **five** params, forwards five | every broadcast client loses topology             |
| `CtrlYokeHostedServer.ts:612-626`  | declares **five** params, forwards five | every hosted browser client loses topology        |
| `PromptFileLoader.ts:364-369`      | **caller** passes four args             | the MCP-append push never carries topology at all |

Only `PostMessageDashboardSink` (`:316-333`) and `WorkflowTaggedSink` (`:282-298`) handle the
parameter correctly.

The third row is the one that matters here and was missed on the first pass: `PromptFileLoader`'s
merge branch is the _proactive MCP-append push_ — the exact code path defects 1–2 exist to restore.
Fixing 1–2 without fixing this site restores a push that still delivers stale parallel-group
topology, so this must land **before** 1–2 can be meaningfully verified. It also drops `workflowId`
(positional arg 5), which is only harmless because the sink reaching it is a `WorkflowTaggedSink`
that substitutes its own; pass `undefined` explicitly rather than relying on that.

**Fix.** Add the parameter to both implementations and forward it; pass it at the `PromptFileLoader`
call site from the post-merge queue state.

**Worth recording as a convention gotcha:** `implements IDashboardSink` does **not** catch this.
TypeScript accepts a method with fewer parameters as satisfying a signature with more, so an arity
mismatch on a sink method is invisible to the compiler. The project's "make structural relationships
nominal" rule does not cover this case. When adding a parameter to an `IDashboardSink` method, every
implementation must be updated by hand — grep for the method name rather than trusting the build. If
this recurs, consider a single options-object parameter, which _would_ be checked.

---

## Sequencing

Revised after verification — defect 5 moved to the front. Its `PromptFileLoader` call site sits _on_
the push path defects 1–2 restore, so it is a prerequisite rather than an unordered one-liner.

1. **Defect 5** — implemented in `d2fb3483`; thread `parallelGroups` through `DashboardBroadcastHub`,
   `CtrlYokeHostedServer`, and the `PromptFileLoader` merge call site.
2. **Defects 1 + 2 together** — implemented above: re-point the watcher on promotion and add
   `onDidCreate`. The real external-path test confirmed that the polling fallback is required.
3. **Defect 4** — replace hash identity with index-based `_runtime` merge in `mergeDiskSteps`, supply
   the replacement novelty signal, and remove the `validatePrompts` completed-text rejection.
   Independent of 1–2, and worth doing even if 1–2 slip: the disk merge at the next step transition is
   the safety net that currently makes the count self-correct, and this defect is a hole _in that
   safety net_.
4. **Defect 3** — the `SESSION_RESTORED` guard, implemented above. Largest blast radius (it touches
   every remount and every hosted-client rebind, not just the MCP path), so it landed last and on its own.

Defects 1–2 and 4 are the ones that matter for MCP mid-run appends. Defect 3 is a real bug on its own
terms that this investigation happened to surface.

## Closing note

The full plan shipped: file watching now follows promoted runs, append merges preserve topology and
duplicate-text steps, and replay snapshots carry revision-aware protection across extension and hosted
clients.

## Review pass — three defects introduced by the fixes (2026-09-05)

Found by inspecting the landed diffs rather than the step summaries, and by noticing that the
aggregate `npm test` run reported a failure the shell's exit code had masked. All three are fixed and
covered by regression tests.

1. **The merge boundary was too short, and it destroyed live execution state.** Defect 4's rewrite
   stopped merging in-memory state at the _completed_ boundary, per this document's own guidance. That
   is wrong: the step executing right now is equally index-stable, and its in-memory copy is the newest
   one. Taking disk wholesale for it dropped its `_runtime` (session ID, `startedAt`) and rebuilt its
   `state.results` entry as PENDING — and `getPreConditionSummary`/`getEndConditionSummary` read gate
   output out of `results[stepIndex]`, so `$preCondition:*` substitution silently stopped resolving.
   `preConditionFlow.integration.test.ts` caught it. The boundary is now
   `max(completedBoundary, currentIndex + 1)`, applied to `_runtime` and `results` alike, with a
   per-index structural check that declines to reuse state when the step at that index changed. The
   guidance under defect 4 above was the source of the error and has been corrected in
   `core.instructions.md`.
2. **The watcher's delete handler tore down the mechanism defect 1 installed.**
   `PromptFileWatcher.onFileDeleted` called `dispose()`, which now also drops the
   `onDidChangeState` subscription — so a single delete event permanently stopped the watcher from
   following `workingFilePath`, reinstating defect 1 on the same delivery timing that made it
   intermittent. It also blanked the panel. The promoted draft's delete routinely arrives after the
   queue has switched to the run file, which is exactly when this fires. `onFileDeleted` now honors a
   delete only for the queue's current working file, and tears down the watcher (`disposeWatcher`)
   rather than the subscription.
3. **A session _replace_ was misclassified as a replay.** Defect 3 threaded `definitionRevision` into
   `PromptFileLoader`'s REPLACE branch, which made its untagged `SESSION_RESTORED` satisfy the
   webview's replay predicate. That branch loads a _different_ session, so preserving the view address
   holds an address belonging to the workflow being navigated away from, and the guard then compares
   two unrelated workflows' revisions — silently dropping a lower-revision workflow. The revision is
   no longer sent there, and the omission is now commented at both ends and recorded in
   `core.instructions.md`.

Reviewer's note on defect 5's arity gotcha: it generalizes. Positional-parameter growth on
`IDashboardSink` is invisible to the compiler in _both_ directions — a missing trailing parameter in an
implementation, and a call site that fills the wrong slot. Every one of the nine `updateSessionRestored`
sites was verified by hand here; that check is not optional, and the added
`types-core.instructions.md` bullet now says so.

## Testing notes

- The symptom needs a run **started in the current VS Code session** (see "why this is intermittent"
  under defect 1). A re-adopted run will not reproduce it.
- It also needs an append **between** step boundaries; appending while idle or at a transition is
  covered by the existing disk merge and looks fine.
- Defect 4's silent-drop path needs an appended step whose prompt text exactly matches an existing
  step — the failure is invisible otherwise.
- `WorkingFileManager.updateWorkingFileDirect:1888` is the merge that currently masks all of this by
  correcting the count one step transition late. Any test asserting the _proactive_ push must observe
  `STEPS_EXTENDED` before the next transition, not just the eventual count.
