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
- `WorkspaceSessionManager` treats each lineage's *current* file (the descriptor's `latestRunRef` run file, or its `draft/` if no run has executed yet) under `.ctrlyoke/.runs/` as the resume source of truth, and sorts sessions by `lastModifiedAt` first, then `startedAt`.
- A lineage's first `createWorkingFile(...)` call writes only a `draft/workflow.ctrlyoke.json` plus the `workflow.json` descriptor — no run exists yet. The first non-continuation execution start (`WorkflowInstance.executeLoadedPromptFile`'s fresh-start branch, not append/idle-continuation) promotes it: `PromptQueue.promoteToNewRun()` → `WorkingFileManager.promoteToNewRun()` → `WorkflowLineageRepository.allocateRun()` mints a `RunRef`, moves the queue's `workingFilePath`/`runRef` to the new run, and removes the now-superseded draft. Every subsequent fresh start (a restart from completed/paused/stopped/error) promotes to *another* new run the same way — this is what replaces the old "every fresh Run allocates a new history run" behavior now that the definition file lives inside the run directory too.

</workingFilesAndSessions>

<historyModel>

- History lives under `.ctrlyoke/.runs/<workflowKey>/run-<timestamp>/manifest.json` plus `events.jsonl`, alongside that same run's `workflow.ctrlyoke.json`; working files do **not** persist `outputHistory`.
- `TimelineRecorder` is the low-level append/update primitive. `initializeRunAt(runDir, ...)` only populates manifest/events inside a directory `WorkflowLineageRepository.allocateRun` already created — it does not mint the directory itself. Manifest writes are serialized per manifest path and wrapped in `withFileLock(...)`; do not hand-roll manifest or event writes elsewhere.
- `OutputHistoryTimelineAdapter` projects timeline storage back into `WorkflowOutputHistory`, sorting by `(timestampMs, sequence)` and grouping CLI output by target/run/attempt.
- `OutputHistoryManager.loadHistory()` enriches stored workspace snapshots on read (for example hydrating missing git-head `beforeContent`). If you bypass it and read recorder output directly, replay/search behavior will diverge.
- `CliWatchSession` is pinned to the exact `RunRef` named by the lineage's `runner.json` lock — it never follows "the newest run". A client browsing an older run of the same lineage cannot redirect it.
- History is always on (no `history.saveOutput` setting — removed). Retention is `runs.maxRuns` (`ConfigurationUtils.getMaxRuns()`), default `-1` (unbounded).
- `TimelineRecorder.commitDefinitionRevisionIfNewer` is the sole writer of `DEFINITION_REVISION_COMMITTED` events; it's a no-op (by design) for a run's starting revision (1) since the run's own `workflow.ctrlyoke.json`, written at promotion, is already that record — only later revisions (definition changes after the run started) get a timeline event. Call sites: `OutputHistoryManager.startStreamingExecutionOutput`/`saveExecutionOutput` via the optional `DefinitionRevisionContext` param, sourced from `WorkflowExecutionContext.getDefinitionRevisionContext()` (`WorkflowInstance.getDefinitionRevisionContext()`, built from the live `PromptQueue` state, not a snapshot taken at run start).
- `OutputHistoryManager.appendRuntimeTransition` also syncs `manifest.executionState` (not just the event log) on every transition, so manifest-only run listing (`getRunSummaries`) reflects paused/pausing/cancelling correctly, not just terminal states. `finalizeRun` still owns `completedAt`/`stepCount` and runs after this in the same per-manifest serialized queue.
- `OutputHistoryManager.getRunSummaries(workflowKey)` is the manifest-only run listing (no event/definition loading). Its `primaryHarness`/`primaryModel`/mixed-flags disclosure reads each run's `workflow.ctrlyoke.json` and prefers each step's *actually-resolved* `_runtime.harness`/`_runtime.model` over the declared `step.harness ?? workflowFile.harness` — it does not simulate global-config default resolution for steps that haven't executed yet.

</historyModel>

<workspaceAndTemplates>

- `WorkspaceInitializer` only scaffolds user-facing directories plus `.ctrlyoke/.gitignore`. `.runs/`, `logs/`, and `temp/` are intentionally created lazily by their owning managers.
- `WorkflowCommandHandler.createPromptFile()` writes new workflow files at the `.ctrlyoke/` root, while `createDraftPrompt()` writes timestamped scratch prompts under `.ctrlyoke/prompts/`. Keep that distinction.
- `TemplateImporter` copies from built extension manifests in `out/templates/...` into workspace locations and prompts before overwriting existing files. It is an import UI, not a template registry.

</workspaceAndTemplates>

<searchAndRecovery>

- `HistorySearchService` searches persisted timeline events, not in-memory workflow state. It scans runs newest-first and only indexes matchable CLI output / status-message content.
- Search results intentionally expose a working-file path as `workflowFilePath` — the descriptor's `latestRunRef` run file, or its draft if none — because the resume/load flow needs that file even when the original source file is missing or the workflow was created from the dashboard.
- `HistorySearchIndexService` is memory-sensitive — it rebuilds on history append and has OOM'd the extension host before. Keep it bounded and streamed: indexed text stays capped at `MAX_INDEXED_TEXT_LENGTH`, documents stream to/from disk (never a whole-index `JSON.stringify().join()`), and `rebuild(..., { retainDocuments })` lets write-only refreshers retain nothing while the single reader keeps one warm copy. The refresh is intentionally fire-and-forget, so disposal paths and tests must `await OutputHistoryManager.flushPendingIndexRefresh()` before deleting the workspace, or the background rebuild races the delete (`ENOTEMPTY` on `.search-index`).

</searchAndRecovery>

<pathRules>

- Use `WorkflowPaths` (`src/utils/WorkflowPaths.ts`) for every `.runs` path — root/lineage/draft/run/manifest/events/lock construction, validation, and parsing (`parseRunFilePath`, `parseRunArtifactPath`, `parseWorkingFileAddressFromPath`). Use `PATH_CONSTANTS` (and `ConfigurationUtils.getPromptsDirectory()` when applicable) only for other folder names. This layer does a lot of path joining and it is easy to accidentally hardcode `.ctrlyoke` details or reconstruct a `.runs` path ad hoc.

</pathRules>

<entryPoints>

- `PromptFileLoader.ts`
- `OutputHistoryManager.ts`
- `WorkflowLineageRepository.ts`
- `CliWatchSession.ts`
- `HistorySearchService.ts`
- `WorkspaceInitializer.ts`

</entryPoints>
