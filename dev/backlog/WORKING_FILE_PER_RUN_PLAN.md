# Working File Per Run — Run-Scoped Workflow Definitions

Status: **Phases 1 (1a/1b/1c), 2, 3, and 4 implemented.** Per-client view addresses, unified run-view snapshots, stable-ref selection/deletion, viewed-address save/template export, live-message isolation, recent-workflow actions, terminal summaries, completion identities, hosted routes/persisted selection, stable search navigation, address-bound cache re-baselining, multi-client coverage, and timeline-only response reconstruction are implemented and validated. Phase 3's draft/rewind/append, addressed webview, CLI, MCP, retention, deletion, and acceptance-matrix work is complete; see the "Phase 3" section below for exact results. **Also found and fixed a pre-existing phase 1b/1c bug**: `PromptQueue.loadPrompts()` was silently dropping `workflowKey`/`runRef`, which meant every fresh `loadPromptFile`/CLI `run` execution since phase 1b never actually promoted into a run directory — worth independent manual verification.

Constraint: **pre-release, zero backward compatibility.** The implementation replaces the old layout and contracts outright. It must not ship dual reads, mirrored writes, legacy path fallbacks, or deprecated message/settings aliases. Existing developer data may be converted once with the throwaway script described below.

## Goal

Make a run the durable unit of workflow definition and output so that:

1. the steps, editor, settings, and output always describe the same viewed run;
2. a completed run can be re-run from its exact definition;
3. a suffix of any idle run can be rewound, edited, and continued into the same run, preserving the existing “Set step as start position” behavior and resumable harness sessions;
4. new steps can be appended to an old run without losing its resumable harness sessions;
5. controls have an explicit run target; and
6. storage, locks, search, CLI, MCP, recovery, and hosted navigation use stable workflow/run identities rather than reconstructing identity from a mutable file path.

## Verified current architecture

- `.ctrlyoke/.working/<slug>-<createdTs>.ctrlyoke.json` is the mutable singleton. `WorkingFileManager` is its only writer.
- `.ctrlyoke/.history/<workflowId>/run-<timestamp>/manifest.json` and `events.jsonl` store output, but not the definition that produced it. `TimelineRecorder` owns serialized timeline writes.
- `history.saveOutput` can disable history completely. That is incompatible with a run directory being the persistence unit.
- `PromptQueue.restart()` strips step `_runtime`; the singleton therefore describes only the newest execution state.
- `PromptQueue.setStartPosition(k)` intentionally has different run semantics at the boundary: rewinding to `k > 0` clears `_runtime` and results for the suffix, then Continue appends new attempts to the same history run; rewinding to `k === 0` makes the next Run initialize a new history run. This partial-rerun workflow is common and must survive the refactor for latest and historical runs. Verified mechanism: `setStartPosition` archives+strips `_runtime` for `[k, end)`, sets those results `PENDING`, sets `currentIndex = k`, and calls `stateMachine.reset()` (→ `IDLE`); the run boundary is then decided solely by `WorkflowInstance.executeLoadedPromptFile`'s `isIdleContinuation`, which requires `prevQueueState.currentIndex > 0`. So `k > 0` reuses the latest history run and `k === 0` allocates a fresh one.
- `setStartPosition` is guarded only against `RUNNING`, `PAUSING`, and `CANCELLING`. **`PAUSED` is permitted today**, so pause → rewind → continue is an existing supported flow, not an edge case.
- `PromptQueue.runtimeArchive` retains the stripped `_runtime` in memory keyed per step, and `syncStepsForUndoRedo` restores from it. It is what makes definition undo after a rewind (or delete/reinsert) recover session metadata rather than silently dropping it.
- `WorkflowInstance` owns one `PromptQueue`, watcher, execution runtime, and active history file. `WorkflowOrchestrator` owns one shared instance per loaded lineage, but multiple dashboard clients can view that same instance.
- History selection is client-local today: `LOAD_RUN_HISTORY` returns output only to the requesting client. Rebinding the shared queue during a history switch would leak one client's selection into other clients and could redirect a running executor, watcher, lock, or MCP process to the wrong run.
- `workingFilePath` is also used by recent-workflow rows, active-terminal matching, completion notifications, save/template export, workspace session recovery, hosted routes, persisted webview selection, undo-record lookup, CLI watch, harness process keys, and `CTRLYOKE_WORKING_FILE`.
- Run indices are volatile: inserting, pruning, or deleting a run changes the index. Search results and navigation currently persist that volatile index.
- `CliWatchSession` follows the newest history directory instead of the exact run named by the active CLI lock.
- Manifest `runId` allocation is count-based. It can reuse a display number after deletion.
- Run directory names have millisecond precision but creation is not exclusive, so two initializations in the same millisecond can overwrite one directory.
- The runner-lock write is not a sufficient exclusive-acquire primitive, and heartbeat/release do not prove ownership. A stale process could update or remove a successor's lock.
- `_runtime.responseText`, script output, and final-step response arrays duplicate timeline data, but the timeline does not yet contain every structured value needed to replace those fields safely.
- The webview has two unrelated undo systems: zundo for definition edits and timeline `UndoRecord`s for workspace file changes. Both currently resolve through the singleton/current-latest path.

## Non-negotiable invariants

1. A **workflow lineage** has one stable `workflowKey` and zero or more runs.
2. A **run** has one stable `RunRef`, one current definition head, an immutable sequence of executed definition revisions, one manifest, and one event log.
3. At most one run in a lineage executes at a time.
4. Client view state is independent from execution state. Viewing run N must never rebind an executor running run M.
5. Every mutation is addressed by `{ workflowKey, runRef | draft }`; run indices are display/navigation conveniences only.
6. A committed definition revision is immutable, but a run may deliberately advance its definition head in place in two ways: append a tail, or rewind from a start index greater than zero and replace that suffix. Rewinding from step zero always seeds a new run.
7. `WorkingFileManager` remains the only writer of `workflow.ctrlyoke.json`. `TimelineRecorder` remains the only writer of `manifest.json` and `events.jsonl`.
8. History is always on. A valid promoted run always has all three run artifacts.
9. `CTRLYOKE_WORKING_FILE`, harness process keys, the prompt watcher, and the runner lock always refer to the executing run, never merely the viewed run.
10. All storage-derived paths are validated for workspace containment; no caller constructs `.runs` paths ad hoc.

## Identity and addressing

The current `workflowId` name conflates three identities. The refactor makes them explicit.

| Identity              | Meaning                                     | Lifetime and use                                                                                                   |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `WorkflowInstance.id` | Random UUID for one in-memory instance      | Retained for orchestrator registration, live dashboard routing, and terminal ownership.                            |
| `workflowKey`         | Stable lineage directory name               | Used by recents, recovery, routes, search, CLI/MCP, lineage lookup, and locks.                                     |
| `RunRef`              | Stable promoted-run directory name          | Used by run loading, mutation, deletion, search hits, output events, and CLI/MCP selectors.                        |
| `draft`               | Mutable next-run definition, not a `RunRef` | Used before first execution or while preparing a fork. It never appears in run summaries/history search.           |
| manifest `runId`      | Monotonic human-facing ordinal              | Display only. It is never accepted as durable storage identity without resolving it to a `RunRef` at request time. |

Use branded or opaque types rather than interchangeable strings:

```ts
type WorkflowKey = string & { readonly __workflowKey: unique symbol };
type RunRef = string & { readonly __runRef: unique symbol };

type WorkflowViewAddress =
  | { workflowKey: WorkflowKey; kind: "draft" }
  | { workflowKey: WorkflowKey; kind: "run"; runRef: RunRef };

interface WorkflowRunAddress {
  workflowKey: WorkflowKey;
  runRef: RunRef;
}
```

`WorkflowInstance` gains a fixed `workflowKey` and an `executionRunRef?: RunRef`. It does **not** gain a client-driven `boundRun`. The instance queue, watcher, execution context, live integrations, and harness environment bind only to `executionRunRef` (or the draft while idle and editing before promotion).

`WorkflowOrchestrator` keeps per-client view addresses alongside the existing UUID registry. A run switch updates only the requesting client's view address and sends that client a run snapshot. It never calls `PromptQueue.restoreFromWorkingFile()` on the shared execution queue merely to browse history.

## Canonical path module

Add a VS Code-free `src/utils/WorkflowPaths.ts` as the only authority for layout, validation, parsing, and containment:

```ts
WorkflowPaths.runsRoot(workspaceRoot);
WorkflowPaths.lineageDir(workspaceRoot, workflowKey);
WorkflowPaths.descriptorPath(workspaceRoot, workflowKey);
WorkflowPaths.draftDir(workspaceRoot, workflowKey);
WorkflowPaths.draftFilePath(workspaceRoot, workflowKey);
WorkflowPaths.runDir(workspaceRoot, workflowKey, runRef);
WorkflowPaths.runFilePath(workspaceRoot, workflowKey, runRef);
WorkflowPaths.manifestPath(workspaceRoot, workflowKey, runRef);
WorkflowPaths.eventsPath(workspaceRoot, workflowKey, runRef);
WorkflowPaths.runnerLockPath(workspaceRoot, workflowKey);
WorkflowPaths.parseRunFilePath(workspaceRoot, filePath);
WorkflowPaths.parseRunArtifactPath(workspaceRoot, filePath);
WorkflowPaths.assertValidWorkflowKey(value);
WorkflowPaths.assertValidRunRef(value);
```

Rules:

- `workflowKey` remains a sanitized name plus creation timestamp, with an exclusive lineage-directory create and suffix retry for collisions.
- `RunRef` remains the run directory name (`run-<UTC timestamp with milliseconds>`). Allocation occurs under the lineage metadata lock: reserve a uniquely named hidden staging directory, choose an absent final name, and promote with a no-overwrite rename. If the final name appears before promotion, advance/retry the timestamp. This preserves the existing sortable timestamp grammar without exposing an empty “reserved” run.
- Validators reject separators, traversal, empty/dot segments, platform-reserved names, unexpected extensions, and paths outside the resolved `.ctrlyoke/.runs` root. Windows comparisons are case-insensitive.
- Directory scans accept only valid direct-child lineage/run directories and ignore descriptor files, `draft`, locks, temp entries, search-index data, and symlinks.
- Delete `OutputHistoryManager.extractWorkflowId()`. Callers that already hold an instance/address use it directly; recovery-only callers parse with `WorkflowPaths`.
- Remove `PATH_CONSTANTS.WORKING_DIR` and `PATH_CONSTANTS.HISTORY_DIR`. Add only the `.runs` root constant; every deeper join goes through `WorkflowPaths`.
- `src/mcp-server.ts` may import this module because it is Node-only and VS Code-free; remove its rogue `.working` duplicate without pulling extension-only code into the MCP entrypoint.

## Storage model

```text
.ctrlyoke/.runs/<workflowKey>/
  workflow.json
  runner.json                         # only while an execution owns the lineage
  draft/
    workflow.ctrlyoke.json            # optional mutable next-run definition
  run-<timestamp>/
    workflow.ctrlyoke.json            # definition + resumable runtime for this run
    manifest.json                     # authoritative lightweight run summary
    events.jsonl                      # append-only output/timeline
    pending-rewind/                    # only while a nonzero rewind is being edited
      base.ctrlyoke.json               # pre-rewind recovery snapshot
```

### Lineage descriptor

`workflow.json` is authoritative for lineage metadata and allocation state:

```ts
interface WorkflowLineageDescriptor {
  schemaVersion: number;
  workflowKey: WorkflowKey;
  workflowName: string;
  originalFile?: string;
  isFavorite: boolean;
  createdAt: number;
  lastModifiedAt: number;
  latestRunRef?: RunRef;
  nextRunId: number;
  pendingEdit?:
    | { kind: "draft" }
    | {
        kind: "rewind";
        runRef: RunRef;
        fromStepIndex: number;
        baseDefinitionRevision: number;
      };
  revision: number;
}
```

- Do not duplicate `originalFile`, favorite state, or current lineage name in every run definition. Export/recents read the descriptor.
- `latestRunRef` is a repairable hint, not the storage source of truth. Readers validate that it exists; if not, they scan manifests, repair it atomically, and continue.
- `nextRunId` is monotonic and never decremented after deletion. Recovery repairs it to `max(existing manifest.runId) + 1` if necessary.
- `lastModifiedAt` changes for draft/run definition mutations, append/execution activity, rename, and favorite changes. Workspace auto-load sorts descriptors by this value.
- `pendingEdit` makes the one mutable preparation target per lineage explicit, protects it from deletion/pruning, and lets recovery reopen or discard an interrupted rewind. Preparing a normal rerun uses `draft`; preparing a same-run partial rerun uses `rewind`.
- `revision` supports optimistic concurrency for descriptor metadata and allocation changes. It is distinct from definition revision below.

### Run definition

The run file retains the current executable workflow fields and resumable `_runtime` during phases 1–3 and adds a top-level `definitionRevision`. A pending same-run rewind also persists `{ fromStepIndex, baseDefinitionRevision }` in run runtime so a restart cannot mistake unexecuted edits for a completed definition revision. Lineage-only metadata moves to the descriptor. Manifest timestamps/state are authoritative for run-list metadata.

`WorkingFileManager` increments `definitionRevision` for each definition change (draft edit, appended tail, rewind, or edit inside a rewound suffix), not for ordinary runtime persistence. Definition-changing commands include the expected definition revision and fail with a conflict response if it changed. Descriptor mutations independently use the expected descriptor revision.

Outside an explicit append or rewind mode, generic edit/add/delete/reorder/property changes against a promoted run create/update a draft seeded from that run.

“Set step as start position” is the deliberate same-run exception:

- `toIndex === 0`: do not mutate the selected run. Seed a draft/new run with execution runtime stripped; pressing Run promotes and executes the new `RunRef`.
- `toIndex > 0` on an idle completed/stopped/error run: first have `WorkingFileManager` atomically copy the full current run file to `pending-rewind/base.ctrlyoke.json`; then preserve the prefix `[0, toIndex)`, archive and clear `_runtime`/results for `[toIndex, end)`, set the pending rewind marker, and keep the same `RunRef` and numeric `runId`.
- While a rewind is pending, step-local edit/add/delete/reorder operations are permitted only inside the suffix. Workflow-level properties and prefix steps remain locked because changing inherited settings would retroactively misdescribe the preserved prefix; those changes require a draft/new run.
- **Rewind is permitted from `PAUSED` as well as idle terminal states**, matching today's guard (blocked only for `RUNNING`, `PAUSING`, `CANCELLING`). A paused lineage still owns the lock, sessions, and PTY, so a paused rewind targets its own executing run only: the run stays the execution target, the lock and `CTRLYOKE_WORKING_FILE` never move, and Continue resumes into the same `RunRef`. Rewinding a _different_ run while another is paused remains blocked. Losing pause → rewind → continue would be a user-facing regression against goal 3.
- **`runtimeArchive` and the durable base snapshot are one rollback story, not two.** `pending-rewind/base.ctrlyoke.json` is the process-crash-durable form of what `runtimeArchive` holds in memory. Definition undo inside a pending rewind must not resurrect suffix `_runtime` from the archive: restoring a suffix step's session/response metadata would re-associate it with attempts whose committed `definitionRevision` no longer describes it. Rule: while a rewind is pending, archive restoration is suppressed for indices `>= fromStepIndex`; undo there restores step text/settings only. Discarding the rewind is the sole path that restores full suffix runtime, and it does so from `base.ctrlyoke.json` through `WorkingFileManager`, not from the in-memory archive. Prefix indices retain today's archive behavior.
- Continue commits the final suffix definition revision before executing it, preserves prefix sessions/output, appends new attempts to the same `events.jsonl`, then removes the recovery snapshot after the commit is durable. Discard restores `base.ctrlyoke.json` through `WorkingFileManager` and removes the pending marker/snapshot.
- Skip-ahead within an incomplete run retains today's same-run skipped-step behavior and is recorded as a definition/runtime transition.

Every execution-capable definition revision is snapshotted in a `DEFINITION_REVISION_COMMITTED` timeline event before any output for that revision. The snapshot contains the execution-relevant workflow definition with transient runtime removed, plus `definitionRevision`, the rewind boundary (if any), and the prior revision. Output events carry the `definitionRevision` that produced them. This keeps earlier attempts auditable even after the run's current definition head changes; the temporary full-runtime base file exists only for rollback/recovery and is not historical truth.

### Manifest and summary

Standardize one manifest field set rather than retaining both `runStepCount` and `stepCount`:

```ts
interface RunSummary {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runId: number;
  startedAt: number;
  completedAt?: number;
  executionState: ExecutionState;
  definitionRevision: number;
  stepCount: number;
  primaryHarness?: HarnessName;
  primaryModel?: string;
  hasMixedHarnesses: boolean;
  hasMixedModels: boolean;
}
```

- `primaryHarness`/`primaryModel` come from the first enabled AI step's effective settings. The mixed flags prevent one icon/model label from implying that all steps used the same configuration. Script-only runs omit harness/model. `stepCount` means queue-step count; the final step remains a separately identified phase as it is today.
- The manifest is updated on every authoritative execution-state transition, not only initialize/finalize, so manifest-only run lists correctly show paused, pausing, cancelling, stopped, error, and completed states.
- Append or nonzero rewind continuation reopens the same manifest: clear `completedAt`, update `definitionRevision`/`stepCount`, set the transition state, append events, and finalize again. `runId`, `runRef`, and `startedAt` do not change.
- `getRunSummaries(workflowKey)` reads manifests only, returns newest first, and treats malformed/incomplete directories as recovery candidates rather than valid rows.

### Artifact ownership and atomicity

Add a `WorkflowLineageRepository` (or equivalently named orchestration service) to coordinate lineage lifecycle. Ownership remains strict:

- `WorkflowLineageRepository`: descriptor reads/writes, allocation, draft/run lifecycle, listing, deletion, retention, and recovery.
- `WorkingFileManager`: definition-file reads/writes only.
- `TimelineRecorder`: manifest/event initialization and all subsequent timeline writes.
- `RunOutputResolver` (phase 4): read-only event projection.

Creating/promoting a run is staged in a hidden `.creating-*` sibling directory. The repository asks the two artifact owners to populate it, fsyncs/closes their writes, then atomically renames it to the final `RunRef`. Only after the rename does it update the descriptor. Draft promotion copies rather than moves until the final directory is visible; the draft is removed after descriptor commit. Recovery reconciles a crash between those steps without exposing a partial run.

Descriptor writes use temp-file + rename under a short lineage-metadata lock. The descriptor and run directory cannot be one filesystem transaction, so code must not claim they are atomic together; directory enumeration plus repair is authoritative.

## Execution state versus client view state

The backend exposes a read model for a client-selected address:

```ts
interface WorkflowRunView {
  address: WorkflowViewAddress;
  descriptorRevision: number;
  definitionRevision: number;
  definition: PromptFile;
  runtime: WorkingFileRuntime | null;
  output: WorkflowOutputHistory;
  summary?: RunSummary;
  runSummaries: RunSummary[];
  executingRunRef?: RunRef;
  pendingRewind?: {
    fromStepIndex: number;
    baseDefinitionRevision: number;
  };
  editable: boolean;
}
```

The view loader reads the selected definition and output without mutating the shared `PromptQueue`. For the executing run it may merge the persisted timeline with the instance's `OutputCaptureBuffer` so a switch during streaming does not lose unflushed chunks.

An explicit mutation/execution action is different from browsing. When the lineage is idle and a client starts a nonzero rewind, append, resume, or continue against historical run N, the orchestrator validates the addressed revision, establishes N as the instance's execution target, and only then restores/binds the execution queue to N. Other clients' view addresses do not change. A plain `LOAD_RUN_VIEW` can never perform this binding.

All live run-scoped dashboard messages include `workflowKey` and `runRef` in addition to the instance UUID. The webview applies a message to the displayed definition/output only when both the lineage and run match. If another run is executing in the background, the client may update a lightweight status/unread indicator, but it must not contaminate the viewed run.

The webview stores one unified displayed `WorkflowRunView`; it does not keep a definition from the live queue plus a separate `historyOutputs` overlay. Switching lineage/run replaces definition, runtime, output, and summary together and explicitly clears/re-baselines:

- zundo past/future states and any runtime merge cache;
- pending step/property edits;
- selected step/output target and streaming chunks;
- workspace-file undo/redo presentation; and
- stale save-path and run-action requests.

Ignoring unrelated live messages is safe because switching back loads an authoritative backend snapshot.

## User-visible action semantics

| Action while viewing address N               | Lineage idle                                                                                                                                         | Lineage executing run M                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| View steps/settings/output                   | Shows one coherent snapshot for N.                                                                                                                   | Same; N may differ from M.                                                                                                                     |
| Generic edit of a promoted run               | Fork/update a draft seeded from N, then switch this client to the draft.                                                                             | Draft preparation is allowed only if it cannot affect M's queue/harness state; otherwise return a revision/busy conflict. M remains untouched. |
| Set start position to step 1 (`index === 0`) | Seed a draft/new run from N; leave N unchanged. Run executes the new `RunRef`.                                                                       | Draft may be prepared, but launch waits until M terminates.                                                                                    |
| Set start position to step K (`index > 0`)   | Enter same-run rewind mode for N: preserve the prefix, clear suffix runtime/results, and permit suffix-only edits. Continue appends attempts to N.   | Blocked for every N while M executes; browsing remains allowed.                                                                                |
| Resume unchanged pending work                | Resume N only if N is stopped/paused and owns resumable runtime.                                                                                     | Blocked unless N is M and the action is valid for M's state.                                                                                   |
| Append + continue                            | Atomically append new tail steps to N, commit a definition revision, reopen N, and continue its sessions. Existing prefix is preserved.              | Blocked when N is not M. Appending to M while paused follows the existing safe pause/append rules.                                             |
| Run / Re-run                                 | Draft: promote and launch. Promoted run without a pending rewind: seed a new run from N with execution runtime stripped. Pending rewind: Continue N. | Blocked by the single-execution rule.                                                                                                          |
| Harness/model override for re-run            | Applied to the draft/new run before promotion. Step-local overrides inside a rewound suffix apply only to that suffix revision.                      | May be prepared in a draft, but launch waits until M terminates.                                                                               |
| Pause/Stop                                   | Disabled when nothing executes.                                                                                                                      | Always targets M and labels that target explicitly even when viewing N.                                                                        |
| Save / Save as template                      | Exports the viewed definition head through the existing sanitizing serializer.                                                                       | Same; never exports M merely because M is executing.                                                                                           |
| Definition undo/redo                         | Scoped to the current draft or pending-rewind suffix editing session. Re-baselined on every address switch.                                          | Disabled for a read-only run view; draft edits remain client/revision scoped.                                                                  |
| Workspace-file undo/redo                     | Reads/writes timeline records for the explicitly viewed/executing run and output target.                                                             | Never falls back to “latest.”                                                                                                                  |

Appending or partially rewinding a completed run preserves previous events and resumable prefix session metadata. It clears only the selected suffix runtime and terminal completion markers needed to reopen execution. If a final step already ran, the final phase runs again after the new suffix/tail; its next `loopIndex` is allocated after the maximum existing final-step loop index so old output addresses are never reused or overwritten. Queue-step attempt indices likewise continue after the maximum existing attempt for the target across the whole `RunRef`; `definitionRevision` identifies which definition produced each attempt.

The run view shows the current definition head. Older output attempts retain their committed definition revision and recorded prompt/settings, so changed or removed suffix steps are not falsely presented as having been produced by the new text. The output UI groups attempts under the current step when the revision mapping is still compatible and otherwise labels them as an earlier revision.

When a rewind is pending, every client viewing that run receives an address/revision invalidation and reloads the pending head. The UI keeps prefix steps locked, visually marks the rewind boundary, shows “Continuing run N from step K,” and presents **Continue** rather than **Run/Re-run**. “Set start position” remains available on any idle historical run under the same state rules as the latest run.

### Discard-continuation UX

A pending rewind is durable state that survives restart, so it needs an explicit exit. Today no such command exists — the current rewind commits immediately to the single working file and the de-facto undo is Ctrl+Z restoring `runtimeArchive`. **Discard is therefore a new run-lifecycle command.** It is unrelated to `EditorFooter`'s Cancel, which only exits per-step edit mode; do not overload that control or reuse the word “Cancel” for it.

- **Primary affordance:** a pending-continuation banner modeled on the existing `isPausing` banner in `Header.tsx` (same placement directly under the header, same inline secondary-action pattern). It reads “Continuing run N from step K” and carries **Discard Continuation** plus **Start new run instead** as inline actions.
- **Header:** the execution group stays exactly three slots. Discard is _not_ added to it — that group is `aria-label="Workflow execution controls"` and means Run/Pause/Stop at every tier and on mobile; a mode-exit is not an execution control. See the control matrix below.
- **Context menu:** add **Discard Continuation** to the boundary step's menu, next to the existing “Set Start Position” item (`useStepContextMenu` already models `direction: "rewind" | "forward"`).
- **Recovery:** the startup “reopen or discard” prompt for an interrupted rewind invokes this same command; there is one discard implementation, not a separate recovery path.

Undo interaction — **beginning a rewind is a zundo barrier, not an undoable edit.** Because archive restoration is suppressed for indices `>= fromStepIndex`, an ordinary undo across the rewind boundary would produce a half state (restored text, still-cleared runtime). Re-baseline the undo stack when the rewind begins, exactly as on an address switch: undo inside the mode covers suffix edits only, undo at the mode's baseline is a no-op, and Discard is the sole exit back to the pre-rewind definition and runtime.

### Header execution-control matrix

Today's three slots are derived by `getWorkflowExecutionControls`: slot 1 Run/Re-run (`isRerun = isCompleted || isError || isPaused || isStopped` swaps the icon to `codicon-refresh` and bolds it), slot 2 Pause/Resume (`canResume = isPaused || isStopped || isError || isIdleWithOffset`), slot 3 Stop (`canStop` — running/pausing/paused/cancelling only).

Two facts about today's post-rewind state drive the target design. After `setStartPosition(k > 0)` the state machine resets to `IDLE` with `currentStep = k`, so `isRerun` is **false**: slot 1 renders as plain **Run** with the play icon, not the re-run refresh icon. And because `isIdleContinuation` only requires `IDLE && currentIndex > 0`, both slot 1 (Run) and slot 2 (Resume) continue into the **same** history run — the play icon implies a fresh start that does not happen. There is currently no one-click “start a new run number” from a rewound state; the only route is rewinding to step 1 first, which resets `currentIndex` to 0 and makes the next Run allocate a fresh run. Removing that ambiguity is a goal of this work, not a regression to preserve.

Target slot behavior, keeping the three-slot anatomy intact:

| Viewed address / lineage state              | Slot 1                                                        | Slot 2                                   | Slot 3                 |
| ------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------- | ---------------------- |
| Draft, never executed                       | **Run** (play) → promote draft to a new `RunRef`              | disabled                                 | disabled               |
| Promoted run, lineage idle, no pending work | **Re-run** (refresh, bold) → seed a **new** run from this run | disabled                                 | disabled               |
| Promoted run with resumable pending work    | **Re-run** (refresh, bold) → new run                          | **Resume** → continue this run           | disabled               |
| Pending rewind on run N                     | **Continue** (`codicon-debug-continue`, bold) → same run N    | disabled (resume is slot 1 in this mode) | disabled               |
| Lineage executing M, viewing M              | disabled                                                      | **Pause / Cancel pause**                 | **Stop**               |
| Lineage executing M, viewing N ≠ M          | disabled, tooltip names M                                     | **Pause**, labeled as targeting M        | **Stop**, labeled as M |

So Re-run remains exactly one button, and it becomes unambiguous: on any promoted run it always allocates a new `RunRef`/`runId`, including on an older run, where it seeds from that run's definition. The only state where slot 1 is not Re-run is the pending rewind, because that mode exists precisely to continue run N — and its banner still offers **Start new run instead** as a one-click escape, which discards the pending rewind and seeds a new run in a single action. Slot 2 is never overloaded with a re-run meaning; where resume is unavailable it stays disabled, as it does today.

Confirmation follows what is actually at risk. Discarding an unedited rewind only restores what was cleared, so it needs no prompt. Discarding after suffix edits destroys authored text, so prompt when `definitionRevision > baseDefinitionRevision`, gated by `confirmDeleteOperations` (losing authored steps is a delete, not a start-position reset). Entering a rewind keeps its existing `confirmResetOperations` gate.

Deleting a run is rejected while it is executing, has a pending rewind, or is the source/target of an in-flight seed/append transaction. Deleting a viewed run broadcasts invalidation; each affected client falls back to the current draft, otherwise the latest remaining run, otherwise unloads the deleted lineage. Deleting the last run removes the lineage only when no draft remains. “Remove workflow history” becomes an explicit delete-lineage operation.

## Message, navigation, search, and summary contracts

This is a breaking contract update; do not keep old path/index fields as aliases.

- `READY.preferredWorkingFilePath` → `preferredWorkflowKey`.
- `activeWorkflowWorkingFilePath` → `activeWorkflowKey` in persisted UI state.
- Hosted/browser routes use `workflowKey` and optional `runRef`; they never expose a workspace-local working-file path.
- `LOAD_WORKFLOW` accepts `workflowKey`. `LOAD_RUN_HISTORY`/`OUTPUT_HISTORY_LOADED` become run-addressed `LOAD_RUN_VIEW`/`RUN_VIEW_LOADED` messages carrying the unified view above.
- Run load/delete/re-run/append/set-start-position/continue/save/template/undo requests carry a stable `RunRef` or `draft` address. `SET_START_POSITION` also carries `toIndex` and the expected definition revision. They do not carry `runIndex` as the target.
- Beginning, editing, discarding, or committing a rewind broadcasts a run-view invalidation with the new `definitionRevision` to all clients viewing that `RunRef`; clients reload instead of applying suffix mutations to a stale local definition.
- Search documents/results store `{ workflowKey, runRef, target }`; pending navigation keeps the same stable address. Search may show `runId`, but it never reconstructs `.working` paths.
- Recent-workflow rows are keyed by `workflowKey` and include `latestRunRef`; favorite/remove/load operations use the key.
- Active-terminal summaries include `workflowKey` and `runRef`. UUID remains the live terminal/instance routing identifier.
- Completion notifications derive the display name from the lineage descriptor, not `path.basename(workingFilePath)`.
- `WorkflowSummary` replaces user-facing/path-dedup `workingFilePath` with `workflowKey`, `viewedRunRef`, and `executingRunRef` as appropriate. Internal execution contexts may retain a run file path where a process genuinely needs it.

The run switcher keeps previous/next shortcuts and adds a RecentWorkflows-style dropdown backed by `RunSummary`. Extract shared row cells (harness icon, name/count, state badge, time) instead of duplicating row markup. The displayed run label uses manifest `runId`, so deletion gaps remain visible and new runs never renumber old ones.

## Save and template export

Save remains export, not an implicit mutation of the lineage:

- Resolve the definition from the requesting client's `WorkflowViewAddress`, not the instance queue.
- Default to descriptor `originalFile`; otherwise derive a safe filename from the descriptor name.
- Apply the existing runtime-stripping allowlist to both Save and Save as template.
- Frame the dialog as “Save draft” or “Save run N (<date>)”.
- Add `CHECK_SAVE_PATH { requestId, path }`; validate with the same workspace/path rules used by the final save and ignore stale responses.
- Show a non-blocking overwrite warning as the user edits. The final save handler still rechecks the target immediately before writing.

## Locks, concurrency, and recovery

### Execution lock

`runner.json` is lineage-scoped and contains at least:

```ts
interface WorkflowRunnerLock {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  runner: "extension" | "cli";
  pid: number;
  ownerToken: string;
  instanceId?: string;
  startedAt: number;
  lastHeartbeat: number;
}
```

- Acquire uses an OS-exclusive create (`wx`/equivalent) followed by stale-owner validation and a bounded retry; temp rename alone is not exclusive acquisition.
- Heartbeat and release compare `ownerToken`. An old process cannot refresh or unlink a successor's lock.
- Extension and CLI use the same acquire path. Remove the current duplicate CLI + `WorkflowInstance` acquisition; exactly one layer owns acquire/heartbeat/release.
- A lock identifies the exact executing `runRef`. `CliWatchSession` watches that run's definition/events and never follows “newest.”
- Stale-lock recovery repairs only the run named in the stale lock, then removes it with ownership checks. Lineage scans replace the current flat `.working/*.ctrlyoke.json` scan.

### Short metadata mutations

Descriptor allocation/update, draft promotion, retention, and deletion use a separate short-lived lineage metadata lock. Define and test one lock order (metadata lock before definition-file lock when both are needed) and never hold it while waiting for harness execution or streaming events.

Each mutation includes the relevant expected descriptor and/or definition revision. UI, extension, CLI, and MCP surface a deterministic conflict rather than last-write-wins data loss.

### Recovery

On startup/recent-list load:

1. enumerate valid lineage directories;
2. parse descriptors independently so one corrupt lineage cannot abort the list;
3. reconcile/remove stale `.creating-*` entries;
4. validate `latestRunRef` and `nextRunId` against valid manifests;
5. validate `pendingEdit`; for a rewind, require the addressed run, pending marker, and `pending-rewind/base.ctrlyoke.json`, then reopen the edit or offer discard. Repair a half-cleared commit from the durable definition-revision event, and restore/quarantine inconsistent state rather than guessing;
6. normalize the exact stale-locked run to stopped/error as current semantics require;
7. exclude malformed partial runs and log an actionable warning; and
8. auto-load the valid lineage with the greatest descriptor `lastModifiedAt`.

## Always-on history and retention

Always-on history is a phase-1 storage invariant, not a phase-4 cleanup:

- Remove `history.saveOutput`, `OutputHistoryManager.isHistoryEnabled()`, and all empty-history-path branches in phase 1.
- Rename settings `history` → `runs` in `schemas/settings-schema.json`, `CtrlYokeSettings`, `ConfigurationUtils`, settings sync, General settings UI, fixtures, and tests.
- Keep `runs.maxRuns`, default `-1`. Its description must say: “Deletes entire runs—definition and output—oldest first. -1 keeps all runs.”
- Pruning allocates by stable `RunRef`, runs only after the new run is safely visible, and explicitly excludes the executing run, a run with a pending rewind, plus any source/target protected by an in-flight transaction. It must not assume the executing, rewind, or append target is newest.
- If pruning deletes a client-viewed run, use the same invalidation/fallback behavior as manual deletion.
- Search-index removal/flush occurs before the run directory is deleted. Descriptor hints are repaired afterward.

Update `.gitignore`, `.ctrlyoke/.gitignore`, `WorkspaceInitializer.GITIGNORE_CONTENT`, initializer tests, `.github/copilot-instructions.md`, and the generated tech-support agent template to describe `.runs`. Current user docs that teach inspection/troubleshooting of `.working`/`.history` must be updated in the same implementation. Historical design documents need not be rewritten.

## CLI and MCP contract

Keep source-based CLI behavior and add explicit lineage operations:

```text
ctrlyoke run [file] [--prompt <text>]                       # new lineage/draft → run
ctrlyoke rerun --workflow <key> [--from <ref|runId>]        # default source: latest
ctrlyoke append --workflow <key> --run <ref|runId>
                ([file] | --prompt <text>)                  # append tail and continue
ctrlyoke continue --workflow <key> --run <ref|runId>        # unchanged pending work
```

`--from/--run` accepts a stable `RunRef` or a numeric display `runId` resolved once under the metadata lock. It does not accept volatile list indices. Existing harness/model CLI overrides apply to the newly seeded rerun only. Argument combinations are mutually exclusive and validated before any run allocation.

MCP rules:

- A harness-launched MCP server remains pinned by `CTRLYOKE_WORKING_FILE` to the exact execution run.
- Fallback/global discovery scans lineage locks and descriptors, returning at most one active run per lineage.
- Queue append/status/output tools return and accept `{ workflowKey, runRef }` where targeting is required.
- MCP append honors the lineage execution lock and append-prefix invariant; it cannot silently choose “latest” when another run is active.
- Phase 4 changes `read_output` to `RunOutputResolver`; it must not regress to `_runtime.responseText`.

## Response text single-sourcing (phase 4)

Do not delete persisted response fields until the timeline can reproduce all current semantics.

Building on the definition-revision events introduced in phase 1, extend the canonical event schema so it losslessly represents:

- the authoritative AI response for each queue/final target, loop, and retry/attempt;
- follow-up/resumed text appended after the initial result;
- structured script stdout, stderr, combined display response, exit code, and command metadata;
- failed, cancelled, and stopped results; and
- workspace `UndoRecord` updates.

Then add a streaming `RunOutputResolver` that selects the latest authoritative aggregate for a target without loading an unbounded `events.jsonl` into memory. It may stream and index offsets, but it must not truncate response semantics; the search index's document cap is not a valid prior-context source.

Update every response consumer, including:

- executor prior-context construction;
- `PriorContextPreviewBuilder` and `WebviewMessageRouter` preview requests;
- `CliPromptRuntimeCoordinator` and harness resume/recovery;
- MCP output reads;
- final-step loop handling;
- script output rendering/context; and
- save/sanitization/tests.

The response event must be durably committed before a following step builds prior context. On restore, hydrate only requested prior-context targets and cache them in memory for the active execution. Keep session IDs and other resume-critical runtime until a separate design proves they too can be derived.

Only after parity tests pass should persisted `_runtime.responseText`, `scriptOutput`, and `finalStep.responseTexts` be removed. This phase must not introduce a new response-size cap as an accidental behavior change.

## Implementation phases

Each phase leaves the repository internally consistent and shippable. No compatibility shims bridge phases.

### Phase 1 — Storage, identity, locks, and always-on runs

This is the largest phase and must not be attempted as one commit. Split it into three internally consistent checkpoints; each compiles, passes the suites, and leaves the app usable.

**Phase 1a — layout and identity (no behavior change).**

1. Add opaque identity/address types and `WorkflowPaths`, including collision, validation, parser, and containment tests.
2. Add `WorkflowLineageRepository`, descriptor schema, atomic staging/promotion, revisions, recovery, and artifact-ownership tests.
3. Move working/history artifacts into `.runs`; update `WorkingFileManager`, `TimelineRecorder`, `OutputHistoryManager`, `PromptFileLoader`, queue operations, session recovery, recents, search/index, serializer, undo coordinator, and cleanup paths.
4. Replace basename-derived identity in `WorkflowInstance`, `WorkflowOrchestrator`, extension, CLI, MCP, hosted server, notifications, harness integration, and lock code.
5. Write and run `dev/migrate-runs-layout.mjs` here — it is the first real exercise of `WorkflowPaths` and the descriptor against actual data.
6. Update gitignore/bootstrap instructions, current docs/templates, schemas, fixtures, and tests.

Checkpoint: identical user-visible behavior on the new layout. Grep gate must pass.

**Phase 1b — correctness primitives.**

1. Make locks exclusive and owner-token safe; pin CLI watch to lock `runRef`; remove duplicate acquisition.
2. Make history always on and rename the settings group to `runs`.
3. Standardize manifests and `getRunSummaries`; allocate monotonic `runId`; update every state transition and append reopen.

**Phase 1c — definition revisions.**

1. Add `definitionRevision`, commit the initial/current execution-definition snapshot before output, tag all output attempts with it, and advance it for today's append continuation.

Defer 1c only if phase 3 slips materially: nothing consumes revisions until rewind/re-run exists, but shipping 1c early means append attempts recorded between now and phase 3 are already auditable. Do not reorder 1c _after_ phase 3.

At phase end, the UI may still default to the latest run and use its current history presentation, but every backend operation already has a stable workflow/run address. There is no `boundRun` browsing behavior and no optional timeline.

### Phase 2 — Per-client coherent run views

1. **Implemented:** per-client `WorkflowViewAddress` registration and a unified run-view loader. `RUN_VIEW_LOADED` carries the selected definition, workflow properties, matching history projection, run summaries, and the current execution `RunRef`; it reads storage without restoring a historical definition into the shared execution queue.
2. **Implemented:** recent-workflow rows/actions carry `WorkflowViewAddress`; terminal summaries carry the exact execution `{ workflowKey, runRef }`; completion notification IDs/tags carry durable run identity; the run dropdown resolves its displayed index to a stable `RunRef`; hosted routes and persisted selection use stable addresses; and history-search navigation loads the selected `{ workflowKey, runRef }` directly.
3. **Implemented for addressed switches:** the webview applies the definition, settings, and output together, records the displayed address, and drops live workflow messages while the selected promoted run differs from the execution `RunRef`.
4. **Implemented:** address switching clears workflow-local edit/history caches, zundo history, live streaming/context state, workspace snapshots, and undo metadata before rehydrating the selected snapshot.
5. **Implemented:** the dropdown uses manifest-backed `RunSummary` identities and stable-ref deletion, then deterministically falls back to the newest remaining run or draft. UI indexes are presentation-only; all mutation and navigation handoffs use stable addresses.
6. **Implemented:** Save and Save as template resolve the viewed address. Save checks for an existing export target and asks before overwriting.
7. **Implemented:** multi-client coverage verifies distinct client view addresses remain independent while the execution target stays pinned to its exact `RunRef`.

Phase 2 validation: `npm test` passes (1,823 extension-host and 1,018 webview tests).

### Phase 3 — Draft editing, partial rerun, append, and targeted CLI/MCP

Tracked as 9 discrete deliverables (this list is the authoritative checkpoint breakdown — more granular than earlier phase summaries because each item is its own multi-file effort; a fresh session should work top to bottom, since later items build on earlier ones):

1. **[DONE]** Implement "Edit as draft"/automatic draft fork: outside an explicit append or rewind mode, generic edit/add/delete/reorder/property changes against a promoted (`kind: "run"`) address must create/update a draft seeded from that run instead of mutating the promoted run, with optimistic revision conflict handling. Needs a new webview↔extension message contract (nothing exists today — grepped, zero hits) plus a `WebviewMessageRouter` branch that detects "this edit targets a promoted run" and forks a draft first.
2. **[DONE]** Implement `seedNewRun(fromRunRef)` (execution runtime stripped, optional harness/model overrides) and its execution counterpart. See "Progress" below for exact detail.
3. **[DONE]** Generalize set-start-position to an explicit `RunRef`: index zero seeds a new run (via item 2's primitives) leaving the source untouched; a nonzero rewind creates a pending same-run definition revision — preserve the prefix `[0, toIndex)`, archive/clear the suffix `_runtime`/results, copy the full run to `pending-rewind/base.ctrlyoke.json`, set descriptor `pendingEdit = {kind:"rewind", runRef, fromStepIndex, baseDefinitionRevision}`, and permit suffix-only edits. Must preserve the existing PAUSED-rewind-targets-the-same-run behavior and keep `src/test/promptQueue.test.ts`'s existing `setStartPosition`/`syncStepsForUndoRedo` suites passing.
4. **[DONE]** Commit the rewound definition through phase 1's `DEFINITION_REVISION_COMMITTED` path; implement "Discard Continuation" (restores `base.ctrlyoke.json` via `WorkingFileManager`, clears `pendingEdit`, removes the snapshot) reachable from the pending-continuation banner, the boundary step's context menu, and startup recovery — one shared implementation, not three; suppress `runtimeArchive` restoration for suffix indices (`>= fromStepIndex`) during `syncStepsForUndoRedo` so undo can't resurrect stale suffix runtime; and make "begin rewind" a zundo re-baseline barrier (webview) so undo can't cross the rewind boundary.
5. **[DONE]** Generalize append/continue to an explicit `RunRef`: replace `WorkflowInstance`'s implicit "latest history file" inference (`isAppendContinuation`/`isIdleContinuation`/`getLatestHistoryFilePath`) with an explicit target; fix `computeTargetRunIndices` to also run for `isAppendContinuation` (currently explicitly excluded — appended steps start at attempt index 0 instead of continuing monotonically); add a `TimelineRecorder` manifest-reopen path (clear `completedAt`, bump `definitionRevision`/`stepCount`, set transition state, without resetting `eventCount`/`nextSequence`/`startedAt` — `updateManifest(...)` is already generic enough, it just isn't called this way anywhere yet).
6. **[DONE]** Webview UX and stable-address run actions: `RUN_VIEW_LOADED` explicitly carries `pendingRewind`; `uiStore` retains it only with the addressed snapshot. `Header.tsx`/`utils/status.ts` implement the exact three-slot matrix (draft Run, promoted Re-run, slot-2 Resume, pending-rewind Continue, and execution-targeted Pause/Resume/Stop); responsive tiers mount only one execution group. The pending-continuation banner has `Discard Continuation` and atomic `Start new run instead`; boundary-step context menus use the same discard command. New run lifecycle and runtime-control messages are stable-addressed and replace the instance-ID aliases: execute draft, seed/re-run, start-new-instead, continue, append-and-continue, pause/cancel-pause/resume/stop. Router confirmation/error paths are explicit and all continuation actions retain revision guards.
7. **[DONE]** Save/template export framing: `CHECK_SAVE_PATH {requestId, path}` provides a non-blocking as-you-type overwrite warning using the same workspace-contained, symlink-safe validation as final save. Save/template requests are address/request-correlated, stale responses are ignored, final save rechecks the address and destination immediately before writing, and dialog framing is "Save draft" / "Save run N (date)" / "Save run N — pending continuation" with descriptor-backed defaults.
8. **[DONE]** CLI: `rerun --workflow <key> [--from <ref|runId>]`, `append --workflow <key> --run <ref|runId> ([file]|--prompt <text>)`, and `continue --workflow <key> --run <ref|runId>` now use durable workflow/run addresses. `rerun` seeds through item 2; append/continue use item 5's exact target and intentionally expose no harness/model overrides. Numeric selectors are resolved through manifest summaries, never list positions.
9. **[DONE]** MCP: extend `ctrlyoke_queue_status`/`ctrlyoke_append_queue`/`ctrlyoke_read_output`/`ctrlyoke_global_status` to accept/return `{workflowKey, runRef}` (today every tool schema has zero workflow/run-selector fields — `mcp-server.ts`'s `findActiveWorkingFile()` already uses `WorkflowLineageRepository`/`WorkflowPaths` for discovery but resolves to a single file path, never a `{workflowKey, runRef}` pair the caller can target); make `ctrlyoke_append_queue` honor the lineage execution lock and append-prefix invariant instead of only the raw per-file lock it uses today.
10. **[DONE]** Audit and complete the retention/deletion races plus the full "Actions"/"UI and contracts" acceptance matrix. Focused coverage now includes draft/source isolation, index-zero seed behavior, historical/PAUSED rewind targeting, append/final-loop monotonicity, discard recovery and undo barrier, three-slot controls, stale save responses, search-document cleanup, finite retention with gaps/old protected targets, and deterministic multi-client invalidation.

Process note for whoever picks this up: after finishing an item, update its `[DONE]`/`[NOT STARTED]` tag and add a dated entry under **Progress** below — don't just mark it done silently, since the next session (human or agent) needs the exact mechanism/file references to avoid re-deriving them.

**Progress:**

- **2026-07-20 — Item 1 [DONE], automatic draft fork:** `WorkflowDefinitionMutation` now carries the addressed view plus expected definition/descriptor revisions on every generic editor, step, reorder, undo/redo, and workflow-property mutation. `WorkingFileManager.seedDraftFromRun(...)` holds the lineage descriptor lock while it validates the exact source run revision, writes a runtime-free draft, and sets `pendingEdit = { kind: "draft" }`; `WorkflowOrchestrator.prepareDefinitionMutation(...)` then loads a separate draft instance and switches only the requesting client to `{ kind: "draft" }`, leaving the source queue/execution target untouched. `WorkingFileManager.expectDefinitionRevision(...)` protects the subsequent draft write with a locked compare-before-write check, while router snapshot refreshes re-baseline the client revisions after each mutation. `src/test/unit/WorkingFileManager.test.ts`, `src/test/unit/WorkflowOrchestrator.test.ts`, and webview run-view tests cover source immutability, stale descriptor/definition conflicts, requester-only rebinding, and snapshot revision state.
- **2026-07-20 — Item 2 [DONE], core primitive:** `WorkingFileManager.seedNewRun(workspaceFolderPath, workflowKey, fromRunRef, overrides?, lineageRepository?)` is a static method (no live-queue dependency, since the source run being re-run may not be the one any queue currently has loaded). It reads `fromRunRef`'s persisted `workflow.ctrlyoke.json`, strips workflow-level and per-step `_runtime` (the shared `stripStepRuntime` helper in `WorkflowStepSanitizer.ts`, also used by `buildDefinitionSnapshot`), applies optional `{harness, model}` overrides, allocates a brand-new `RunRef` via `WorkflowLineageRepository.allocateRun`, and writes revision 1. Its result returns the exact `startedAt` written to the working file, so the timeline shares its run timestamp. It leaves `fromRunRef` byte-for-byte unchanged. `WorkingFileManager`'s internal disk read/write was factored into module-level free functions (`readWorkingFileFromDisk`/`writeWorkingFileAtomicTo`) so the static and instance paths share one implementation. `src/test/unit/WorkingFileManager.test.ts` covers seeding, runtime stripping, source immutability, overrides, revision 1, and the returned timestamp.
- **2026-07-20 — Item 2 [DONE], execution wiring:** `WorkflowInstance.executeSeededRun(seeded, workflowKey, harnessOverride?)` loads a run already allocated by `seedNewRun`, initializes its timeline with the seed's timestamp, then executes it with `continueFromCurrent=true` so `executeLoadedPromptFile` neither restarts nor re-promotes it. It passes the exact initialized manifest path into execution rather than re-resolving the newest run; a preflight harness failure now finalizes that preinitialized timeline as `ERROR`. This preserves the promoted-run definition/manifest/events invariant and avoids a race that could direct rerun output to another latest run. It is the one implementation intended for CLI `rerun` (item 8) and the future webview Re-run action (item 6). `src/test/unit/WorkflowInstance.test.ts` asserts no second promotion/restart, correct queue binding, distinct manifest/events artifacts, matching working-file/manifest start timestamps, exact manifest targeting, and exactly one extra run directory.
- **2026-07-20 — Item 3 [PARTIAL], backend/core checkpoint:** Added `WorkflowOrchestrator.setStartPositionAtRun(...)`, which requires the client's exact `{ workflowKey, runRef }` view plus expected definition/descriptor revisions. Index 0 delegates to the existing `WorkingFileManager.seedNewRun(...)` primitive with both revision guards, leaving the source bytes untouched. Nonzero rewinds use `WorkingFileManager.beginPendingRewind(...)`: under descriptor → working-file locking it writes an exact-byte `pending-rewind/base.ctrlyoke.json` snapshot, clears only the suffix `_runtime`, advances the run definition revision, persists `_runtime.pendingRewind`, and records the descriptor's exact rewind marker. `PromptQueue` applies the durable transition to a live target without a second write, keeps a paused same-run target paused, and rejects prefix/workflow-level mutation while the suffix is pending. `WorkflowPaths` owns the recovery paths; focused `WorkingFileManager`/`PromptQueue` tests cover snapshots, revision conflicts, suffix protection, paused state, and legacy set-start-position/undo-redo still pass. **Not DONE:** no webview message contract/router/UI entry point invokes the addressed method yet; commit/discard/recovery semantics and durable undo suppression remain item 4, and execution continuation/reopen remains item 5.
- **2026-07-20 — Items 3 and 4 [DONE], addressed rewind and durable recovery:** `SET_START_POSITION` now carries an explicit promoted `WorkflowViewAddress` plus expected definition/descriptor revisions through the webview, router, and `WorkflowOrchestrator`; the result invalidates every connected client viewing that exact stable run. Beginning a rewind commits a `DEFINITION_REVISION_COMMITTED` event immediately with the suffix boundary, so it is durable before any new output. `WorkingFileManager.discardPendingRewind(...)` is the one rollback transaction used by the recovery-visible banner and boundary context-menu action: it revision-checks, requires confirmation only for changed suffix content, atomically restores exact base bytes, clears `pendingEdit`, and safely removes only the known snapshot. Pending rewinds block delete/prune, suffix undo strips both archived and incoming runtime, and addressed run snapshots re-baseline zundo on entry. Focused core and webview coverage exercises discard/confirmation/restart state, conflicts, prefix/suffix behavior, timeline commit, and client invalidation.
- **2026-07-20 — Item 5 [DONE], explicit same-run append/continue:** `WorkflowOrchestrator.appendAndContinueAtRun(...)` and `continueAtRun(...)` require the viewed `{ workflowKey, runRef }` plus both revisions, reject a different active/locked run, permit paused continuation only for that same live target, and treat a lockless/stale running file as crash recovery. `WorkingFileManager.appendTailToRun(...)` serializes descriptor then definition locking, keeps the existing prefix byte-for-structure (including step runtime/session metadata), and writes only sanitized runtime-free tail steps. `WorkflowInstance.executeContinuationAtRun(...)` is the sole bind-and-run path for a historical target; all legacy continuation branches resolve the queue's exact `runRef`, never a newest run. `TimelineRecorder.reopenRun(...)` keeps `startedAt`, `eventCount`, and `nextSequence` while clearing `completedAt` and refreshing state/revision/count, then normal finalization targets that same manifest. Continuation target run indices are now loaded for append too, and completed final-step loops advance/persist before another final phase. `TimelineRecorder`, `WorkingFileManager`, and `WorkflowOrchestrator` unit coverage covers manifest reopen, prefix/tail preservation, latest vs historical selection, paused same-target, wrong-target busy, revision conflict, and crash/restart rebinding; the extension-host suite passed (1,851 tests).
- **2026-07-20 — Item 6 [DONE], stable-address run controls and pending-continuation UX:** `RunViewLoadedMessage` now exposes the durable `pendingRewind` marker directly and `useMessageHandler` stores it with the unified addressed view. `Header.tsx` delegates all execution decisions to `getWorkflowExecutionControls`, which preserves all three slots in every state: draft Run, promoted Re-run (always seeds a new `RunRef`), slot-2 Resume for resumable work, and slot-1 Continue during a pending rewind. When another run executes, controls use the executing run summary/ref for labels and stable targeting rather than the viewed run. `EXECUTE_DRAFT`, `SEED_NEW_RUN`, `START_NEW_RUN_INSTEAD`, `CONTINUE_RUN`, `APPEND_AND_CONTINUE_RUN`, and stable runtime-control messages replaced the old instance-ID aliases in the webview/router; `startNewRunInsteadAtRun` checks execution first, discards without emitting an intermediate view, then seeds the new run in one lifecycle action. The banner and boundary context-menu discard both use `DISCARD_CONTINUATION`; suffix-edit confirmation remains router-owned. Added status-matrix, header/banner, store/snapshot, router contract, stale-live-message, and existing multi-client filtering coverage. Focused and broad webview tests passed (1,024); extension-host suite passed (1,852 tests).
- **2026-07-20 — Item 7 [DONE], addressed Save/template export:** Save now opens against the exact client view address and carries a request ID through dialog open, overwrite checks, save/template commands, and responses. `CHECK_SAVE_PATH` returns an as-you-type, non-modal overwrite/security result; the UI only accepts its current request and closes the dialog on an address switch, so delayed dialog/path/save responses cannot affect another run. `WorkflowSerializer` resolves the viewed draft/run file, derives defaults from the lineage descriptor, frames pending rewinds explicitly, strips runtime with the existing allowlist, and applies the same workspace-containment/symlink checks before both preflight and final write (including a final view/path recheck). `WorkflowSerializer` and `uiStore` coverage exercises descriptor/pending-rewind framing, workspace-escape rejection, stale addressed checks, and stale path responses; focused webview and extension-host tests passed.
- **2026-07-21 — Item 8 [DONE], targeted CLI operations:** `src/cli.ts` now exposes `rerun`, `append`, and `continue` alongside source-based `run`. `CliRunSelector` is the single `runId`/`RunRef` resolver and reads only `OutputHistoryManager.getRunSummaries(workflowKey)`, so numeric gaps remain not-found and duplicate display IDs are explicit ambiguity errors. `rerun` validates the lineage lock, revision-checks the selected persisted source, then delegates to `WorkingFileManager.seedNewRun(...)` and `WorkflowInstance.executeSeededRun(...)`; it is the only new command that accepts harness/model overrides. Append parses a runtime-free tail and calls `appendTailToRun(...)`, while continue leaves the definition untouched; both validate the exact `{ workflowKey, runRef }`, descriptor/definition revisions, lock/state, and use `executeContinuationAtRun(...)`, preserving the run-pinned watcher, environment, sessions, timeline revision, manifest reopen, and exit behavior. CLI selector and command-contract tests cover stable/numeric selection, gaps, ambiguity/not-found, required targets, and override boundaries; existing working-file/orchestrator/watch coverage remains the source/prefix/conflict/exact-watch regression suite. Lock acquisition now fails execution rather than allowing an unowned run to proceed.
- **2026-07-20 — Item 9 [DONE], addressed MCP contracts:** `mcp-server.ts` now exposes stable `{ workflowKey, runRef }` selectors for queue status, output, append, and global status; selected status/output read only the addressed run file and never bind an executor. Selector-free current-workflow calls are valid only when `CTRLYOKE_WORKING_FILE` pins one promoted run, and explicit selectors must match that pin, eliminating latest-file inference. `ctrlyoke_append_queue` accepts optimistic definition/descriptor revisions, permits only tail appends, and delegates to the new Node-safe `RunContinuationService`, shared by MCP, CLI, and orchestrator continuation paths. That service centralizes runner-lock/state validation plus descriptor → run-file locking, revision conflicts, and runtime-free tail/prefix preservation; `WorkflowLockInspector` is the shared Node-safe lock reader used without importing the VS Code-bound logger. MCP contract tests cover schema shape, historical reads, pin conflicts, response addresses/revisions, prefix sanitation, busy locks, and concurrent revision conflicts.
- **2026-07-20 — Item 10 [DONE], Phase 3 acceptance matrix and retention/deletion hardening:** audited items 1–9 against the current tests and implementation rather than relying on checkpoint labels. `WorkflowLineageRepository.deleteRun(...)` now serializes removal with the descriptor lock, repairs `latestRunRef` without closing `nextRunId` gaps, and rejects pending-rewind/in-flight targets. `OutputHistoryManager` protects active manifest/runner-lock runs plus pending rewinds, retains the newest `runs.maxRuns` rows while allowing protected older source/append targets to exceed the cap, waits for search-index removal before a delete resolves, and carries an explicit source ref through seeded execution so retention cannot prune it during initialization. `WorkflowOrchestrator.deleteRunAtAddress(...)` rehydrates every client viewing the lineage, falling viewers of the removed address back to the newest remaining run or draft deterministically. Added retention/protected-target, descriptor-gap/search-document, and multi-client fallback coverage; existing Action/UI tests cover draft/source isolation, index-zero seed, historical and PAUSED rewind, append/final-loop monotonicity, discard/undo barrier, three-slot controls, stale save responses, and addressed filtering. Required validation: `npm run compile` and `npm run typecheck` passed; `npm run lint` passed; `npm test` passed with **1,873 extension-host** and **1,025 webview** tests. `npm run format:check` was run but remains blocked by pre-existing repository files (including JSONL content named `dev/reference/opencode-output-example.json` plus unrelated formatting warnings); all Phase 3-touched files pass targeted Prettier check. Generated schemas/icons were regenerated by the compile scripts with no checked-in artifact changes.
- **Bug found and fixed (pre-existing, not introduced by this session — discovered while building the `executeSeededRun` test):** `PromptQueue.loadPrompts()` rebuilt `this.state` as a fresh object literal that omitted `workflowKey`/`runRef`, silently dropping them to `undefined`. Both production call sites (`PromptFileLoader.loadParsedPromptFile`, `WorkflowInstance`'s ephemeral-workflow init) call `createWorkingFile` (which sets `workflowKey`) immediately followed by `loadPrompts` — so **every fresh `loadPromptFile`/CLI `run` had its `workflowKey` wiped before `executeLoadedPromptFile` ever ran**, meaning the fresh-start guard's `&& workflowKey` check was always false and `promptQueue.promoteToNewRun()` could never fire. Confirmed empirically with a throwaway probe (`instance.loadPromptFile(realFile)` → `getState().workflowKey === undefined`, `runRef === undefined`), then traced to `git blame` showing `loadPrompts` was last touched by the phase 1b/1c commit — it predates the refactor and was never updated to preserve the two new `QueueState` fields the way `workflowName`/`definitionRevision` already are in the same object literal. Fixed in `PromptQueue.ts` by adding `workflowKey: this.state.workflowKey, runRef: this.state.runRef` alongside the existing preserved fields; regression test added in `src/test/promptQueue.test.ts`'s `loadPrompts` suite. **This means every fresh execution start since phase 1b was silently writing into the draft file forever instead of promoting a run directory** — worth independent manual verification given how central run promotion is to this whole plan.

### Phase 4 — Timeline as the response source of truth

1. Extend events for lossless response/script/follow-up semantics.
2. Implement the streaming `RunOutputResolver` and parity tests for every terminal state, retry, resumed session, script, and final-step loop.
3. Move all response/prior-context/MCP consumers to the resolver and hydrate active execution caches on restore.
4. Remove duplicated persisted response fields only after full parity and crash/restart tests pass.

### Phase 4 checkpoint / progress

- **Item 1 [DONE] — normalized timeline event contract:** inventoried producers (`WorkflowExecutor` for AI/script/retry output, `WorkflowInstance` for resumed-session follow-up, and `OutputHistoryManager` for runtime/finalization) and consumers (`OutputHistoryTimelineAdapter`, history search/index, dashboard history replay, and future resolver/prior-context paths). `TimelineRecorder` remains the only manifest/event writer. The append-only schema now carries explicit attempt start/terminal identity, response kind, lossless script process data, exact retry input, bounded follow-up metadata, final-step addressing, run terminal state, and definition revision tags. Runtime `responseText`, script output, and final-step caches remain in place until the resolver parity/cutover items. Attempt creation is awaited before the harness sends a potentially context-dependent prompt; follow-up timeline persistence is awaited before mutable runtime response text extends. Focused serialization coverage includes AI, scripts, retry, resumed/final-step attempts, failed/cancelled/stopped outcomes, pause/resume restart transitions, definition revisions, and large follow-up payload de-duplication.
- **Item 2 [DONE] — streaming resolver and parity matrix:** `RunOutputResolver` is the single additive reader API for future response/prior-context/preview consumers. It streams `events.jsonl` in append/sequence order (including a safely ignored partial trailing line) without loading the log, emits lossless attempt/output/script/retry/follow-up/terminal/runtime-transition records, and can reduce one selected attempt using bounded working memory. Revision-1 definitions are now captured immutably in the manifest and later revisions remain timeline snapshots, including `finalStep`, so every resolved queue attempt or final-step loop uses its committed definition rather than the current run head. Focused parity/stress coverage proves AI and script values, retries, resumed sessions/follow-ups, completed/failed/cancelled/stopped terminals, pause/resume transitions, historical definition revisions, final-step loops, append ordering, a 4,096-event streamed log, and a 1 MiB untruncated response. Existing runtime response/script/final-step fields and consumers are intentionally unchanged for Item 3.
- **Item 3 [DONE] — resolver consumer migration and restore hydration:** `RunOutputResolver` now projects the latest selected attempts and prior-context items in a single bounded stream, including script output and final-step loops. Active `RUNNING`/pause/cancel restores hydrate only the queue-prefix and final-loop execution caches from the exact `{workflowKey, runRef}` manifest, without rewriting duplicate runtime response fields. `CliPromptPreparer` consumes the resolver before prompt construction; output-history preview hydration, session follow-up merges, LM `ctrlyoke_read_output`, and MCP `ctrlyoke_read_output` all use resolver values rather than `_runtime` or independently reconstructed event output. Attempt-start/final-output writes remain awaited before the next dependent prompt path, and follow-up persistence is awaited before its resolver merge. MCP coverage now creates an addressed timeline fixture (not a runtime-field fallback); resolver coverage exercises latest attempt selection, AI/script/retry/resumed/final-loop prior context, large responses/logs, and terminal transitions. Full validation: `npm test` passed with **1,876 extension-host** and **1,025 webview** tests; `npm run typecheck` and `npm run lint` passed. `npm run format:check` remains repository-blocked by existing non-source files/JSONL, while every Item 3-touched file passes targeted Prettier.
- **Item 4 [DONE] — response-source cutover and duplicate-field removal:** proved the resolver parity matrix before deleting the duplicated persisted contracts: `PromptRuntimeMetadata.responseText`/`scriptOutput`, `FinalStepRuntimeState.responseTexts`, the final-step callback contract, CLI runtime response writes, queue/final-loop disk write helpers, synchronous runtime-field context fallback, and schema/validation entries are gone. `WorkingFileManager` now strips obsolete fields on both read and every canonical write without interpreting or migrating them (pre-release, no dual read); session IDs and other resume-critical metadata remain persisted. `PromptQueue` retains only private, active-process caches, populated after the authoritative timeline write and rehydrated from `RunOutputResolver` after restore; they are never serialized. Prior-context construction, editor preview, MCP/LM reads, commit-message fallback, script context, resumed follow-up merges, and final-loop execution all resolve timeline output. Focused resolver coverage now exercises AI/script/retry/resumed/follow-up/final-loop output plus completed/failed/cancelled/stopped terminals, a new-resolver restart after every attempt/output/terminal/follow-up boundary, ignored partial trailing JSONL, a 65,536-event streamed log, and a 1 MiB untruncated response. Required validation: `npm run compile` passed; `npm run typecheck` passed; `npm run lint` passed; `npm test` passed with **1,827 extension-host** and **1,025 webview** tests. `npm run format:check` was run and remains repository-blocked by existing/generated non-source files (`.codex/hooks.json`, `.ctrlyoke/notifications/push-subscriptions.json`, generated `AGENTS.md`/`CLAUDE.md`, `dev/migrate-runs-layout.mjs`, `HistorySearchService.ts`, standalone shim, and navigation files/tests) plus the known JSONL content named `dev/reference/opencode-output-example.json`; all Phase 4 source, schema, and focused test files pass targeted Prettier.

### Phase 5 — Separate follow-up: cross-run/cross-workflow prior context

Extend `PriorContext` with `WorkflowRunAddress` and resolve through the phase-4 reader. This requires its own UX and authorization design; it is not part of phases 1–4.

## Test and acceptance matrix

### Paths and storage

- Workflow key and run-ref collision allocation; Windows case handling; traversal/reserved-name/symlink rejection; parser round trips.
- First draft promotion, rerun seed, append reopen, descriptor-repair windows, partial `.creating-*` recovery, corrupt descriptor/manifest isolation.
- No `.working`/`.history` literals or `WORKING_DIR`/`HISTORY_DIR` references remain outside the migration script and historical documentation.
- A promoted run is never visible without definition, manifest, and events artifacts.

### Identity and concurrency

- Two dashboard clients select different runs without changing each other's view or the instance queue.
- Run M continues while a client browses N; watcher, lock, PTY/session key, output events, and `CTRLYOKE_WORKING_FILE` remain pinned to M.
- Simultaneous lock acquire has one winner; stale owner heartbeat/release cannot affect the winner.
- Conflicting descriptor/draft edits reject on revision mismatch.
- CLI watch follows lock `runRef` even if a newer draft/run appears.

### Actions

- Re-run produces a new `RunRef`/`runId`, strips execution runtime, and leaves the source byte-for-byte unchanged.
- Append preserves existing prefix/session metadata/events, adds only a tail, reopens/finalizes the same manifest, and never reuses final loop indices.
- Setting start position to index zero leaves the source unchanged and produces a new run on execution.
- Setting start position to index K > 0 on the latest or an older idle run keeps its `RunRef`/`runId`, clears only `[K, end)`, permits suffix edits, and appends new attempts to that run on Continue.
- A pending rewind survives restart, can be discarded back to the last committed definition, blocks delete/prune, and rejects prefix/workflow-property edits.
- Rewinding a `PAUSED` run keeps that run as the execution target: lock, watcher, `CTRLYOKE_WORKING_FILE`, and harness session keys do not move, and Continue resumes into the same `RunRef`. Rewinding a different run while one is paused is rejected.
- Definition undo inside a pending rewind restores suffix step text/settings without resurrecting archived suffix `_runtime`; prefix archive behavior is unchanged; discard restores full suffix runtime from `base.ctrlyoke.json`.
- Undo cannot cross the rewind-begin barrier: the stack is re-baselined on entry, and Discard Continuation is the only path back to the pre-rewind definition and runtime.
- Discard is reachable from the pending-continuation banner, the boundary step's context menu, and the startup recovery prompt, and all three invoke one implementation. It prompts only when suffix edits would be lost.
- The execution group stays three slots in every state; Discard never enters it. Slot 1 is Re-run (new `RunRef`) on any promoted run and Continue only during a pending rewind. Slot 2 is never repurposed as a re-run action.
- “Start new run instead” on the banner discards the pending rewind and seeds a new run in one action, leaving run N's committed definition and events untouched.
- Every old attempt resolves against its committed definition revision after suffix text, order, or length changes.
- Generic edit of a promoted run outside rewind mode creates a draft and never mutates the source.
- Delete/prune rejects protected runs, repairs descriptor hints, removes search documents, and gives every affected client a deterministic fallback.
- Finite `runs.maxRuns` handles gaps and an old append target without deleting the executing/source run.

### UI and contracts

- Definition, settings, step selection, output, and run label switch as one snapshot.
- Stale/mismatched live messages and save-path responses are ignored by address/request ID.
- zundo past/future and runtime caches cannot cross run/draft boundaries.
- Search and hosted deep links still open the same run after newer runs are added or older runs are deleted.
- Save and Save as template export the viewed definition, strip runtime, default from the descriptor, and recheck overwrite at commit.
- A pending rewind is framed explicitly as “Save run N — pending continuation” so exporting the unexecuted suffix revision is intentional.

### Response-source cutover

- Prior-context and preview output match pre-cutover behavior for AI, script, follow-up, retry, failure/cancel/stop, pause/restart, and final-step loop cases.
- Very large event logs are streamed with bounded working memory and no response truncation.
- Timeline write completes before the next dependent prompt is constructed.

### Required validation per phase

- Focused unit/integration tests for touched areas.
- Webview tests for contracts, stores, navigation, and multi-client filtering.
- CLI/MCP tests for selectors, exact-run watch, environment pinning, and conflicts.
- Full `npm run compile`, lint/format checks, unit tests, and webview test suite before phase completion.
- Regenerate any checked-in schemas/agent files using the repository scripts rather than hand-maintaining generated output.

## Expected source surface

Implementation must inventory with `rg` again at phase start, but the verified surface includes:

- Core: `WorkingFileManager`, `PromptQueue`, `WorkflowInstance`, `WorkflowOrchestrator`, `WorkflowExecutor`, queue operations, output capture, harness integration, and prompt loading.
- Orchestration: `OutputHistoryManager`, `TimelineRecorder`, timeline adapter, history search/index, CLI watch, workspace initializer/session recovery, streaming history, and lock utilities.
- Entrypoints: `cli.ts`, `extension.ts`, `mcp-server.ts`, hosted-server routing, and standalone shims where contracts cross the boundary.
- UI/backend: `CtrlYokeWebviewProvider`, `WebviewMessageRouter`, `WorkflowSerializer`, `UndoRedoCoordinator`, completion notifications, and shared message/summary/history types.
- Webview: app/bootstrap READY payload, message handler, workflow/UI stores, navigation routes/state, recent workflows, history search, output/steps/editor/header/status controls, settings, save dialog, undo hooks, and tests.
- Configuration/bootstrap/docs: settings schema/types/defaults/utils/sync/UI, both gitignore sources, `WorkspaceInitializer`, project instructions, current user docs, and the generated tech-support template.
- Tests and fixtures containing old paths, settings, volatile run indices, or working-file keyed summaries.

## Throwaway developer-data migration

Create `dev/migrate-runs-layout.mjs`, run it manually per workspace, verify its report, and remove it after local pre-release data no longer needs conversion. It is not bundled or invoked by the extension.

For each `.ctrlyoke/.working/<id>.ctrlyoke.json`:

1. exclusively create `.ctrlyoke/.runs/<workflowKey>` and its descriptor;
2. move matching history run directories into staged new run directories;
3. copy the old working file to the newest run as its best-known exact definition/runtime;
4. give older history runs a runtime-stripped copy marked only in the migration report as approximate (the old format cannot recover their exact definitions);
5. create a draft instead when no history run exists;
6. derive monotonic `runId`/`nextRunId`, summaries, and `latestRunRef`; and
7. verify every destination before removing old files and stale runner locks.

An orphan history lineage with no working file cannot satisfy the new run invariant. Move it to a clearly reported `.ctrlyoke/.migration-rejected/` quarantine rather than exposing an invalid lineage or inventing an empty definition.

The script must be idempotent until final cleanup, refuse to overwrite an existing destination, and print a per-lineage success/warning/failure summary.

## Settled decisions

- **No concurrent execution within one lineage.** Browsing and draft preparation may be concurrent because they do not rebind the executor.
- **Committed definition revisions are immutable; a run's head may advance.** Generic edits fork a draft, while append and nonzero set-start-position are explicit same-run continuation operations. Setting the start position to index zero always creates a new run.
- **History is always on from phase 1.** Optional history cannot coexist with the new storage invariant.
- **Retention stays opt-in and unbounded by default.** `runs.maxRuns = -1`; a finite value authorizes deletion of complete runs.
- **Stable refs target operations.** Numeric `runId` is display/select convenience; list index is never identity.
- **Descriptor hints are repairable caches.** Valid run directories/manifests are storage truth.
- **Save exports the viewed address.** It always uses the dialog and warns before overwrite.
- **The run list is manifest-only.** Mixed harnesses are disclosed instead of implying one harness describes every step.
- **Response de-duplication is last.** Structured event parity precedes removal of runtime response fields.

## Main risks and mitigations

- **Wide identity migration:** grep gates and a single canonical path module prevent surviving basename/path reconstruction.
- **Shared-instance client leaks:** execution binding and per-client view addresses are separate by construction and covered by multi-client tests.
- **Cross-process races:** exclusive lock creation, owner tokens, short metadata locks, optimistic revisions, and staged run promotion cover distinct race classes.
- **Partial filesystem transactions:** hidden staging plus descriptor repair avoids treating multi-file writes as one atomic operation.
- **Historical definition corruption:** committed definition snapshots and revision-tagged attempts preserve what produced old output, while rewind mode constrains mutations to the selected suffix.
- **Timeline cutover data loss:** lossless event extensions and parity tests precede deletion of duplicated response fields.
- **Unbounded disk use:** default remains non-destructive, while explicit `runs.maxRuns` and manual deletion operate on complete, addressable run units.

## Alternatives rejected

1. **Rebind the shared `PromptQueue` when any client selects history.** Rejected because it redirects other clients and can corrupt an active executor/watch/lock target.
2. **Checkout a historical snapshot into one mutable working file.** Rejected because it still requires lossless snapshots and makes the file's meaning change silently.
3. **Allow unscoped generic edits directly on completed runs.** Rejected because existing output step indices and settings would no longer match the recorded definition. The supported exception is explicit nonzero rewind mode, with a locked prefix and revision-tagged definition snapshots/output.
4. **Allow parallel runs in one lineage.** Rejected because it breaks current PTY/session/lock/instance assumptions; worktrees are the intended isolation boundary.
5. **Derive definitions from events only.** Rejected because events do not encode the complete workflow definition and execution settings.
