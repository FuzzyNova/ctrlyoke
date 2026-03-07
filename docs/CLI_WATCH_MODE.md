# CLI Watch Mode

When the extension detects a workflow with an `active-cli` lock file — on startup or via a new
lock appearing — it enters **CLI Watch Mode**: a read-only dashboard view that mirrors live
progress from the CLI's writes to the working file and history.

---

## Concept

The VS Code extension and the FlightPath CLI share `.flightpath/.queue/` and `.flightpath/.history/`.
The CLI writes to these files; the extension only reads them in watch mode. This gives the user
visibility into a CLI-driven run without the extension interfering.

Watch mode is non-exclusive and non-blocking:

- The user can open other workflows normally alongside a CLI-watched workflow.
- The extension never writes to the working file or history file while in watch mode.
- When the CLI finishes, the dashboard seamlessly transitions back to normal state.

---

## Implementation

### Type layer: `WorkflowSummary.managedBy`

`src/types/FlightPathTypes.ts` adds one optional field to `WorkflowSummary`:

```typescript
managedBy?: "vscode" | "cli"; // undefined = vscode (backward-compatible)
```

`managedBy: "cli"` is set when `checkLock` returns `"active-cli"`. All downstream UI reads this
to switch into read-only mode.

---

### `CliWatchSession` — `src/flightpath/orchestration/CliWatchSession.ts`

Owns **three file watchers** for a single CLI-managed workflow, plus a heartbeat staleness poll:

#### 1. Working file watcher

Watches `.flightpath/.queue/{workflowId}.flightpath.json` for changes.  
On change: re-reads the working file, extracts `_runtime.currentIndex` and `executionState`,
calls `onUpdate(partialSummary)` to push step progress to the dashboard.  
Includes a 50 ms retry on JSON parse errors (file mid-write protection).

#### 2. History file watcher

On startup, finds the most recent `run-*.json` in `.flightpath/.history/{workflowId}/`
synchronously. Calls `onOutput(historyFilePath)` to stream CLI output to the dashboard.  
Also watches the history directory for new `run-*.json` files (new run started by CLI) and
switches to the new file automatically.

#### 3. Lock file watcher (`{workflowId}.runner.json` deletion)

Fires `onFinished()` when the lock file is deleted (normal CLI exit or Ctrl+C).

#### Heartbeat staleness poll

Runs every 10 seconds while in watch mode. If `Date.now() - lastHeartbeat > 30 s`, treats the
lock as stale (CLI crashed) and fires `onFinished()`.

```typescript
export class CliWatchSession implements vscode.Disposable {
  async start(): Promise<void>; // set up all 3 watchers + heartbeat poll
  dispose(): void; // clear interval + dispose all watchers
}
```

---

### `WorkflowOrchestrator` — `src/flightpath/WorkflowOrchestrator.ts`

Manages `CliWatchSession` instances keyed by `workflowId`.

#### Entry Point 1: Extension startup

`setupCliWatching()` calls `WorkflowLockManager.normalizeStaleLocks(queueDir)` to find all
`active-cli` working files, then calls `startCliWatchSession()` for each one.

#### Entry Point 2: User opens a CLI-running workflow

`loadWorkingFile()` calls `checkLock()` → if `active-cli`, calls `startCliWatchSession()` before
returning the loaded summary with `managedBy: "cli"`.

`ensureCliWatchSession(workingFilePath)` is also available as a fallback for the case where a
workflow was loaded but its watch session hadn't been created yet.

#### Entry Point 3: CLI starts a workflow while VS Code is open

A persistent `*.runner.json` `onDidCreate` watcher fires when the CLI creates a new lock file.
The orchestrator reads the lock, classifies it as `active-cli`, and calls `startCliWatchSession()`.

#### Session teardown

When `CliWatchSession.onFinished()` fires:

1. Disposes the `CliWatchSession`.
2. Re-reads the working file from disk.
3. If still `executionState === "running"` (CLI crashed), normalizes to `STOPPED` on disk.
4. Sets `managedBy` to `undefined` (workflow back to VS Code ownership).
5. Pushes updated `WorkflowSummary` (now `STOPPED` or `COMPLETED`) to the dashboard.

---

## UI Layer (Webview)

### Running workflows dropdown — `RunningWorkflowItem.tsx`

When `workflow.managedBy === "cli"`:

```
[workflow-name]   RUNNING   0:32   [CLI]
```

A blue `CLI` pill replaces the pause/stop buttons.

### Main panel read-only mode

Five components check `managedBy === "cli"` and gate their controls accordingly:

| Component            | Read-only behaviour                               |
| -------------------- | ------------------------------------------------- |
| `WorkflowStatus.tsx` | Shows a "CLI" badge next to the workflow name     |
| `Header.tsx`         | Hides run/pause/stop toolbar buttons              |
| `PromptsPanel.tsx`   | Disables drag-to-reorder, add/remove, inline edit |
| `EditorSection.tsx`  | Prompts editor disabled                           |
| `SettingsDrawer.tsx` | All inputs disabled                               |

Live output still appears in the output panel via `CLI_WATCH_OUTPUT` messages
(handled in `useMessageHandler.ts`).

---

## Files

| File                                                               | Role                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/types/FlightPathTypes.ts`                                     | `managedBy?: "vscode" \| "cli"` on `WorkflowSummary`                                           |
| `src/flightpath/orchestration/CliWatchSession.ts`                  | Owns working-file, history, and lock-file watchers for one CLI-run workflow                    |
| `src/flightpath/WorkflowOrchestrator.ts`                           | Creates/disposes `CliWatchSession` instances; `*.runner.json` create watcher for Entry Point 3 |
| `src/ui/webview-react/components/workflow/RunningWorkflowItem.tsx` | CLI pill badge instead of pause/stop                                                           |
| `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`      | CLI badge next to workflow name                                                                |
| `src/ui/webview-react/components/layout/Header.tsx`                | Hides run toolbar in watch mode                                                                |
| `src/ui/webview-react/components/layout/PromptsPanel.tsx`          | Disables prompt editing in watch mode                                                          |
| `src/ui/webview-react/components/layout/EditorSection.tsx`         | Disables editor in watch mode                                                                  |
| `src/ui/webview-react/components/layout/SettingsDrawer.tsx`        | Disables settings in watch mode                                                                |
| `src/ui/webview-react/hooks/useMessageHandler.ts`                  | Handles `CLI_WATCH_OUTPUT` messages                                                            |

---

## Edge Cases

### CLI writes faster than the file watcher fires

File system watchers may batch rapid writes. Each watcher callback reads the full current file
content and diffs against last-known state — no output is lost as long as every OS notification
triggers a read.

### Working file mid-write (Windows/Unix non-atomic writes)

`handleWorkingFileChange` catches JSON parse errors and retries once after 50 ms.

### Multiple workspaces each running a CLI workflow

`CliWatchSession` is per-workflow-id and per-workspace. Each `WorkflowOrchestrator` handles its
own workspace's queue directory — no cross-workspace conflicts.

### History saving disabled in settings

The CLI may still write history files regardless of the VS Code setting. If no history file is
found, the output panel stays empty in watch mode, but step progress (from the working file)
still updates normally.

### User stops the CLI externally (Ctrl+C)

CLI's SIGINT handler calls `releaseLock()` → lock file deleted → `CliWatchSession` `onDidDelete`
fires → `onFinished()` → workflow transitions to `STOPPED`.

---

## Out of Scope (Future)

- **Bidirectional control**: Sending pause/stop commands from VS Code to the CLI process (requires
  IPC beyond the lock file — e.g. a signal file the CLI polls).
- **CLI output while VS Code is closed**: History is already written to disk by the CLI; when VS
  Code reopens, the completed run appears in the run history viewer as normal.
