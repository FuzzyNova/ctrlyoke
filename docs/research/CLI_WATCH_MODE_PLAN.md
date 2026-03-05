# CLI Watch Mode Plan

Companion to `STALE_RUNNING_STATE_AND_COORDINATION_PLAN.md` (Phase 2).

When the extension detects a workflow with an `active-cli` lock file on startup or during live
monitoring, instead of normalizing its state to STOPPED it enters **CLI Watch Mode** — a read-only
webview that mirrors live progress from the CLI's writes to the working file and history.

---

## Concept

The VS Code extension and the FlightPath CLI share `.flightpath/.queue/` and `.flightpath/.history/`.
The CLI writes to these files; the extension only reads them in watch mode. This gives the user
visibility into a CLI-driven run without the extension interfering.

Watch mode is non-exclusive and non-blocking:
- The user can open other workflows normally alongside a CLI-watched workflow.
- The extension never writes to the working file or history file while in watch mode.
- When the CLI finishes, the webview seamlessly transitions back to normal state.

---

## What "CLI Watch Mode" Means Per Layer

### `WorkflowSummary` (type layer)

Add one optional field to `FlightPathTypes.ts`:

```typescript
export interface WorkflowSummary {
  // ... existing fields ...
  managedBy?: "vscode" | "cli"; // undefined = vscode (backward-compatible)
}
```

`managedBy: "cli"` is set when `checkLock` returns `"active-cli"`. All downstream UI reads this
to switch into read-only mode. No other field changes needed.

### Dropdown (RunningWorkflowItem)

When `managedBy === "cli"`:
- Replace pause/stop icon buttons with a static **"CLI"** pill badge (e.g. `bg-blue-500` text).
- Show step progress (`currentStep / totalSteps`) as normal — this is still useful.
- Clicking the item switches the main panel to that workflow (in read-only mode), same as today.
- No pulsing dot change needed — the existing "another workflow is running" dot still applies.

Mockup (RunningWorkflowItem row):
```
[workflow-name]  2 / 5 steps   [CLI]
```
vs. normal:
```
[workflow-name]  2 / 5 steps   [⏸] [⏹]
```

### Main Panel (WorkflowStatus + PromptList + OutputPanel)

When the active workflow has `managedBy === "cli"`:

**Banner** (top of panel, dismissable per-session):
```
┌─────────────────────────────────────────────────────────────────┐
│  ⚡ Running via FlightPath CLI — panel is read-only              │
│  Output updates live. Controls are disabled until CLI finishes. │  [×]
└─────────────────────────────────────────────────────────────────┘
```

**Prompt list**: renders normally (completed prompts shown as completed, current as running).
All edit controls (drag-to-reorder, add/remove prompt, inline edit) are disabled.

**Output panel**: live-updating — see Live Update Mechanism below. No "Clear output" button.

**Run/Pause/Stop toolbar buttons**: hidden or replaced with the "CLI" pill badge.

**Settings / Properties drawer**: read-only (inputs disabled, no save button).

---

## Live Update Mechanism

The CLI writes to two locations that the extension watches:

### 1. Working file watcher

`.flightpath/.queue/{workflowId}.flightpath.json` is updated by the CLI when prompts complete
(their `_runtime.completedAt` is set). Watching this file lets the extension track step-level
progress without polling.

- Use `vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolderPath, ".flightpath/.queue/{workflowId}.flightpath.json"))`.
- On change: re-read the working file; update `WorkflowSummary.currentStep`, `totalSteps`, and
  each prompt's `_runtime` state; push a `WORKFLOW_SUMMARY_UPDATED` message to the webview.
- This drives the prompt list's status icons updating in real time.

### 2. History file watcher

`.flightpath/.history/{workflowId}/run-{timestamp}.json` is the active run's output record.
The CLI writes CLI output chunks to this file as they arrive.

- On watch mode entry, identify the active history file: read the `.history/{workflowId}/`
  directory, take the most recently modified `run-*.json`.
- Use `vscode.workspace.createFileSystemWatcher` on that specific file.
- On change: read the file, diff against last-sent `promptOutputs`, send only new output chunks
  to the webview via the existing `CLI_OUTPUT` message type. The webview appends to the output
  panel as normal.
- If a new `run-*.json` appears (CLI started a new run of the same workflow): switch to watching
  the new file and clear webview output.

### 3. Lock file watcher (completion detection)

`.flightpath/.queue/{workflowId}.runner.json` is deleted by the CLI on normal finish or stop.
On crash, it goes stale (heartbeat stops).

**Deletion detection**: use `vscode.workspace.createFileSystemWatcher` with the `onDidDelete`
event on `{workflowId}.runner.json`.

**Staleness detection** (covers CLI crash): poll `lastHeartbeat` in the lock file every 10 seconds
while in watch mode. If `Date.now() - lastHeartbeat > 30s`, treat as stale → CLI is gone.

On lock gone (deleted or stale):
1. Stop all three file watchers.
2. Re-read the working file from disk.
3. If `_runtime.executionState === "running"` (CLI crashed before writing final state):
   normalize to STOPPED on disk and in memory.
4. Set `managedBy` to `undefined` (back to vscode-owned).
5. Push updated `WorkflowSummary` (now STOPPED or COMPLETED) to webview.
6. The banner disappears; controls re-enable; user can resume or inspect.

---

## Watch Mode Entry Points

### Entry Point 1: Extension startup

`normalizeStaleLocks` already iterates all queue files. When it encounters `active-cli`:
- Do NOT normalize to STOPPED.
- Create a `CliWatchSession` for that workflow (see Implementation below).
- Load the workflow into `loadedWorkflows` with `managedBy: "cli"` and the state from disk.

### Entry Point 2: User opens a CLI-running workflow from the dropdown

The user clicks a recent workflow entry that happens to be CLI-managed:
- `handleSelectWorkflow(filePath)` fires → `LOAD_WORKFLOW` message → extension loads it.
- During load, `checkLock` is called → returns `"active-cli"` → enter watch mode.
- Same `CliWatchSession` creation as above.

### Entry Point 3: CLI starts a workflow while VS Code is open

The CLI writes a new lock file for a workflow the extension may or may not have loaded.
- The extension's `vscode.workspace.createFileSystemWatcher` on `*.runner.json` fires `onDidCreate`.
- Extension reads the lock, classifies as `active-cli`.
- If the workflow is already in `loadedWorkflows` (unlikely but possible): transition it into
  watch mode live.
- If not loaded: add it to `loadedWorkflows` with `managedBy: "cli"` so it appears in the
  dropdown's "Running Workflows" section with a CLI badge.

---

## Implementation

### New class: `CliWatchSession` (`src/flightpath/orchestration/CliWatchSession.ts`)

```typescript
/**
 * CliWatchSession
 *
 * Owns the three file watchers for a single CLI-managed workflow.
 * Created by WorkflowOrchestrator when an active-cli lock is detected.
 * Disposed when the lock is deleted or goes stale.
 */
export class CliWatchSession implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private heartbeatPollInterval: ReturnType<typeof setInterval> | undefined;
  private lastKnownOutputs: Record<string, unknown> = {};

  constructor(
    private workingFilePath: string,
    private workflowId: string,
    private workspaceFolderPath: string,
    private onUpdate: (summary: WorkflowSummary) => void,
    private onOutput: (outputs: CliOutput[]) => void,
    private onFinished: (finalState: ExecutionState) => void,
  ) {}

  async start(): Promise<void> {
    // 1. Watch working file for step progress
    // 2. Find + watch active history file for output
    // 3. Watch lock file for deletion
    // 4. Start heartbeat staleness poll (10s interval)
  }

  dispose(): void {
    clearInterval(this.heartbeatPollInterval);
    this.disposables.forEach(d => d.dispose());
  }
}
```

### `WorkflowOrchestrator` changes

- During startup `normalizeStaleLocks`: for each `active-cli` result, instantiate a
  `CliWatchSession` and store it keyed by `workflowId`.
- Add a `*.runner.json` watcher for entry point 3 (CLI starts while VS Code is open).
- On `CliWatchSession.onFinished`: remove from `loadedWorkflows` or update to final state,
  dispose the session.

### `WorkflowSummary` change

Add `managedBy?: "vscode" | "cli"` to `FlightPathTypes.ts`.

### Webview changes

**`useMessageHandler.ts`**: When `WORKFLOWS_LIST` or `WORKFLOW_SUMMARY_UPDATED` arrives with
`managedBy === "cli"`, add/update entry in `loadedWorkflows` as normal — no special casing needed
in the store itself.

**`RunningWorkflowItem.tsx`**: Accept `managedBy` prop. Render CLI pill instead of controls when
`managedBy === "cli"`.

**`WorkflowStatus.tsx`** or the main panel root: read `managedBy` from the active
`WorkflowSummary`. Gate all edit controls + run toolbar behind `managedBy !== "cli"`. Render the
banner when `managedBy === "cli"`.

**Output panel**: Already accepts streamed `CLI_OUTPUT` messages — no change needed for the
display itself. Just ensure the "Clear" button is hidden in watch mode.

---

## Edge Cases

### CLI writes output faster than the file watcher fires

File system watchers are not guaranteed to fire for every individual write — they fire when the OS
delivers a notification, which may batch rapid writes. This is fine: each watcher callback reads
the full current file content and diffs against `lastKnownOutputs`, so no output is lost as long
as we read on each notification.

### Working file is read by CLI and extension simultaneously

File reads in Node.js are non-atomic on Windows and Unix when the writer uses partial writes.
The CLI should be writing history atomically (full file replace or append-safe). The working file
is typically updated via full write by both sides. Add a retry with a short delay if JSON.parse
fails (file mid-write): catch the parse error, wait 50ms, re-read once.

### User opens VS Code with multiple workspaces each running a CLI workflow

`CliWatchSession` is per-workflow-id and per-workspace. No cross-workspace conflicts. Each
`WorkflowOrchestrator` instance handles its own workspace's queue directory.

### History saving is disabled in settings

The CLI may also write history even if the VS Code setting is off (CLI has its own settings path).
The watcher simply won't find or create history files — the output panel stays empty in watch mode,
but step progress (from the working file) still updates normally.

### User stops the CLI externally (Ctrl+C in terminal)

CLI's SIGINT handler calls `releaseLock` → lock file deleted → `onDidDelete` fires in VS Code →
`CliWatchSession.onFinished` called → workflow transitions to STOPPED. Handled by Entry Point 3
lock file watcher.

---

## Files Summary

| File | Change |
|---|---|
| `src/types/FlightPathTypes.ts` | Add `managedBy?: "vscode" \| "cli"` to `WorkflowSummary` |
| `src/flightpath/orchestration/CliWatchSession.ts` | **New**: owns working-file, history, and lock-file watchers for one CLI-run workflow |
| `src/flightpath/WorkflowOrchestrator.ts` | Instantiate `CliWatchSession` for `active-cli` locks; add `*.runner.json` create watcher |
| `src/ui/webview-react/components/workflow/RunningWorkflowItem.tsx` | Render CLI pill instead of pause/stop when `managedBy === "cli"` |
| `src/ui/webview-react/components/workflow/WorkflowStatus.tsx` | Read `managedBy` from active summary; show banner; gate controls |
| `src/ui/webview-react/types/messages.ts` | Ensure `WorkflowSummary` propagation includes `managedBy` |

---

## Out of Scope (Future)

- **Bidirectional control**: Allowing VS Code to send pause/stop to the CLI process (would require
  IPC beyond the lock file — e.g. a signal file the CLI polls).
- **CLI output while VS Code is closed**: History is already written to disk by the CLI; when VS
  Code reopens, the completed run appears in the run history viewer as normal.
