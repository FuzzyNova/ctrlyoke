# Output History Architecture

**Status**: ✅ IMPLEMENTED (as of February 2026)

## Overview

FlightPath persists CLI output for each workflow run in `.flightpath/.history/`. This enables:

- **Session restore**: Output from the most recent run is automatically displayed when a workflow is reopened after a VS Code restart.
- **Run comparison**: Users can browse previous runs using the Run Selector dropdown in the Output panel header.
- **Self-contained snapshots**: Each history entry is independent of the current workflow — if prompts were added or deleted after a run, the historical view still shows all original steps.

---

## Storage Layout

```
.flightpath/
├── .queue/                                      (Working files — workflow state)
│   └── workflow-2024-01-21T10-30-00.flightpath.json
│
└── .history/                                    (Output history — per-run snapshots)
    └── workflow-2024-01-21T10-30-00/            (One dir per working file basename)
        ├── run-1-2024-01-21T10-30-15.json
        ├── run-2-2024-01-21T11-45-30.json
        └── run-3-2024-01-21T14-20-45.json       (Most recent run)
```

**Naming convention:**

- History directory: working file basename without `.flightpath.json` suffix
- History files: `run-<N>-<ISO-timestamp-safe>.json`
- `N` is a sequential run number (1, 2, 3, …)

Working files track history file names in their `outputHistory` array:

```json
{
  "outputHistory": ["run-3-...", "run-2-...", "run-1-..."]
}
```

The array is newest-first. `undefined` means history is disabled or no runs exist yet.

---

## Key Types

### `src/types/OutputHistoryTypes.ts`

```typescript
export interface WorkflowOutputHistory {
  schemaVersion: "1.0.0";
  workflowId: string; // Working file basename
  runId: number; // Sequential (1, 2, 3, …)
  startedAt: number; // ms since epoch
  completedAt?: number; // undefined if run was interrupted
  executionState: ExecutionState;
  runStepCount: number; // Total steps in this run
  promptOutputs: {
    // Keyed by step index
    [stepIndex: number]: StepOutput;
  };
}

export interface StepOutput {
  cliOutputs: CliOutput[]; // Full CliOutput[] including .prompt, .cliCommand
  statusMessages: StatusMessage[];
}
```

`CliOutput` (from `WebviewMessageTypes.ts`) already carries `.prompt` (unexpanded prompt text) and `.cliCommand`, so each historical step can render the same `Prompt → CLI Command → Output` layout as the live view — no extra data needed.

---

## Components

### `OutputHistoryManager` (`src/flightpath/orchestration/OutputHistoryManager.ts`)

Central class for all history I/O. Owned by `FlightPathManager` and shared with `FlightPathWebviewProvider`.

Key methods:
| Method | Purpose |
|--------|---------|
| `initializeRun(workflowId, workingFilePath)` | Creates history file, updates working file's `outputHistory`, prunes old runs |
| `saveStepOutput(historyFilePath, stepIndex, cliOutputs, statusMessages)` | Writes per-step data after each prompt completes |
| `finalizeRun(historyFilePath, executionState, runStepCount)` | Sets `completedAt`, `executionState`, `runStepCount` |
| `loadHistory(historyFilePath)` | Reads and validates a history file for display |
| `getRunsForWorkflow(workflowId)` | Returns run filenames newest-first |
| `extractWorkflowId(workingFilePath)` | Strips `.flightpath.json` extension |
| `getHistoryFilePath(workflowId, fileName)` | Resolves absolute path |

`initializeRun()` returns `""` if history is disabled (`flightpath.saveOutputHistory = false`). All other methods are no-ops when called with an empty path.

### `WorkflowExecutor` (`src/flightpath/WorkflowExecutor.ts`)

Has a `historyFilePath` and `outputHistoryManager` on its `WorkflowContext`. After each prompt's final output is sent to the dashboard, `saveStepOutput()` is also called with the same data. A `stepStatusMessages` accumulator is maintained internally to collect status messages per step for history persistence.

### `FlightPathManager` (`src/flightpath/FlightPathManager.ts`)

- Creates one `OutputHistoryManager` instance in its constructor.
- Calls `initializeRun()` in `takeOff()` and passes `historyFilePath` to `WorkflowContext`.
- Calls `finalizeRun()` when the workflow transitions to a terminal state.
- Injects the `OutputHistoryManager` into `FlightPathWebviewProvider` via `setOutputHistoryManager()`.

### `FlightPathWebviewProvider` (`src/ui/FlightPathWebviewProvider.ts`)

On session restore (workflow loaded / VS Code restarted with active workflow):

1. Checks `workingFile.outputHistory` and `autoLoadMostRecentOutput` setting.
2. Loads the most recent history file via `outputHistoryManager.loadHistory()`.
3. Sends `MESSAGE_TYPES.OUTPUT_HISTORY_LOADED` to the webview with the history data and available run metadata.

Handles incoming messages:

- `LOAD_RUN_HISTORY` — loads a specific run index and sends `OUTPUT_HISTORY_LOADED`
- `CLEAR_RUN_HISTORY` — deletes history files, updates working file

---

## React Webview Integration

### `workflowStore.ts`

Stores a self-contained history snapshot separate from live output:

```typescript
historyOutputs: {
  stepCount: number;
  steps: Record<number, StepOutput>;
  runMetadata: Pick<WorkflowOutputHistory, "runId" | "startedAt" | "completedAt" | "executionState">;
} | null;
```

Key actions:

- `loadHistoryRun(history, availableRuns, runIndex)` — populates `historyOutputs`; does **not** touch `cliOutputs` (live data is never disturbed)
- `clearHistoryOutputs()` — sets `historyOutputs: null`

### `uiStore.ts`

Tracks display state:

```typescript
isViewingHistory: boolean;
viewingRunIndex: number; // 0 = most recent
availableRuns: number;
```

Actions: `setHistoryView(runIndex, availableRuns)`, `clearHistoryView()`

### `OutputSection.tsx`

- Imports `RunSelector` from `components/shared`
- When `availableRuns > 0`, renders `<RunSelector>` in the output panel header
- When `isViewingHistory && historyOutputs`, renders all `historyOutputs.stepCount` steps from the history snapshot (independent of the current workflow's prompt list)
- History banner shows run metadata and a "Back to Live" button when a workflow is actively running

**Smart auto-scroll** (replaces the old checkbox): auto-scroll is active by default; scrolling up disables it; scrolling to the bottom re-enables it. Implemented via a `useRef` in `OutputSection` — no store state needed.

### `RunSelector` (`src/ui/webview-react/components/shared/`)

Dropdown component in the Output panel header. Shows available runs with timestamps and state icons. Sends `LOAD_RUN_HISTORY` messages on selection and calls `clearHistoryOutputs` / `clearHistoryView` on "Back to Live".

---

## Settings

| Setting                               | Type    | Default | Description                              |
| ------------------------------------- | ------- | ------- | ---------------------------------------- |
| `flightpath.saveOutputHistory`        | boolean | `true`  | Enable/disable history storage           |
| `flightpath.maxHistoryRuns`           | number  | `10`    | Max runs to keep per workflow (1–100)    |
| `flightpath.autoLoadMostRecentOutput` | boolean | `true`  | Auto-display last run on session restore |

---

## Key Design Properties

### Live capture is never interrupted by history browsing

`cliOutputs` and `statusMessages` in `workflowStore` are the live data buffers. `historyOutputs` is a completely separate display buffer. When the user browses history while a workflow runs, the two data paths are independent. "Back to Live" instantly switches the rendering source back to `cliOutputs`.

### History is self-contained

Each `WorkflowOutputHistory` contains `runStepCount` (total steps in that run) and `promptOutputs` for all those steps. If the workflow has been edited since the run (prompts added or deleted), the historical view still renders all original steps using `CliOutput.prompt` and `CliOutput.cliCommand` from the saved data.

### Backward compatibility

`outputHistory` on `WorkingFile` is optional. Legacy workflows without it behave exactly as before — no history UI is shown.

---

## Error Handling

- All file I/O in `OutputHistoryManager` is wrapped in try/catch with `Log.warn()`. Errors never crash a workflow.
- Missing history files: `loadHistory()` throws; `FlightPathWebviewProvider` catches and shows empty output state.
- Corrupted files: JSON parse error is caught and logged.
- History directory is created automatically via `mkdir({ recursive: true })` in `initializeRun()`.

---

## `.gitignore`

Add to workspace `.gitignore`:

```
.flightpath/.history/
```

History files are large, local artifacts (similar to `.flightpath/.queue/`) that can be regenerated by re-running workflows.

---

## Parallel Workflows Compatibility

This architecture is designed to be compatible with a future parallel-workflows feature:

- `OutputHistoryManager` already keys by `workflowId` — no structural changes needed
- `workflowStore.historyOutputs` is a separate buffer per tab when parallel workflows land
- `uiStore.viewingRunIndex` can be extended to `Record<workflowId, number>` without changing history storage
- `RunSelector` component is fully self-contained and reusable across workflow tabs
- `OUTPUT_HISTORY_LOADED` message gains a `workflowId` routing field when parallel workflows arrive
