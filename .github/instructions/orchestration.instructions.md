---
applyTo: "src/core/orchestration/**"
---

<purpose>
Disk/UI-facing orchestration helpers for workflow loading, session recovery, history persistence, and workspace scaffolding. These files support `WorkflowInstance`, `WorkflowOrchestrator`, and the webview, but they should not become alternate owners of execution state.
</purpose>

<ownership>

- `WorkflowInstance` owns `PromptFileLoader`, `PromptFileWatcher`, and `OutputHistoryManager`.
- `WorkflowOrchestrator` owns `TemplateImporter`, `WorkflowCommandHandler`, `WorkspaceSessionManager`, and any live `CliWatchSession` instances.
- `HistorySearchService` is the exception: it is stateless and currently UI-owned (`CtrlYokeWebviewProvider` / `WebviewMessageRouter`), not orchestrator-owned.
- `TimelineRecorder` and `OutputHistoryTimelineAdapter` are internal history primitives; most callers should go through `OutputHistoryManager` instead of reading/appending timeline files directly.
- `WorkflowLineageRepository` owns everything about a lineage that has no other single owner: the `workflow.json` descriptor, `WorkflowKey` allocation (`WorkflowPaths.allocateWorkflowKey`), and `RunRef` allocation/promotion (`allocateRun`). It never writes `workflow.ctrlyoke.json` content (that's `WorkingFileManager`) or `manifest.json`/`events.jsonl` (that's `TimelineRecorder`) — only directories and the descriptor. `src/utils/WorkflowPaths.ts` is the one place allowed to construct a `.runs` path from raw parts; everything here goes through it rather than joining path segments itself.

</ownership>

<workingFilesAndSessions>

- `PromptFileLoader` is the bridge from parsed prompt file → queue working file. After `createWorkingFile(...)`, it copies workflow-level execution properties from the source file, then fills remaining defaults from settings so the in-memory `PromptFile` and on-disk working file stay aligned.
- Reload mode matters: `replace` restores an existing session, `merge` appends new steps from disk, and `auto` chooses based on current runtime state. Use merge paths for MCP/dynamic-queue extension; do not clear and rebuild queue state manually.
- `PromptFileWatcher` watches the working file, not the source workflow. It only reloads while `RUNNING`, `PAUSED`, or `CANCELLING` so completed/error dashboard views stay stable.
- `WorkspaceSessionManager` treats each lineage's _current_ file (the descriptor's `latestRunRef` run file, or its `draft/` if no run has executed yet) in run storage as the resume source of truth, and sorts sessions by `lastModifiedAt` first, then `startedAt`.
- `WorkspaceSessionManager` excludes lineages marked `isSystemGenerated` from recent-session discovery; persisted system runs remain available to history/search and usage-statistics paths.
- A lineage's first `createWorkingFile(...)` call writes only a `draft/workflow.ctrlyoke.json` plus the `workflow.json` descriptor — no run exists yet. The first non-continuation execution start (`WorkflowInstance.executeLoadedPromptFile`'s fresh-start branch, not append/idle-continuation) promotes it: `PromptQueue.promoteToNewRun()` → `WorkingFileManager.promoteToNewRun()` → `WorkflowLineageRepository.allocateRun()` mints a `RunRef`, moves the queue's `workingFilePath`/`runRef` to the new run, and removes the now-superseded draft. Every subsequent fresh start (a restart from completed/paused/stopped/error) promotes to _another_ new run the same way — this is what replaces the old "every fresh Run allocates a new history run" behavior now that the definition file lives inside the run directory too.
- Append continuations deliberately reuse the existing `workflowKey` and `runRef`; managed branch and directory names therefore stay unchanged, while a fresh re-run gets a new managed identity and resources.

</workingFilesAndSessions>

<historyModel>

- History lives in run storage under `<workflowKey>/run-<timestamp>/manifest.json` plus `events.jsonl`, alongside that same run's `workflow.ctrlyoke.json`; working files do **not** persist `outputHistory`.
- `TimelineRecorder` is the low-level append/update primitive. `initializeRunAt(runDir, ...)` only populates manifest/events inside a directory `WorkflowLineageRepository.allocateRun` already created — it does not mint the directory itself. Manifest writes are serialized per manifest path and wrapped in `withFileLock(...)`; do not hand-roll manifest or event writes elsewhere.
- `OutputHistoryTimelineAdapter` projects timeline storage back into `WorkflowOutputHistory`, sorting by `(timestampMs, sequence)` and grouping CLI output by target/run/attempt.
- `OutputHistoryManager.loadHistory()` enriches stored workspace snapshots on read (for example hydrating missing git-head `beforeContent`). If you bypass it and read recorder output directly, replay/search behavior will diverge.
- `CliWatchSession` is pinned to the exact `RunRef` named by the lineage's `runner.json` lock — it never follows "the newest run". A client browsing an older run of the same lineage cannot redirect it.
- History is always on (no `history.saveOutput` setting — removed). Retention is `runs.maxRuns` (`ConfigurationUtils.getMaxRuns()`), default `-1` (unbounded).
- `TimelineRecorder.commitDefinitionRevisionIfNewer` is the sole writer of `DEFINITION_REVISION_COMMITTED` events; it's a no-op (by design) for a run's starting revision (1) since the run's own `workflow.ctrlyoke.json`, written at promotion, is already that record — only later revisions (definition changes after the run started) get a timeline event. Call sites: `OutputHistoryManager.startStreamingExecutionOutput`/`saveExecutionOutput` via the optional `DefinitionRevisionContext` param, sourced from `WorkflowExecutionContext.getDefinitionRevisionContext()` (`WorkflowInstance.getDefinitionRevisionContext()`, built from the live `PromptQueue` state, not a snapshot taken at run start).
- `OutputHistoryManager.appendRuntimeTransition` also syncs `manifest.executionState` (not just the event log) on every transition, so manifest-only run listing (`getRunSummaries`) reflects paused/pausing/cancelling correctly, not just terminal states. `finalizeRun` still owns `completedAt`/`stepCount` and runs after this in the same per-manifest serialized queue.
- **A run's lifecycle state is recorded twice — `manifest.json` and its `workflow.ctrlyoke.json` `_runtime.executionState` — and the two can silently diverge.** The manifest exists because it is the header for `events.jsonl` (`nextSequence`/`eventCount` must move transactionally with each append, under the same lock) plus the run identity the mutable working-file head deliberately doesn't keep (`runId`, `initialDefinition`); `executionState`/`completedAt` are the only genuinely redundant part. Resolution rule, and the two halves differ on purpose: **display prefers the working file** (`readRunSummaryRecord` — the executor writes it on every transition, so it's the accurate one), while **deletion protection takes the union of both** (`getProtectedRunRefs` — "could this run be owned by an executor" must stay conservative, and a seeded-but-unstarted run is manifest-active while its working file is still idle). Don't collapse them into one rule. `RunSummary` stays webview-facing; the manifest copy rides along on the internal `RunSummaryRecord` so protection needs no extra I/O.
- **Every history writer early-returns on an empty `historyFilePath`, so a caller that lost the path writes _no_ timeline and gets no error.** `WorkflowInstance.activeHistoryFilePath` is assigned only by `startWorkflowExecution`, so an instance restored from a working file (host restart, resuming a run the previous host left paused) has none — hence `WorkflowInstance.resolveHistoryFilePath()`, which derives it from the queue's restored `workflowKey`/`runRef`. Read the path through that resolver, never off the field: the `paused -> running` transition fires before `startWorkflowExecution` assigns it. Nothing self-heals a miss — `recoverInterruptedRun` only repairs the newest run and only when the manifest says `RUNNING`.
- **An orphaned run is adoptable, and `RunContinuationService.validateContinuationTarget` must stay in step with `WorkflowOrchestrator.validateExplicitContinuationTarget`** (same contract, reached from CLI/MCP vs the dashboard). "Orphaned" means no resident instance owns it and no live lock names it, which covers `PAUSED` as well as `RUNNING`: pause is an in-memory executor state, so the original design treated ownerless-paused as impossible and refused it outright — but a host restart produces that shape routinely, which left paused runs permanently unresumable. The lock is the evidence that decides it; a paused run is the safer of the two to adopt (no in-flight harness turn, `currentIndex` on a clean step boundary). `executeContinuationAtRun` already handles the rest — it loads the run file and routes `PAUSED` into `resume()`.
- **`RunContinuationService.appendStepsToRun`'s immutable region is the run's _completed_ steps, not its whole existing queue, and the insert index must be resolved from the run file read inside `withFileLock`.** Both halves are easy to get wrong. A run's `manifest.json`/`events.jsonl` address recorded attempts by array index (`queue:<stepIndex>`), so displacing a step that has `_runtime.completedAt` silently re-attributes its output — that, and not "pending steps are frozen", is why the transaction guards a prefix at all; `immutablePrefixLength` computes it and clamps the requested index up past it. Everything after the execution head stays editable, matching `PromptQueue.assertEditableDuringExecution` and the mutable-run-head policy in `dev/implemented/RUN_HEAD_MUTABILITY_FOLLOWUP.md`. The lock scoping matters because this is a cross-process writer (MCP/CLI) with no view of the executing queue's in-memory `currentIndex`: resolving `next` from a caller's earlier `queue_status` snapshot lets the run advance in between and lands the insert on the wrong step. Read under the lock, the disk head is either exactly the executor's or one step behind it, and both land correctly. Share the arithmetic via `resolveQueueInsertIndex` in `DashboardConstants` rather than recomputing `currentIndex + 1`.
- `OutputHistoryManager.getRunSummaries(workflowKey)` is the manifest-only run listing (no event/definition loading). Its `primaryHarness`/`primaryModel`/mixed-flags disclosure reads each run's `workflow.ctrlyoke.json` and prefers each step's _actually-resolved_ `_runtime.harness`/`_runtime.model` over the declared `step.harness ?? workflowFile.harness` — it does not simulate global-config default resolution for steps that haven't executed yet.
- **That per-run `manifest.json` + `workflow.ctrlyoke.json` pair is cached by `RunSummaryCache`, and a new writer of either file must invalidate it.** The cache exists because the pair is the one genuinely O(runs) read on a view load and retention is off by default. Freshness rests on three mechanisms, and mechanism 2 cannot stand alone — Windows sets file timestamps from a ~15.6 ms clock tick, so two writes inside one tick share an mtime and `size` only narrows that: (1) **write-through** at the single writers, `writeWorkingFileAtomicTo`/`restoreSnapshotAtomic` in `WorkingFileManager` and `TimelineRecorder.writeManifestDirect` — hook new writers _there_, never at the mutation handler, since the executor's per-step `_runtime` writes never reach `invalidateRunViews`; (2) **stamp validation on read**, the only thing that can see the CLI binary, MCP server, or hosted server writing from another process — which is why callers must stamp _before_ reading (stamping after stores a newer stamp against older content and serves it until the next write); (3) the **`CliWatchSession` working-file watcher**, covering the one out-of-process writer that writes in a tight loop. What is cached is deliberately display-only: **no cached value may participate in a revision check**, so the addressed definition, the timeline, and the descriptor stay uncached and a stale entry can at worst show a wrong badge, never reject or lose an edit. The run _listing_ (`getRunsForWorkflow`'s readdir) is uncached too — one syscall, must never lag a promotion, and it makes deleted runs self-evicting.
- **Replace run/lineage files only through `AtomicFileUtils` (`writeFileAtomic` / `renameWithTransientRetry`) — a bare `temp + fs.rename` fails on Windows under ctrlyoke's own read load.** Every run view a client loads runs `getRunSummaries`, which reads _one working file per run in the lineage_ (see the bullet above), and every `RUN_VIEW_LOADED` reads the addressed definition and the descriptor. `rename` over an existing path is `MoveFileEx(REPLACE_EXISTING)`, which must delete the destination and raises `EPERM`/`EACCES`/`EBUSY` while another handle disallows that — so the executor's first `_runtime` write loses a race it creates itself. The reliable reproducer is a lineage's **first** run with two clients on the draft: publishing the run makes a directory appear, both clients are pulled onto it and scan it, and the write lands microseconds later — it failed 100% of the time, killing the run with `Failed to write working file: EPERM`. Retry only the transient codes; `EEXIST`/`ENOTEMPTY`/`ENOENT` are real answers callers act on (an `EEXIST` from the staging-directory publish _is_ the run-ref collision check).

</historyModel>

<workspaceAndTemplates>

- `WorkspaceInitializer` creates `.ctrlyoke/` and its `.gitignore` and **nothing else** — no subdirectories at all, runtime or user-facing. Every directory is created on demand by the consumer that first writes into it (the editor's convert action → `prompts/`, `createSampleScript` → `scripts/`, `TemplateImporter`/`TemplateManager.createCustomTemplate` → `templates/`, the Agents & Skills manager → `agents/`, `skills/`), and every reader treats an absent directory as empty. Adding a new `.ctrlyoke/` subdirectory means `mkdir`-ing at its writer, not extending init. Note that init's `mkdir` of `.ctrlyoke/` itself is now load-bearing: `ensureGitignore` writes into it, and `WorkflowOrchestrator` calls `Log.enableWorkspaceFileLogging()` immediately after on the assumption it exists.
- The generated `.gitignore` lists itself, so a fresh init leaves `git status` clean. Keep it that way: anything init writes must be covered by that file, or initializing ctrlyoke starts dirtying users' worktrees.
- Prompt files are produced by the editor's convert action under `.ctrlyoke/prompts/`; workflow files live at the `.ctrlyoke/` root.
- `TemplateImporter` copies from built extension manifests in `out/templates/...` into workspace locations and prompts before overwriting existing files. It is an import UI, not a template registry.

</workspaceAndTemplates>

<searchAndRecovery>

- `HistorySearchService` searches persisted timeline events, not in-memory workflow state. It scans runs newest-first and only indexes matchable CLI output / status-message content.
- Search results intentionally expose a working-file path as `workflowFilePath` — the descriptor's `latestRunRef` run file, or its draft if none — because the resume/load flow needs that file even when the original source file is missing or the workflow was created from the dashboard.
- `HistorySearchIndexService` is memory-sensitive — it rebuilds on history append and has OOM'd the extension host before. Keep it bounded and streamed: indexed text stays capped at `MAX_INDEXED_TEXT_LENGTH`, documents stream to/from disk (never a whole-index `JSON.stringify().join()`), and `rebuild(..., { retainDocuments })` lets write-only refreshers retain nothing while the single reader keeps one warm copy. The refresh is intentionally fire-and-forget, so disposal paths and tests must `await OutputHistoryManager.flushPendingIndexRefresh()` before deleting the workspace, or the background rebuild races the delete (`ENOTEMPTY` on `.search-index`).

</searchAndRecovery>

<pathRules>

- Use `WorkflowPaths` (`src/utils/WorkflowPaths.ts`) for every `.runs` path — root/lineage/draft/run/manifest/events/lock construction, validation, and parsing (`parseRunFilePath`, `parseRunArtifactPath`, `parseWorkingFileAddressFromPath`). Use `PATH_CONSTANTS` only for other folder names. This layer does a lot of path joining and it is easy to accidentally hardcode `.ctrlyoke` details or reconstruct a `.runs` path ad hoc.

</pathRules>

<entryPoints>

- `PromptFileLoader.ts`
- `OutputHistoryManager.ts`
- `WorkflowLineageRepository.ts`
- `CliWatchSession.ts`
- `HistorySearchService.ts`
- `WorkspaceInitializer.ts`

</entryPoints>
