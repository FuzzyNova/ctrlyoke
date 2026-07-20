# Working File Per Run — Run-Scoped Workflow Definitions

Status: proposed (analysis complete, not started)

Constraint: **pre-release, zero backward compatibility.** The design contains no dual-format support, no mirroring, no legacy fallbacks. Existing local data is handled by a throwaway dev migration script (see bottom) that is deleted once the refactor lands.

## Problem

Four user-facing problems share one root cause:

1. **Steps panel doesn't match the viewed run.** History browsing (`LOAD_RUN_HISTORY` → `OUTPUT_HISTORY_LOADED` → `workflowStore.loadHistoryRun`) swaps only the OutputSection's data source (`historyOutputs` + `uiStore.isViewingHistory`). `WorkflowStepsPanel`, the editor, and every Header control stay bound to the live working file. Step-click → output navigation across runs is best-effort and breaks when step counts differ.
2. **No way to append to a previous run.** `PromptQueue.restart()` strips `_runtime` from every step (sessionId, responseText, harness, model) before a re-run, so the working file only ever describes the *latest* run. The only durable record of an old run's session IDs is buried in its `events.jsonl` CLI output metadata.
3. **No way to re-run a historical run as-is (or with a different harness).** The history timeline (`WorkflowTimelineTypes.ts`) stores CLI outputs, status messages, snapshots, and runtime transitions — but **not the workflow definition**. The steps/settings that produced run N are unrecoverable once the working file has been edited or restarted.
4. **Controls are ambiguous while viewing history.** Save / undo-redo / add-step / run / pause / stop all apply to the single working file, regardless of which run the user is looking at.

The root cause: **a "run" has no durable identity for its definition.** The working file is a mutable singleton; history runs are output-only.

## Current architecture (verified inventory)

- **Working file**: `.ctrlyoke/.working/<slug>-<createdTs>.ctrlyoke.json`, written only by `WorkingFileManager` (`src/core/WorkingFileManager.ts`).
- **History**: `.ctrlyoke/.history/<workflowId>/run-<ts>/manifest.json` + `events.jsonl` (`TimelineRecorder`, projected back by `OutputHistoryTimelineAdapter`). New run dir created by `OutputHistoryManager.initializeRun()` from `WorkflowInstance.executeLoadedPromptFile` only for fresh runs; append/resume/idle continuations reuse `getLatestHistoryFilePath()`.
- **History is optional**: `history.saveOutput` (settings-schema.json) gates all of it (`OutputHistoryManager.isHistoryEnabled()`); `history.maxRuns` prunes oldest run dirs.
- **responseText duplication**: `WorkflowExecutor` stores each response on `step._runtime.responseText` (and `finalStepRuntime.responseTexts[]`) for priorContext, *and* the same text lands in history as `CliOutput.response`. Prior context (`PriorContextPreviewBuilder`, `CliPromptRuntimeCoordinator`, executor) reads only the in-memory/working-file copy.
- **Locks**: one `<workflowId>.runner.json` per working file (`WorkflowLockManager.getLockPath` derives it from the working-file basename), heartbeat-based, coordinates extension vs CLI runner.
- **Sessions/recents**: `WorkspaceSessionManager` and `WorkflowSerializer.getRecentWorkflows` scan `.working/*.ctrlyoke.json` — one entry per working file.
- **Watching**: `PromptFileWatcher` watches the working file path; `CliWatchSession` follows the *newest* `run-<ts>` dir for CLI-managed workflows.
- **Undo/redo**: webview temporal store (zundo `pastStates` in `UndoRedoControl`) over step edits, synced to the backend working file. Separate from history `UndoRecord`s (file-change undo).

## Identity model — untangling `workflowId`

There are **three** identity notions in the codebase today; the refactor changes only one of them.

| Identity | Today | Used by | After refactor |
| --- | --- | --- | --- |
| `WorkflowInstance.id` | Random UUID per instance (`crypto.randomUUID()` in `WorkflowInstance`) | Orchestrator `instances` registry key, dashboard messages / `WorkflowTaggedSink`, `loadedWorkflows[].id` in the webview | **Unchanged.** Dashboard/webview identity stays UUID-based; no message contracts change. |
| `workflowId` (the conflated one) | Working-file **basename**, derived ad hoc via `OutputHistoryManager.extractWorkflowId()` at ~20 call sites (`WorkflowInstance` ×9, `WorkflowOrchestrator` ×6, `WorkflowSerializer` ×3, `UndoRedoCoordinator`, `CtrlYokeWebviewProvider`) | History dir name, search-index key, lock-file basename, session recovery, CLI | Becomes **`workflowKey`** — the lineage directory name `.runs/<workflowKey>/`. Same slug+createdTs format, but it now names a *directory that owns everything* instead of being parsed out of a mutable file's basename. |
| `workingFilePath` | Full path; doubles as instance lookup key (`WorkflowOrchestrator` finds instances by path, line ~753) and watcher/lock target | Orchestrator path lookup, `PromptFileWatcher`, locks | Splits into `workflowKey` (lineage lookup) + `RunRef` (which run). A run file path *encodes both positionally*: `.runs/<workflowKey>/run-<ts>/workflow.ctrlyoke.json`. |

### The solution: one canonical path/identity module

New `src/utils/WorkflowPaths.ts` (single source of truth, same spirit as `PATH_CONSTANTS`):

```ts
type RunRef = string;                       // "run-2026-07-19T10-30-00" (dir name)
interface WorkflowRunAddress { workflowKey: string; runRef: RunRef; }

WorkflowPaths.lineageDir(root, key)         // .ctrlyoke/.runs/<key>/
WorkflowPaths.descriptorPath(root, key)     // .../<key>/workflow.json
WorkflowPaths.runDir(root, key, runRef)     // .../<key>/run-<ts>/
WorkflowPaths.runFilePath(root, key, runRef)// .../run-<ts>/workflow.ctrlyoke.json
WorkflowPaths.manifestPath / eventsPath     // .../run-<ts>/manifest.json | events.jsonl
WorkflowPaths.lockPath(root, key)           // .../<key>/runner.json
WorkflowPaths.parseRunFilePath(path): WorkflowRunAddress | null   // inverse
```

- **Delete `extractWorkflowId()` entirely.** Every call site either (a) already has the instance/queue in hand — read `instance.workflowKey` / `queueState.address` instead of re-deriving from a path, or (b) genuinely starts from a path (session recovery, search, CLI) — use `parseRunFilePath()`. No basename string-munging survives outside `WorkflowPaths`.
- **`WorkflowInstance` gains two fields**: `workflowKey` (fixed at load) and `boundRun: RunRef` (which run's file the queue is bound to; changes on run switch). `PromptQueue`/`WorkingFileManager` keep operating on "the working file path" — it's just `runFilePath(key, boundRun)` now. `IWorkingFileQueueAccess.getWorkingFilePath()` is untouched.
- **Orchestrator lookup**: "find instance by working file path" becomes "find instance by `workflowKey`" (one lineage ⇒ at most one instance — this is the single-execution rule made structural). Duplicate detection, retired-instance reuse, and CLI-session lookup all key off `workflowKey`.
- **Locks**: `WorkflowLockManager.getLockPath(workingFilePath)` → `WorkflowPaths.lockPath(key)`. Lock scope is the lineage (matches the single-execution contract), lives inside the lineage dir — no more sibling-file basename derivation. `runner.json` records which `runRef` it is executing.
- **Search**: `HistorySearchService`/`HistorySearchIndexService` already key by history-dir name — that *is* `workflowKey` now, unchanged structurally. Bonus: `readWorkflowMetadata()`'s fragile reverse-mapping (workflowId → reconstructed `.working/<id>.ctrlyoke.json` path) becomes lossless: search hits carry `{workflowKey, runRef}` and resolve to `runFilePath()`, which is guaranteed to exist because it's the same dir the match came from.
- **CLI/MCP**: commands address `workflowKey` (+ optional run selector, default = latest run). `CliWatchSession` already follows newest `run-<ts>` dir per workflow — only its root moves to `.runs/`.
- **`TimelineRecorder.isRunEntry` / `extractRunTimestamp`** stay the run-dir authorities; `RunRef` is deliberately the dir name so no second run-id scheme appears (manifest's numeric `runId` remains a display ordinal only).

## Proposed model

### Core contract

> **A run is the unit of definition + output. A workflow is a named lineage of runs. At most one run of a lineage executes at a time.**

### Storage layout

`.working/` and `.history/` merge into `.runs/`:

```
.ctrlyoke/.runs/<workflowKey>/
  workflow.json              ← lineage descriptor: workflowName, originalFile,
                                isFavorite, createdAt, latestRunRef
  runner.json                ← execution lock (only while running)
  run-<ts>/
    workflow.ctrlyoke.json   ← this run's full definition incl. per-step _runtime
    manifest.json            ← unchanged (runId, startedAt, executionState, …)
    events.jsonl             ← unchanged
  draft/
    workflow.ctrlyoke.json   ← definition edited before the first run (promoted to
                                run-<ts>/ on first Run; dir absent afterwards)
```

- The run definition file keeps today's `WorkingFile` schema. `WorkingFileManager` stays the only writer; it points at the bound run's file (or the draft).
- The lineage descriptor exists so `getRecentWorkflows` / `WorkspaceSessionManager` / search metadata read one small file per workflow instead of scanning run dirs. `latestRunRef` is updated by `initializeRun()` under the same write discipline as manifests.

### Runtime semantics

| Action (while viewing run N) | Workflow idle | Workflow running run M |
| --- | --- | --- |
| Steps panel / editor | Shows run N's definition | Shows run N's definition, read-only |
| Edit / add / delete / reorder steps | Mutates run N's `workflow.ctrlyoke.json` | Blocked — prompt editor overlay: "Viewing run N while run M is executing…" |
| Append + continue | Appends to run N, resumes run N's sessions (its `_runtime.sessionId`s are intact — never wiped) and appends to run N's `events.jsonl` | Blocked (switch back to run M to append) |
| Run ▶ | Seeds a **new** run N+1 from run N's definition (fresh `_runtime`), executes it | Blocked |
| Pause / Stop | Applies to the executing run only | Applies to run M |
| Save 💾 | Export via the existing save dialog, defaulting to `originalFile` (see resolved decisions) | Same |
| Undo/redo | Temporal store re-baselines on every run switch (`loadHistoryRun` already clears `undoRecords`) | Disabled for non-executing runs |

Key change to restart semantics: **`PromptQueue.restart()`'s `_runtime` wipe disappears.** "Restart" becomes `seedNewRun()` — copy the viewed run's definition minus `_runtime` into a fresh `run-<ts>/`, bind, execute. Old runs are immutable-by-default records that remain append-able. This is what makes append-to-old-run and re-run-with-different-harness fall out for free.

### What this buys

- Steps panel always matches the viewed run (problem 1) — the run switcher becomes "bind the instance to run N's definition," not "overlay some outputs."
- Append-to-old-run (problem 2) — run N's sessionIds live in its own file forever.
- Re-run historical / different harness (problem 3) — seed new run from any run's definition; change harness before pressing Run.
- Unambiguous controls (problem 4) — everything targets the viewed run.
- Foundation for **cross-run/cross-workflow priorContext** (`PriorContext` in `CtrlYokeTypes.ts`): `WorkflowRunAddress` + stepIndex is exactly the address a cross-run reference needs. Design the resolver seam for this now; implement later (phase 5).

### History always-on + responseText single-sourcing

- **Remove `history.saveOutput`.** The run directory *is* the workflow's persistence now; it can't be optional without forking the storage model. Users delete runs (existing `deleteRun` / `clearRunHistory`) if they want them gone. Retention policy is resolved below (keep `maxRuns`, default `-1`).
- **Phase out `_runtime.responseText`** (and `scriptOutput`, `finalStep.responseTexts`): with a guaranteed 1:1 `workflow.ctrlyoke.json` ↔ `events.jsonl`, prior context can hydrate from the run's own events (`OutputHistoryTimelineAdapter` already projects final per-attempt `CliOutput.response` per step). Do this **last** — it touches the executor, both prior-context builders, pause/resume restore, and preview UX — and only after always-on history has soaked. Duplication is bounded (each run file holds only its own responses), so there's no urgency.

## Implementation phases

No compatibility shims between phases — each phase converts the codebase fully to its new state; the migration script handles local data once, before phase 1 ships.

### Phase 1 — Storage + identity flip (the big one)

- Add `WorkflowPaths` and the `.runs/` layout; delete `.working`/`.history` path constants and `extractWorkflowId()`.
- `WorkflowInstance` gains `workflowKey` + `boundRun`; orchestrator registries/lookups keyed by `workflowKey` per the identity table above; locks move to `lockPath(key)`.
- `WorkingFileManager` writes the bound run's file (or draft); `initializeRun()` creates the run dir *and* its `workflow.ctrlyoke.json` (promoting the draft or seeding from the previously bound run) and updates `latestRunRef`.
- `restart()` → `seedNewRun()`; remove the `_runtime` wipe.
- Update `WorkspaceSessionManager`, `getRecentWorkflows`, `HistorySearchService`/`IndexService`, `CliWatchSession`, `cli.ts`, MCP queue ops to the new paths/identity.
- `PromptFileWatcher` watches the bound run's file.
- Extend `manifest.json` with `harness`, `model`, `stepCount` (written at `initializeRun` and on append); collapse `getRunTimestamps`/`getRunStates` into `getRunSummaries(workflowKey)`.
- Behavior at the end of phase 1 is intentionally identical to today for the user (latest run bound, history browsing still overlay-only) — this phase is pure structure. Tests: `WorkflowPaths` round-trip, run seeding, lock scope, recovery, search resolution.

### Phase 2 — Bind the view to the run

- Run switching loads run N's definition into the instance (`PromptQueue.restoreFromWorkingFile` against `runFilePath(key, N)`), rebinding `boundRun`, the watcher, and the undo baseline. `WorkflowStepsPanel`, editor, and Header controls now naturally show/target run N — delete the `historyOutputs` overlay split (`uiStore.isViewingHistory` becomes "bound run ≠ latest run").
- While executing, switching to a non-executing run is view-only: steps panel + editor read-only with the "run M is executing" overlay; Run/Pause/Stop stay wired to the executing run.
- Step-click → output navigation becomes exact (same run, same indices).
- Promote the run switcher to the RecentWorkflows-style run list (see resolved decisions), rendered from `getRunSummaries()`.
- Save dialog updates: default path = viewed run's `originalFile`, `pathExists` overwrite warning, "Save run N" framing (see resolved decisions).

### Phase 3 — Re-run and append-to-run

- "Re-run this run" action (run switcher context menu): `seedNewRun(fromRunRef)` with optional harness/model override before launch (reuse the workflow-properties editor against the seeded definition).
- Append + continue on a historical run: existing append-continuation path generalized — `getLatestHistoryFilePath()` → `getHistoryFilePathForRun(runRef)`; session resume uses run N's intact `_runtime.sessionId`s.
- CLI: `--run <ref|index>` selector for append/re-run targeting.

### Phase 4 — Always-on history + responseText single-sourcing

- Remove `history.saveOutput` from settings-schema.json, `ConfigurationUtils`, `OutputHistoryManager.isHistoryEnabled()` and its `filePath: ""` fallbacks throughout `WorkflowInstance`; rename the settings section `history` → `runs` (leaving `runs.maxRuns`, default `-1`, with the explicit deletes-entire-runs description).
- Prior context hydrates from the bound run's events on load (lazy, per-step, capped) instead of `_runtime.responseText`; then drop `responseText`/`scriptOutput`/`finalStep.responseTexts` from persisted `_runtime` (keep in-memory for the live run). Update `PriorContextPreviewBuilder`, `CliPromptRuntimeCoordinator`, `WorkflowExecutor`, `WorkflowStepSanitizer` + tests.

### Phase 5 (follow-up feature) — Cross-run / cross-workflow priorContext

- Extend `PriorContext` grammar with run/workflow addressing (e.g. `{ workflow?, run?, steps }`) resolved via `WorkflowRunAddress` through the phase-4 hydration path. Separate design doc when picked up.

## Dev migration script (throwaway)

`dev/migrate-runs-layout.mjs` — one-shot, run manually per workspace (`node dev/migrate-runs-layout.mjs [workspaceRoot]`), deleted after the refactor lands. Not shipped, not wired into the extension. Logic:

1. For each `.ctrlyoke/.working/<id>.ctrlyoke.json`:
   - Create `.ctrlyoke/.runs/<id>/workflow.json` descriptor from its `workflowName`, `originalFile`, `isFavorite`, `startedAt`.
   - Move `.ctrlyoke/.history/<id>/run-*/` → `.ctrlyoke/.runs/<id>/run-*/`.
   - Copy the working file into the **newest** run dir as `workflow.ctrlyoke.json` (its `_runtime` describes that run); set `latestRunRef`.
   - Older run dirs get a `_runtime`-stripped copy as a best-effort definition (pre-migration history never recorded definitions, so this is approximate — acceptable for dev-only data).
   - No runs? Working file becomes `.runs/<id>/draft/workflow.ctrlyoke.json`.
2. Orphaned `.history/<id>/` dirs with no working file: move as-is (view-only lineage, no descriptor `originalFile`).
3. Delete `.working/`, `.history/`, and any stale `*.runner.json`.

## Resolved decisions

### Run retention (`maxRuns`): keep the setting, default `-1` (unbounded)

- The default is **already `-1`** (`CtrlYokeSettings.ts` history defaults) and `pruneOldRuns` already treats `<= 0` as keep-all — so "unbounded by default" costs nothing.
- **Keep the setting** rather than removing it: `events.jsonl` growth is real disk pressure, and opt-in auto-cleanup is legitimately useful. The consent model is clean: a user who explicitly sets a finite `maxRuns` has explicitly asked us to delete their oldest runs. No confirmation dialogs, no favorited-run exemptions — that complexity isn't warranted for an opt-in destructive setting (mirrors the absence of a `maxWorkflows`).
- With `saveOutput` removed, the `history` settings section contains only `maxRuns` — rename the section to `runs` (`runs.maxRuns`) to match the `.runs/` storage model, and update its description to be explicit: *"Deletes entire runs — definitions and output — oldest first. -1 (default) keeps all runs."*
- Guardrail: pruning never deletes the bound or executing run (structurally already true — both are newest — but assert it).

### Concurrent runs of one workflow: no

Single-execution-per-lineage is the contract; it keeps locks, PTY reuse (`liveInjectIntegrations`), and dashboard identity sane. If parallel runs are ever wanted, that's the worktree feature's territory (`WORKTREE_SUPPORT_PLAN.md`).

### Save on a historical run: always the dialog, default `originalFile`, overwrite warning

Save is really **export**, and the current flow already matches: `SAVE_WORKFLOW_REQUEST` never writes — it replies with `SAVE_WORKFLOW_DIALOG_DATA` (defaultPath/defaultFormat) and `SaveWorkflowDialog` lets the user confirm location/name/format before `SAVE_WORKFLOW` writes. Changes needed:

- Default path = the **viewed run's** `originalFile` (from the lineage descriptor), falling back to the current name-derived default for dashboard-created workflows.
- Add an overwrite indicator: extension includes `pathExists` for the default path in the dialog data, and the dialog re-checks as the user edits (lightweight `CHECK_SAVE_PATH` request or revalidate-on-change). Inline warning text, non-blocking: *"⚠ This will overwrite `<file>`"*. Since source files aren't gitignored, git provides the safety net after an intentional overwrite.
- Dialog title/subtitle notes what's being exported when viewing history: *"Save run N (Jul 12) to file"*.

### Run switcher: promote to a RecentWorkflows-style run list

Today's prev/next arrows + timestamp in OutputSection stay for quick stepping, but the run label becomes a dropdown mirroring the `RecentWorkflows` row anatomy (`RecentWorkflows.tsx`): container = `WorkflowDropdownHeader` + `VirtualizedDropdownList`; per-row = `HarnessIcon`, run label ("Run 7"), step count, execution-state badge (`getExecutionStateBadgeClass/Icon`), relative time (`formatRelativeTimeVerbose`), hover-revealed delete (existing `DELETE_RUN_HISTORY`), plus a hover "Re-run" action (phase 3's `seedNewRun`). Extract the shared row cells (icon/name/count/badge/time grid) into a shared component rather than duplicating `WorkflowRow` (DRY).

Data source: extend `manifest.json` with `harness`, `model`, and `stepCount` (written at `initializeRun` and on append) so the run list renders from manifests alone — no opening N `workflow.ctrlyoke.json` files. `getRunTimestamps`/`getRunStates` collapse into one `getRunSummaries(workflowKey)` returning the row model.

## Risks

- **Phase 1 is wide but mechanical**: ~20 `extractWorkflowId` call sites plus path constants, all funneled through one new module. The risk is missed ad-hoc path joins — grep for `WORKING_DIR`/`.working`/`.history` literals must come up empty outside `WorkflowPaths` and the migration script when it lands. Measured (2026-07-19): the `".working"`/`".history"` literals exist in exactly 3 places — `PATH_CONSTANTS` (canonical) and a **rogue duplicate `WORKING_DIR = ".working"` in `mcp-server.ts`** that bypasses `PATH_CONSTANTS`; `PATH_CONSTANTS.WORKING_DIR/HISTORY_DIR` has 28 uses across 13 files. The `.ctrlyoke.json` *suffix* appears ~124 times across 45 files, but the run file keeps that suffix (`workflow.ctrlyoke.json`) so most survive — only basename→identity parsing changes.
- **Search index**: adding `workflow.ctrlyoke.json` to run dirs must not regress `HistorySearchIndexService`'s bounded/streamed behavior; `TimelineRecorder.isRunEntry` filtering must ignore non-run entries (`workflow.json`, `draft/`, `runner.json`).

## Alternatives considered

1. **"Checkout" model (lighter)**: keep single working file; switching to a historical run while idle replaces working-file steps/`_runtime` from a stored snapshot. Rejected — it still needs per-run definition snapshots to be lossless (you can't restore "latest" after checkout without one), at which point per-run files are the same work with a worse invariant (one file whose meaning silently changes).
2. **Multiple concurrent runs per workflow**: rejected (see risks) — breaks lock/PTY/dashboard identity assumptions for marginal benefit; worktrees are the better vehicle.
3. **Derive everything from events.jsonl, no run definition file**: rejected — the timeline captures outputs, not step definitions/settings; reconstructing a definition from prompt text in `CliOutput` would lose harness/model/overrides/scripts and all workflow-level properties.
