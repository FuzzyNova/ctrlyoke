---
applyTo: "src/flightpath/orchestration/**"
---

<purpose>
Support classes for `WorkflowOrchestrator` and `WorkflowInstance`. Handles file I/O, workspace lifecycle, session persistence, output history, file watching, and command routing. None of these classes own execution state — they are helpers owned and composed by the top-level flightpath classes.
</purpose>

<components>

## PromptFileLoader

**Responsibility:** Prompt file I/O, auto-save, working file creation, and validation.
**Owned by:** `WorkflowInstance`
**Key operations:**

- `loadPromptFile(filePath, workspaceFolderPath)` — parses the file, validates steps via `PromptFileParser`, creates a working file in `.flightpath/.queue/`, and copies workflow-level properties into it
- Auto-saves dirty VS Code editors before reading the file on disk
- `reloadFromWorkingFile(workingFilePath)` — reloads queue state when an MCP or dynamic queue append modifies the working file

## PromptFileWatcher

**Responsibility:** File system monitoring for working files (live reload).
**Owned by:** `WorkflowInstance`
**Key behavior:**

- Watches the **working file** (in `.flightpath/.queue/`), not the original prompt file
- Triggers queue reload only during active states (`RUNNING`, `PAUSED`, `CANCELLING`) — never reloads on `IDLE`, `COMPLETED`, or `ERROR`
- Disposes the previous `vscode.FileSystemWatcher` automatically when `setupFileWatcher()` is called again
- Fires `onFileDeleted` callback when the working file is removed (cleanup path)

## WorkspaceInitializer

**Responsibility:** First-run workspace scaffold and idempotent re-initialization.
**Static class** — no instance state; called on every activation.
**`initializeIfNeeded(workspaceRoot)`** creates all user-facing directories (`workflows/`, `prompts/`, `scripts/`, `agents/`, `skills/`, `templates/`) and writes `.flightpath/.gitignore` excluding runtime dirs (`.queue/`, `.history/`, `.logs/`, `temp/`).
**`reinitialize(workspaceRoot)`** — re-runs scaffold without overwriting existing files; safe to call any time.
**Runtime directories** (`.queue/`, `.history/`, `.logs/`, `temp/`) are intentionally excluded from `USER_DIRECTORIES` — they are created on demand by their respective managers.

## WorkspaceSessionManager

**Responsibility:** Session discovery and auto-load after VS Code restart or crash.
**Owned by:** `WorkflowOrchestrator`
**`autoLoadRecentSession(workspaceFolderPath, onLoad)`** scans `.flightpath/.queue/` for the most recently modified working file and invokes the `onLoad` callback with its path. Errors are silently logged — never surfaced as user notifications.
**`getMostRecentWorkingFilePath(workspaceFolderPath)`** — returns the path of the most recently modified working file without triggering a load callback.
**`discoverPromptFiles(workspaceFolderPath)`** — discovers all `.flightpath.yaml`, `.flightpath.json`, and `.prompt.md` files in the workspace for the file picker UI.
**`discoverSessions(workspaceFolderPath)`** — returns working files paired with their parsed workflow state for session listing in the dashboard.

## OutputHistoryManager

**Responsibility:** Per-run output history stored under `.flightpath/.history/<workflow-id>/`.
**Owned by:** `WorkflowInstance`
**Storage model:**

- Each run gets a subdirectory `run-<timestamp>/` containing `manifest.json` + `events.jsonl`
- Disk is the authoritative source — working files do NOT track `outputHistory`
- History is a self-contained snapshot that renders independently of current prompts

**Key methods:**

- `initializeRun(workingFilePath)` / `finalizeRun(state)` — lifecycle for a single execution run
- `saveExecutionOutput(output, stepIndex)` — writes CLI output events via `TimelineRecorder`
- `appendStatusMessage(message)` / `appendRuntimeTransition(event)` — appends non-output timeline events
- `saveSnapshotForTarget(stepIndex)` — saves a point-in-time snapshot for the specified step
- `loadHistory(historyFilePath)` — reads a specific run directory and returns `WorkflowOutputHistory`
- `getRunsForWorkflow(workflowId)` — returns all run directory paths for a workflow
- `getLatestHistoryFilePath(workflowId)` — returns the most recent run's manifest path
- `getRunTimestamps(workflowId)` / `getRunStates(workflowId)` — metadata queries across runs
- `pruneOldRuns(workflowId, maxRuns)` — removes oldest runs beyond the retention limit
- `saveUndoRecord(record)` / `markUndoRecordRedone(id)` — undo history persistence
- `isHistoryEnabled()` — gates all writes via `ConfigurationUtils.isSaveOutputHistoryEnabled()`
- `extractWorkflowId(workingFilePath)` — derives workflow ID from working file path

## TimelineRecorder

**Responsibility:** Low-level structured timeline event writer for the history store.
**Storage format:** `manifest.json` (run metadata) + `events.jsonl` (one event per line, append-only)
**Concurrency safety:** All manifest writes are serialized through a per-path `manifestOperationQueues` map using `withFileLock` to prevent corruption during concurrent writes.
**Static helpers:**

- `createRunDirectoryName(timestampMs)` — `run-<ISO-timestamp>` directory name
- `extractRunTimestamp(entryName)` — parse timestamp from a run directory name
- `isTimelineRunDirectory(name)` / `isLegacyRunFile(name)` / `isRunEntry(entry)` — distinguish run entry types
- `getManifestPathForRunDirectory(runDirectoryPath)` — resolves manifest path from run directory
- `getEventsPathFromManifestPath(manifestPath)` — resolves events path from manifest path

**Instance methods:**

- `readManifest(manifestPath)` — reads and parses `manifest.json`
- `readEvents(manifestPath)` — reads and parses all events from `events.jsonl`

## OutputHistoryTimelineAdapter

**Responsibility:** Projects `TimelineRecorder` output (manifest + events) into `WorkflowOutputHistory` for the dashboard.
**Bridges:** new timeline event format (`WorkflowTimelineEvent`) → legacy history display types (`WorkflowOutputHistory`, `OrderedHistoryEntry`, `StepOutput`)
**`loadHistory(manifestPath)`** — reads manifest and events in parallel, then calls `project()`.
**`project(manifest, events)`** — deterministic, pure projection; events are sorted by sequence number before processing.

## TemplateImporter

**Responsibility:** Import built-in agents and workflow templates into the workspace.
**Owned by:** `WorkflowOrchestrator`
**Operations:**

- `importAgents()` — copies bundled agent files to `.github/agents/` with overwrite confirmation
- `importWorkflowTemplates()` — copies bundled workflow templates to `.flightpath/templates/`
- Reads manifests (`agents/manifest.json`, `workflows/manifest.json`) from the extension's `out/` directory
- Prompts the user before overwriting existing files
  **`setWorkspaceFolder(folder)`** — called by `WorkflowOrchestrator` when the active workspace folder changes.

## WorkflowCommandHandler

**Responsibility:** VS Code command routing and user-facing file creation operations.
**Owned by:** `WorkflowOrchestrator`
**Commands handled:**

- `createPromptFile()` — prompts for a filename (respects `defaultWorkflowFormat` setting), creates file via `TemplateManager`, opens in editor
- `createDraftPrompt()` — creates a timestamped `.prompt.md` in `.flightpath/prompts/`
- `createEndConditionScript()` — creates a validation script stub in `.flightpath/scripts/`
- `createNewTemplate()` — creates a new workflow template from the current prompt file
- `openPanel()` — opens the FlightPath dashboard panel
- `openCurrentPromptFile()` — opens the currently loaded prompt file in the editor
  **`setWorkspaceFolder(folder)`** — called by `WorkflowOrchestrator` when the active workspace folder changes.

## CliWatchSession

**Responsibility:** Passive observation of a CLI-managed workflow's progress via file watchers.
**Owned by:** `WorkflowOrchestrator` (in `cliSessions` map); implements `vscode.Disposable`.
**Three watchers:**

1. **Working file watcher** — tracks step progress (`currentIndex`, `executionState`)
2. **History file watcher** — streams CLI output chunks to the dashboard
3. **Lock file watcher** — detects workflow completion (lock deleted = CLI finished)
   **Heartbeat poll:** 10-second fallback poll to detect stale locks (CLI crash where lock file remains but heartbeat is stale).
   **`onFinished` event** — fired when the lock is deleted or goes stale; `WorkflowOrchestrator` disposes the session on this event.
   **Helper exports:**

- `getHistoryRunTimestamp(historyFilePath)` — extracts numeric timestamp from a history file path
- `getRunEntryNameForHistoryPath(historyFilePath)` — extracts the run entry name from a history file path
- `isNewerHistoryRunPath(candidate, active)` — compares two run paths by timestamp for most-recent detection
  </components>

<patterns>

## Ownership Model

| Class                     | Owner                                    |
| ------------------------- | ---------------------------------------- |
| `PromptFileLoader`        | `WorkflowInstance`                       |
| `PromptFileWatcher`       | `WorkflowInstance`                       |
| `OutputHistoryManager`    | `WorkflowInstance`                       |
| `TemplateImporter`        | `WorkflowOrchestrator`                   |
| `WorkflowCommandHandler`  | `WorkflowOrchestrator`                   |
| `WorkspaceSessionManager` | `WorkflowOrchestrator`                   |
| `CliWatchSession`         | `WorkflowOrchestrator` (cliSessions map) |
| `WorkspaceInitializer`    | Called from `extension.ts` activation    |

`TimelineRecorder` and `OutputHistoryTimelineAdapter` are internal to `OutputHistoryManager` — never reference them directly from outside the `orchestration/` directory.

## No Execution State

None of these classes hold workflow execution state (`status`, `currentIndex`, `results`). All execution state lives in `PromptQueue`, `WorkflowStateMachine`, and `WorkflowInstance`. Orchestration classes receive callbacks or query state through `promptQueue.getState()` — they never mutate it directly.

## File Paths

All paths go through `PATH_CONSTANTS` from `ConfigurationUtils` — never hardcode `.flightpath`, `.queue`, `.history`, etc. Use `ConfigurationUtils.getPromptsDirectory()` for the user-configurable prompts directory root.

## setWorkspaceFolder Pattern

`TemplateImporter` and `WorkflowCommandHandler` both hold a `currentWorkspaceFolder` reference. `WorkflowOrchestrator` updates it by calling `setWorkspaceFolder()` on both when the active workspace changes. All command handlers must guard with an early return and error message if `currentWorkspaceFolder` is undefined.

## History Storage Contract

- `manifest.json` — run-level metadata (`workflowId`, `runId`, `startedAt`, `completedAt`, `executionState`, prompt summaries)
- `events.jsonl` — append-only CLI output and runtime transition events (one JSON object per line)
- Legacy format: `run-<timestamp>.json` (single-file, pre-timeline) — `TimelineRecorder` detects and reads both formats; writes only the new format
- History directory layout: `.flightpath/.history/<workflow-id>/run-<timestamp>/manifest.json` + `events.jsonl`
  </patterns>

<relatedFiles>
- `../WorkflowInstance.ts` — Owns `PromptFileLoader`, `PromptFileWatcher`, `OutputHistoryManager`
- `../WorkflowOrchestrator.ts` — Owns `TemplateImporter`, `WorkflowCommandHandler`, `WorkspaceSessionManager`, `CliWatchSession`
- `../../types/OutputHistoryTypes.ts` — `WorkflowOutputHistory`, `OrderedHistoryEntry`, `StepOutput`, `UndoRecord`
- `../../types/WorkflowTimelineTypes.ts` — `WorkflowRunManifest`, `WorkflowTimelineEvent`, `TIMELINE_EVENT_TYPES`
- `../../utils/ConfigurationUtils.ts` — `PATH_CONSTANTS`, settings access
- `../../utils/FileLockUtils.ts` — `withFileLock` concurrency wrapper used by `TimelineRecorder`
</relatedFiles>
