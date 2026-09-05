# MCP Mid-Run Append — Sync and Identity Fixes

## Background

Discovered 2026-09-04 while an orchestrator step used `ctrlyoke_append_queue` to insert a
corrective step into its own running workflow — the spec-driven-loop shape, and the first time
anything had appended to a run _between_ step boundaries rather than at one.

The append itself worked: the run file was written correctly, `definitionRevision` incremented,
and `ctrlyoke_queue_status` reported the new step immediately. But `WorkflowStepsPanel` kept
showing the old step count for the rest of the running step. Navigating away and back flashed the
correct count, then reverted. The count corrected itself at the next step transition.

Nothing here is implemented. All line references below were verified against the tree at
`b1223284`.

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

|            | `definitionRevision`                                                                 | `descriptorRevision`                                          |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Lives in   | the run's `workflow.ctrlyoke.json` (`CtrlYokeTypes.ts:707-717`)                      | the lineage's `workflow.json` (`CtrlYokeTypes.ts:457-458`)    |
| Versions   | this run's step list                                                                 | descriptor metadata and run allocation                        |
| Bumped by  | `PromptQueue.bumpDefinitionRevision` (9 sites), `RunContinuationService.ts:271`      | `WorkflowLineageRepository` :270, :429, :451, :487            |

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

| #   | Defect                                                       | Effect                                                        |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| 1   | `promoteToNewRun` never re-points `PromptFileWatcher`        | the proactive push never fires at all                         |
| 2   | `PromptFileWatcher` registers no `onDidCreate`               | Windows `rename` writes missed even once #1 is fixed          |
| 3   | `SESSION_RESTORED` overwrites fresh disk state, unguarded    | the correct count flashes then reverts on remount             |
| 4   | `mergeDiskSteps` uses content hash as step identity          | an appended step with duplicate text is **silently dropped**  |
| 5   | `DashboardBroadcastHub.updateStepsExtended` drops `parallelGroups` | broadcast clients lose parallel-group topology          |

### 1. The watcher is pointed at the draft, not the run

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

### 4. Content hash as step identity — remove it

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

### 5. `DashboardBroadcastHub` drops `parallelGroups`

`IDashboardSink.updateStepsExtended` takes six parameters, the sixth being
`parallelGroups?: ParallelGroupDefinition[]` (`IDashboardSink.ts:159-166`).
`DashboardBroadcastHub.updateStepsExtended` (`:357-372`) declares **five** and forwards five, so
parallel-group topology is silently dropped for every broadcast client. `PostMessageDashboardSink`
(`:316`) and `CtrlYokeHostedServer` (`:612`) forward it correctly, so this affects the broadcast path
only.

**Fix.** Add the parameter and forward it.

**Worth recording as a convention gotcha:** `implements IDashboardSink` does **not** catch this.
TypeScript accepts a method with fewer parameters as satisfying a signature with more, so an arity
mismatch on a sink method is invisible to the compiler. The project's "make structural relationships
nominal" rule does not cover this case. When adding a parameter to an `IDashboardSink` method, every
implementation must be updated by hand — grep for the method name rather than trusting the build. If
this recurs, consider a single options-object parameter, which _would_ be checked.

---

## Sequencing

1. **Defects 1 + 2 together** — re-point the watcher on promotion, add `onDidCreate`. This is the
   actual fix for the reported symptom and restores the proactive push. Neither works alone.
2. **Defect 5** — one-line forward, no dependencies, do it whenever.
3. **Defect 4** — replace hash identity with index-based `_runtime` merge in `mergeDiskSteps`, and
   remove the `validatePrompts` completed-text rejection. Independent of 1–2, and worth doing even if
   1–2 slip: the disk merge at the next step transition is the safety net that currently makes the
   count self-correct, and this defect is a hole _in that safety net_.
4. **Defect 3** — the `SESSION_RESTORED` guard. Largest blast radius (it touches every remount and
   every hosted-client rebind, not just the MCP path), so land it last and on its own.

Defects 1–2 and 4 are the ones that matter for MCP mid-run appends. Defect 3 is a real bug on its own
terms that this investigation happened to surface.

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
