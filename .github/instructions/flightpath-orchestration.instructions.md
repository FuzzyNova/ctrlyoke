---
applyTo: "src/flightpath/orchestration/**"
---

<purpose>
Disk/UI-facing orchestration helpers for workflow loading, session recovery, history persistence, and workspace scaffolding. These files support `WorkflowInstance`, `WorkflowOrchestrator`, and the webview, but they should not become alternate owners of execution state.
</purpose>

<ownership>

- `WorkflowInstance` owns `PromptFileLoader`, `PromptFileWatcher`, and `OutputHistoryManager`.
- `WorkflowOrchestrator` owns `TemplateImporter`, `WorkflowCommandHandler`, `WorkspaceSessionManager`, and any live `CliWatchSession` instances.
- `HistorySearchService` is the exception: it is stateless and currently UI-owned (`FlightPathWebviewProvider` / `WebviewMessageRouter`), not orchestrator-owned.
- `TimelineRecorder` and `OutputHistoryTimelineAdapter` are internal history primitives; most callers should go through `OutputHistoryManager` instead of reading/appending timeline files directly.

</ownership>

<workingFilesAndSessions>

- `PromptFileLoader` is the bridge from parsed prompt file → queue working file. After `createWorkingFile(...)`, it copies workflow-level execution properties from the source file, then fills remaining defaults from settings so the in-memory `PromptFile` and on-disk working file stay aligned.
- Reload mode matters: `replace` restores an existing session, `merge` appends new steps from disk, and `auto` chooses based on current runtime state. Use merge paths for MCP/dynamic-queue extension; do not clear and rebuild queue state manually.
- `PromptFileWatcher` watches the working file, not the source workflow. It only reloads while `RUNNING`, `PAUSED`, or `CANCELLING` so completed/error dashboard views stay stable.
- `WorkspaceSessionManager` treats `.flightpath/.queue/*.flightpath.json` as the resume source of truth and sorts sessions by `lastModifiedAt` first, then `startedAt`.

</workingFilesAndSessions>

<historyModel>

- History lives under `.flightpath/.history/<workflow-id>/run-<timestamp>/manifest.json` plus `events.jsonl`; working files do **not** persist `outputHistory`.
- `TimelineRecorder` is the low-level append/update primitive. Manifest writes are serialized per manifest path and wrapped in `withFileLock(...)`; do not hand-roll manifest or event writes elsewhere.
- `OutputHistoryTimelineAdapter` projects timeline storage back into `WorkflowOutputHistory`, sorting by `(timestampMs, sequence)` and grouping CLI output by target/run/attempt.
- `OutputHistoryManager.loadHistory()` enriches stored workspace snapshots on read (for example hydrating missing git-head `beforeContent`). If you bypass it and read recorder output directly, replay/search behavior will diverge.
- `CliWatchSession` follows the newest history run for a workflow and switches when a newer run directory appears. That is what lets the VS Code dashboard track headless/CLI-owned runs correctly.

</historyModel>

<workspaceAndTemplates>

- `WorkspaceInitializer` only scaffolds user-facing directories plus `.flightpath/.gitignore`. Runtime directories like `.queue`, `.history`, `logs`, and `temp` are intentionally created lazily by their owning managers.
- `WorkflowCommandHandler.createPromptFile()` writes new workflow files at the `.flightpath/` root, while `createDraftPrompt()` writes timestamped scratch prompts under `.flightpath/prompts/`. Keep that distinction.
- `TemplateImporter` copies from built extension manifests in `out/templates/...` into workspace locations and prompts before overwriting existing files. It is an import UI, not a template registry.

</workspaceAndTemplates>

<searchAndRecovery>

- `HistorySearchService` searches persisted timeline events, not in-memory workflow state. It scans runs newest-first and only indexes matchable CLI output / status-message content.
- Search results intentionally expose the queue working-file path as `workflowFilePath`, because the resume/load flow needs the `.flightpath/.queue/...` file even when the original source file is missing or the workflow was created from the dashboard.

</searchAndRecovery>

<pathRules>

- Use `PATH_CONSTANTS` (and `ConfigurationUtils.getPromptsDirectory()` when applicable) for folder names. This layer does a lot of path joining and it is easy to accidentally hardcode `.flightpath` details.

</pathRules>

<entryPoints>

- `PromptFileLoader.ts`
- `OutputHistoryManager.ts`
- `CliWatchSession.ts`
- `HistorySearchService.ts`
- `WorkspaceInitializer.ts`

</entryPoints>
