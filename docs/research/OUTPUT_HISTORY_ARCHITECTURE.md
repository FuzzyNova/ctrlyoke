# Output History Architecture

## Overview

**Goal:** Preserve and restore CLI output for workflow runs without bloating working files.

**Current Problem:**
- Working files store workflow configuration and execution state
- CLI outputs are NOT persisted - lost on VS Code restart
- Users see workflow structure but no previous output when loading sessions
- No way to compare outputs across multiple runs

**Solution:**
- Separate history storage in `.flightpath/.history/<workflow-id>/` directory
- One JSON file per run containing all prompt outputs and status messages
- Working files maintain lightweight references to history files
- Dashboard UI to cycle through previous runs
- User setting to control history retention (default: enabled, 10 runs max)

---

## Current Architecture Context (as of 2026)

Before describing the implementation, here is the current codebase reality that the old doc was unaware of:

### React Webview + Zustand (not vanilla JS dashboard)

The UI is a React 19 app using Zustand stores. There is no `output-manager.js`, `state-manager.js`, or `message-router.js`. Instead:

- **`src/ui/webview-react/store/workflowStore.ts`** — holds `cliOutputs: Record<number, CliOutput[]>`, `statusMessages`, `retryStates`, `streamingChunks`
- **`src/ui/webview-react/components/output/`** — React components render `CliOutput[]` including `CliOutput.tsx`, `BashOutput.tsx`, `ToolCallOutput.tsx`
- **`src/ui/webview-react/components/layout/OutputSection.tsx`** — main output panel component

### CliOutput Type (not UniversalCliOutput directly)

The webview uses `CliOutput` from `src/types/WebviewMessageTypes.ts`, which wraps `DashboardOutput`:

```typescript
export interface CliOutput {
  prompt: string;
  response: string;
  structured?: StructuredOutput;  // { events: CliEvent[], metadata: OutputMetadata }
  elapsed: number;
  tokens?: TokenStats;
  isStreaming: boolean;
  cliCommand?: string;
  workingDirectory?: string;
  timestampMs: number;
  attemptIndex?: number;
}

export interface StructuredOutput {
  events: CliEvent[];       // CliEvent[] from CliOutputTypes.ts
  metadata: OutputMetadata; // OutputMetadata from CliOutputTypes.ts
}
```

### Key Architecture: WorkflowExecutor owns the integration point

`src/flightpath/WorkflowExecutor.ts` is the natural save point. After each prompt completes, it:

1. Calls `integration.getLastParsedOutput()` → `UniversalCliOutput`
2. Converts via `CliOutputFormatter.toDashboardFormat(parsedOutput)` → `DashboardOutput` (`{ events, metadata }`)
3. Calls `context.dashboardProvider.updateCliOutput(currentIndex, { prompt, response, structured, elapsed, tokens })`

**This is where we save to history — same data, same moment.**

### FlightPathManager is thin orchestration

`WorkflowContext` (passed to `WorkflowExecutor`) contains the `dashboardProvider`. `FlightPathManager` creates the `WorkflowContext` and calls `WorkflowExecutor.execute()`. Adding `historyFilePath` to `WorkflowContext` is the cleanest injection point.

### WorkingFile Has No `outputHistory` Yet

`src/types/FlightPathTypes.ts` WorkingFile interface does NOT have `outputHistory`. The working files live in `.flightpath/.queue/`.

### PATH_CONSTANTS Exists (no HISTORY_DIR yet)

`src/utils/ConfigurationUtils.ts` exports `PATH_CONSTANTS` with `.FLIGHTPATH_DIR`, `.QUEUE_DIR`, etc. We need to add `.HISTORY_DIR`.

### MESSAGE_TYPES Has No History Types

`src/types/DashboardConstants.ts` contains all message types. No output history messages exist yet.

---

## Key Architectural Decisions

### Reuse CliOutput Format for Storage

**Design Choice:** Output history stores events using the existing `CliOutput` format (which contains `StructuredOutput { events: CliEvent[], metadata: OutputMetadata }`) instead of creating custom history types.

**Benefits:**
1. **Zero new types for storage data** — `CliOutput` is already the exact runtime format
2. **Prompt and CLI command included automatically** — `CliOutput.prompt` (unexpanded prompt text) and `CliOutput.cliCommand` are already in the type; saving `CliOutput[]` gives us the full live view fidelity for free
3. **Future-Proof** — new CLI event types automatically work in history
4. **Single source of truth** — history rendering reuses the same `CliOutput`/`StatusMessage` React components

### History Renders as a Self-Contained Snapshot

**Design Choice:** When viewing a historical run, the output panel renders the history's own step list (all N steps from that run), completely independent of how many prompts are currently in the workflow.

**Why this matters:**
- If a workflow had 10 prompts, ran once, then 9 prompts were deleted, the historical view still shows all 10 steps with their original prompts and outputs
- The user sees `Prompt` → `CLI Command` → `Output` for each historical step, just like the live view — because `CliOutput.prompt` and `CliOutput.cliCommand` are already saved in the history
- No confusion from missing/mismatched steps: history is fully self-contained

**Implementation pattern:**

```typescript
// History file stores ordered steps for each run:
{
  promptOutputs: {
    0: { cliOutputs: CliOutput[], statusMessages: StatusMessage[] },  // incl. .prompt, .cliCommand
    1: { cliOutputs: CliOutput[], statusMessages: StatusMessage[] },
    // ... all steps from that run
  },
  runStepCount: 10  // total steps in this run (for ordered rendering)
}

// History loading: populate dedicated historyOutputs (NOT cliOutputs)
// historyOutputs is rendered instead of cliOutputs when isViewingHistory=true
store.loadHistoryRun(history);

// Rendering: REUSE existing CliOutput/StatusMessage React components
// OutputSection switches between cliOutputs (live) and historyOutputs (history) mode
```

---

## Architecture

### Directory Structure

```
.flightpath/
├── .queue/                                  (Existing: working files)
│   └── workflow-2024-01-21T10-30-00.flightpath.json
│
└── .history/                                (NEW: output history)
    └── workflow-2024-01-21T10-30-00/       (One dir per workflow)
        ├── run-1-2024-01-21T10-30-15.json  (First run)
        ├── run-2-2024-01-21T11-45-30.json  (Second run after changes)
        └── run-3-2024-01-21T14-20-45.json  (Most recent run)
```

**Naming Convention:**
- History directory: `<workflow-id>` = working file basename without `.flightpath.json` extension
- History files: `run-<N>-<ISO-timestamp-safe>.json`
- N is sequential run number (1, 2, 3, ...)

---

## Schema Definitions

### 1. New Type File: `src/types/OutputHistoryTypes.ts`

```typescript
import { ExecutionState } from "./FlightPathTypes";
import { CliOutput, StatusMessage } from "./WebviewMessageTypes";

/**
 * Complete output history for a single workflow run.
 * Stored in .flightpath/.history/<workflow-id>/run-N-<timestamp>.json
 *
 * IMPORTANT: Uses CliOutput[] from WebviewMessageTypes.ts for per-step outputs.
 * Each CliOutput already contains .prompt (unexpanded prompt text) and .cliCommand,
 * so history rendering shows the same Prompt → CLI Command → Output view as live mode.
 *
 * History is rendered as a self-contained snapshot — all steps from this run are shown
 * regardless of how many prompts are currently in the workflow.
 */
export interface WorkflowOutputHistory {
  // Schema version for future migrations
  schemaVersion: "1.0.0";

  // Run metadata
  workflowId: string;        // Working file basename (e.g., "workflow-2024-01-21T10-30-00")
  runId: number;             // Sequential run number (1, 2, 3, ...)
  startedAt: number;         // Run start timestamp (ms since epoch)
  completedAt?: number;      // Run completion timestamp (undefined if incomplete)
  executionState: ExecutionState; // Final state (completed, error, stopped, etc.)

  // Total step count for this run (used to render all steps in order)
  // May differ from current workflow prompt count if prompts were added/deleted
  runStepCount: number;

  // Per-step outputs (keyed by stepIndex, indices 0..runStepCount-1)
  // Each CliOutput includes .prompt (unexpanded text) and .cliCommand for full fidelity
  promptOutputs: {
    [stepIndex: number]: StepOutput;
  };
}

/**
 * Output data for a single workflow step.
 * Stores the exact data from workflowStore for that step.
 *
 * CliOutput already contains:
 * - .prompt: the unexpanded prompt text shown in the output header
 * - .cliCommand: the actual CLI command that was run
 * - .response: the plain text response
 * - .structured: structured events (tool calls, thinking blocks, etc.)
 * - .tokens: token usage statistics
 * - .elapsed: execution time
 * - .timestampMs: when the output was created
 */
export interface StepOutput {
  /** All CLI outputs for this step (initial attempt + any retries) */
  cliOutputs: CliOutput[];
  /** Status messages for this step (e.g., "Prompt 1 started at 2:20 PM") */
  statusMessages: StatusMessage[];
}
```

### 2. WorkingFile Enhancement

**File:** `src/types/FlightPathTypes.ts`

```typescript
export interface WorkingFile extends PromptFile {
  originalFile: string;
  workflowName: string;
  startedAt: number;
  lastModifiedAt?: number;
  _runtime?: WorkingFileRuntime;

  /**
   * NEW: Array of history file basenames (newest first)
   * Relative to .flightpath/.history/<workflow-id>/
   *
   * Example: ["run-3-2024-01-21T14-20-45.json", "run-2-...", "run-1-..."]
   *
   * - undefined = no history (legacy workflows, or history disabled)
   * - [] = history enabled but no completed runs yet
   * - [filenames] = available run history files
   */
  outputHistory?: string[];
}
```

### 3. Constants

**File:** `src/utils/ConfigurationUtils.ts`

```typescript
export const PATH_CONSTANTS = {
  // ... existing constants ...
  HISTORY_DIR: ".history",  // NEW
} as const;
```

**File:** `src/types/DashboardConstants.ts`

```typescript
export const MESSAGE_TYPES = {
  // ... existing types ...

  // NEW: Output history messages
  OUTPUT_HISTORY_LOADED: "outputHistoryLoaded",  // Extension -> Webview: Load history for display
  LOAD_RUN_HISTORY: "loadRunHistory",            // Webview -> Extension: Request specific run
  CLEAR_RUN_HISTORY: "clearRunHistory",          // Webview -> Extension: Delete run history
} as const;
```

---

## Implementation Components

### 1. OutputHistoryManager (NEW)

**File:** `src/flightpath/orchestration/OutputHistoryManager.ts`

**Responsibility:** Manage workflow output history storage and retrieval

```typescript
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PATH_CONSTANTS, ConfigurationUtils } from "../../utils/ConfigurationUtils";
import { WorkflowOutputHistory, StepOutput } from "../../types/OutputHistoryTypes";
import { CliOutput, StatusMessage } from "../../types/WebviewMessageTypes";
import { ExecutionState } from "../../types/FlightPathTypes";
import { WorkingFile } from "../../types/FlightPathTypes";
import { Log } from "../../utils/Log";

export class OutputHistoryManager {
  private historyBaseDir: string;

  constructor(private workspaceFolderPath: string) {
    this.historyBaseDir = path.join(
      workspaceFolderPath,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.HISTORY_DIR
    );
  }

  /** Check if history is enabled via settings */
  isHistoryEnabled(): boolean {
    return ConfigurationUtils.getConfigValue<boolean>("saveOutputHistory", true) ?? true;
  }

  /** Extract workflow ID from working file path */
  extractWorkflowId(workingFilePath: string): string {
    // "workflow-2024-01-21T10-30-00.flightpath.json" → "workflow-2024-01-21T10-30-00"
    const basename = path.basename(workingFilePath);
    return basename.replace(/\.flightpath\.json$/, "").replace(/\.flightpath\.yaml$/, "");
  }

  /** Get absolute path to a history file */
  getHistoryFilePath(workflowId: string, historyFileName: string): string {
    return path.join(this.historyBaseDir, workflowId, historyFileName);
  }

  /**
   * Initialize a new run for a workflow.
   * Returns the absolute path to the history file, or "" if history is disabled.
   */
  async initializeRun(workflowId: string, workingFilePath: string): Promise<string> {
    if (!this.isHistoryEnabled()) {
      return "";
    }

    const historyDir = path.join(this.historyBaseDir, workflowId);
    await fs.promises.mkdir(historyDir, { recursive: true });

    // Determine next run ID
    const existingRuns = await this.getRunsForWorkflow(workflowId);
    const nextRunId = existingRuns.length > 0
      ? Math.max(...existingRuns.map(f => this.extractRunId(f))) + 1
      : 1;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `run-${nextRunId}-${timestamp}.json`;
    const filePath = path.join(historyDir, fileName);

    const initial: WorkflowOutputHistory = {
      schemaVersion: "1.0.0",
      workflowId,
      runId: nextRunId,
      startedAt: Date.now(),
      executionState: "running" as any,
      promptOutputs: {},
    };

    await fs.promises.writeFile(filePath, JSON.stringify(initial, null, 2), "utf-8");

    // Update working file's outputHistory array
    await this.prependToOutputHistory(workingFilePath, fileName);

    // Prune old runs
    const maxRuns = ConfigurationUtils.getConfigValue<number>("maxHistoryRuns", 10) ?? 10;
    await this.pruneOldRuns(workflowId, workingFilePath, maxRuns);

    return filePath;
  }

  /**
   * Save CLI outputs for a step (called after each prompt completes or retries).
   * Replaces the entire step entry (handles both initial + retry case).
   */
  async saveStepOutput(
    historyFilePath: string,
    stepIndex: number,
    cliOutputs: CliOutput[],
    statusMessages: StatusMessage[]
  ): Promise<void> {
    if (!historyFilePath) return;

    try {
      const history = await this.readHistory(historyFilePath);
      history.promptOutputs[stepIndex] = { cliOutputs, statusMessages };
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to save step output to history:", error);
    }
  }

  /**
   * Finalize run (mark as completed/stopped/error and record total step count).
   * runStepCount is the total number of steps that were executed in this run —
   * used by history rendering to show all steps regardless of current workflow size.
   */
  async finalizeRun(
    historyFilePath: string,
    executionState: ExecutionState,
    runStepCount: number
  ): Promise<void> {
    if (!historyFilePath) return;

    try {
      const history = await this.readHistory(historyFilePath);
      history.completedAt = Date.now();
      history.executionState = executionState;
      history.runStepCount = runStepCount;
      await this.writeHistory(historyFilePath, history);
    } catch (error) {
      Log.warn("Failed to finalize history run:", error);
    }
  }

  /** Load a history file for display */
  async loadHistory(historyFilePath: string): Promise<WorkflowOutputHistory> {
    const content = await fs.promises.readFile(historyFilePath, "utf-8");
    const history = JSON.parse(content) as WorkflowOutputHistory;

    if (!history.workflowId || !history.runId || !history.promptOutputs) {
      throw new Error("Invalid history file: missing required fields");
    }

    return history;
  }

  /** Get all run filenames for a workflow (sorted newest first) */
  async getRunsForWorkflow(workflowId: string): Promise<string[]> {
    const historyDir = path.join(this.historyBaseDir, workflowId);

    try {
      const entries = await fs.promises.readdir(historyDir);
      const runFiles = entries.filter(f => /^run-\d+-.*\.json$/.test(f));
      return runFiles.sort((a, b) => this.extractRunId(b) - this.extractRunId(a));
    } catch {
      return [];
    }
  }

  /** Prune runs beyond maxRuns limit (oldest first) */
  async pruneOldRuns(workflowId: string, workingFilePath: string, maxRuns: number): Promise<void> {
    const runs = await this.getRunsForWorkflow(workflowId);
    if (runs.length <= maxRuns) return;

    const toDelete = runs.slice(maxRuns); // oldest runs (array is newest-first)
    for (const fileName of toDelete) {
      const filePath = this.getHistoryFilePath(workflowId, fileName);
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        Log.warn(`Failed to delete old history file ${fileName}:`, error);
      }
    }

    // Update working file
    await this.removeFromOutputHistory(workingFilePath, toDelete);
  }

  // ---- Private helpers ----

  private extractRunId(fileName: string): number {
    const match = fileName.match(/^run-(\d+)-/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private async readHistory(filePath: string): Promise<WorkflowOutputHistory> {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content) as WorkflowOutputHistory;
  }

  private async writeHistory(filePath: string, history: WorkflowOutputHistory): Promise<void> {
    await fs.promises.writeFile(filePath, JSON.stringify(history, null, 2), "utf-8");
  }

  private async prependToOutputHistory(workingFilePath: string, fileName: string): Promise<void> {
    try {
      const content = await fs.promises.readFile(workingFilePath, "utf-8");
      const workingFile = JSON.parse(content) as WorkingFile;
      workingFile.outputHistory = [fileName, ...(workingFile.outputHistory ?? [])];
      await fs.promises.writeFile(workingFilePath, JSON.stringify(workingFile, null, 2), "utf-8");
    } catch (error) {
      Log.warn("Failed to update working file outputHistory:", error);
    }
  }

  private async removeFromOutputHistory(workingFilePath: string, fileNames: string[]): Promise<void> {
    try {
      const content = await fs.promises.readFile(workingFilePath, "utf-8");
      const workingFile = JSON.parse(content) as WorkingFile;
      const toRemove = new Set(fileNames);
      workingFile.outputHistory = (workingFile.outputHistory ?? []).filter(f => !toRemove.has(f));
      await fs.promises.writeFile(workingFilePath, JSON.stringify(workingFile, null, 2), "utf-8");
    } catch (error) {
      Log.warn("Failed to prune working file outputHistory:", error);
    }
  }
}
```

---

### 2. Integration with WorkflowExecutor

**File:** `src/flightpath/WorkflowExecutor.ts`

**Changes:**

1. **Add `historyFilePath` to `WorkflowContext`:**

```typescript
export interface WorkflowContext {
  // ... existing fields ...

  /** Path to current run's history file (empty string if history disabled) */
  historyFilePath: string;
  /** OutputHistoryManager for saving step outputs */
  outputHistoryManager?: OutputHistoryManager;
}
```

2. **After saving final output to dashboard, also save to history:**

```typescript
// In the section that calls context.dashboardProvider.updateCliOutput(currentIndex, {...}):

// Save to history (same data)
if (context.historyFilePath && context.outputHistoryManager) {
  const storeOutputs = [{ prompt, response: responseText, structured, elapsed, tokens, isStreaming: false, timestampMs: Date.now(), attemptIndex: 0 }];
  const storeMessages = /* get from dashboardProvider if accessible */;
  await context.outputHistoryManager.saveStepOutput(
    context.historyFilePath,
    currentIndex,
    storeOutputs,
    [] // Status messages saved separately
  ).catch(err => Log.warn("Failed to save history:", err));
}
```

**Design note:** The cleanest pattern is to save history at the same place where `dashboardProvider.updateCliOutput()` is called for the **final** (non-streaming) output. There are two call sites in `WorkflowExecutor`:
- `sendFinalOutputToDashboard()` — initial prompt success path
- The retry path after `endConditionHandler.handleRetry()`

Both need to call `outputHistoryManager.saveStepOutput()` after updating the dashboard.

Since status messages are emitted separately via `addStatusMessage()` on `dashboardProvider`, the cleanest approach is to save them incrementally via a separate `saveStatusMessage()` call, or to read the accumulated messages from the webview state (not accessible in extension). **Simpler approach:** batch save `statusMessages` at the same time as `cliOutputs` in the final save — read them from the `promptQueue` or pass them through context.

---

### 3. Integration with FlightPathManager

**File:** `src/flightpath/FlightPathManager.ts`

**Changes:**

1. **Add `OutputHistoryManager` instance:**

```typescript
private outputHistoryManager: OutputHistoryManager;

constructor(...) {
  // ... existing code ...
  const workspacePath = workspaceFolder?.uri.fsPath ?? "";
  this.outputHistoryManager = new OutputHistoryManager(workspacePath);
}
```

2. **Initialize run in `takeOff()` and pass to `WorkflowContext`:**

```typescript
async takeOff(promptFile: string | PromptFile): Promise<void> {
  // ... existing setup ...

  const workingFilePath = this.promptQueue.getState().workingFilePath ?? "";
  const workflowId = this.outputHistoryManager.extractWorkflowId(workingFilePath);
  const historyFilePath = await this.outputHistoryManager.initializeRun(
    workflowId,
    workingFilePath
  );

  // Pass to WorkflowContext
  const context: WorkflowContext = {
    // ... existing fields ...
    historyFilePath,
    outputHistoryManager: this.outputHistoryManager,
  };
}
```

3. **Finalize run on workflow completion:**

```typescript
// After workflow completes (wherever state transitions to completed/error/stopped):
if (historyFilePath) {
  // runStepCount = number of steps that were actually executed
  // (promptQueue.getProgress().total gives the final count)
  const runStepCount = this.promptQueue.getProgress().total;
  await this.outputHistoryManager.finalizeRun(historyFilePath, finalExecutionState, runStepCount);
}
```

---

### 4. Integration with FlightPathWebviewProvider

**File:** `src/ui/FlightPathWebviewProvider.ts`

**Changes:**

1. **Add `OutputHistoryManager` instance** (shared with FlightPathManager or separate)

2. **Load history on session restore:**

```typescript
// In the session restore / updateState path, after loading working file:
if (workingFile.outputHistory?.length && ConfigurationUtils.getConfigValue("autoLoadMostRecentOutput", true)) {
  const workflowId = this.outputHistoryManager.extractWorkflowId(workingFilePath);
  const mostRecent = workingFile.outputHistory[0];
  const historyPath = this.outputHistoryManager.getHistoryFilePath(workflowId, mostRecent);

  try {
    const history = await this.outputHistoryManager.loadHistory(historyPath);
    this.postMessage({
      type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
      history,
      availableRuns: workingFile.outputHistory.length,
      currentRunIndex: 0,
    });
  } catch (error) {
    Log.warn("Failed to load output history:", error);
  }
}
```

3. **Handle `LOAD_RUN_HISTORY` message (navigate between runs):**

```typescript
case MESSAGE_TYPES.LOAD_RUN_HISTORY: {
  const { runIndex } = message;
  // Load the requested run and send OUTPUT_HISTORY_LOADED
  break;
}
```

4. **Handle `CLEAR_RUN_HISTORY` message:**

```typescript
case MESSAGE_TYPES.CLEAR_RUN_HISTORY: {
  // Confirm, delete files, update working file, notify webview
  break;
}
```

---

### 5. React Webview Changes

#### State store split: workflowStore vs uiStore

**Decision**: Run history display state lives in **`uiStore`**, not `workflowStore`.

- `workflowStore` holds live execution state (cliOutputs, statusMessages, prompts, etc.)
- `uiStore` holds display preferences (which run is currently visible)

**Rationale:**
- "Which run am I looking at" is a view preference, not workflow execution state
- When parallel workflows arrive, `uiStore` can hold `viewingRunIndex: Record<workflowId, number>` — per-workflow display preferences, with zero changes to the history architecture
- Keeps `workflowStore` clean: it only holds the currently rendered run's data

#### workflowStore.ts additions

Add state fields and actions for history display:

```typescript
interface WorkflowState {
  // ... existing fields (cliOutputs, statusMessages remain unchanged) ...

  // NEW: Self-contained history snapshot for the currently-viewed historical run.
  // When isViewingHistory=true (in uiStore), OutputSection renders from historyOutputs
  // instead of cliOutputs. The live cliOutputs continue to be updated normally —
  // history browsing has zero impact on live capture.
  historyOutputs: {
    stepCount: number;                              // Total steps in this run
    steps: Record<number, StepOutput>;             // StepOutput from history file
    runMetadata: Pick<WorkflowOutputHistory,        // Run info for the banner
      "runId" | "startedAt" | "completedAt" | "executionState"
    >;
  } | null;
}

// NEW actions:
/**
 * Load a historical run into historyOutputs for display.
 * Does NOT touch cliOutputs — live output continues uninterrupted.
 * Called by message handler on OUTPUT_HISTORY_LOADED.
 */
loadHistoryRun: (history: WorkflowOutputHistory, availableRuns: number, runIndex: number) => void;

/**
 * Clear historyOutputs (called when user clicks "Back to Live" or starts a new run).
 * OutputSection switches back to rendering from cliOutputs.
 */
clearHistoryOutputs: () => void;
```

`loadHistoryRun()` implementation:

```typescript
loadHistoryRun: (history, availableRuns, runIndex) =>
  set(() => {
    // Update uiStore for history view state
    useUiStore.getState().setHistoryView(runIndex, availableRuns);

    // Populate self-contained history snapshot
    return {
      historyOutputs: {
        stepCount: history.runStepCount,
        steps: history.promptOutputs,  // Record<number, StepOutput> — direct from file
        runMetadata: {
          runId: history.runId,
          startedAt: history.startedAt,
          completedAt: history.completedAt,
          executionState: history.executionState,
        },
      },
    };
  }),

clearHistoryOutputs: () =>
  set(() => ({ historyOutputs: null })),
```

**Key property:** `cliOutputs` and `statusMessages` are NEVER touched by `loadHistoryRun()`. Live streaming handlers continue updating them normally. History browsing has zero side-effects on live execution state.

#### uiStore.ts additions

```typescript
interface UiState {
  // ... existing fields ...

  // NEW: Run history display state
  isViewingHistory: boolean;      // true when showing a historical run (not live)
  viewingRunIndex: number;        // 0 = most recent, 1 = second most recent, etc.
  availableRuns: number;          // Total runs saved for this workflow
}

// NEW actions:
setHistoryView: (runIndex: number, availableRuns: number) => void;
clearHistoryView: () => void;
```

#### OutputSection.tsx changes

**Header layout:**

```
┌──────────────────────────────────────────────────────────────────┐
│  ▼ ⬜ Output          Run: [3 of 3 ▼]  [export]                 │
├──────────────────────────────────────────────────────────────────┤
│  [output content...]                                             │
└──────────────────────────────────────────────────────────────────┘
```

- Left: collapse toggle + icon + title (unchanged)
- Right: run selector (when history available) + export button
- **Auto-scroll checkbox removed** — replaced by smart scroll behavior (see below)

```tsx
{/* Right: controls */}
<div className="ml-auto flex items-center gap-2">
  {availableRuns > 0 && (
    <RunSelector
      availableRuns={availableRuns}
      currentRunIndex={viewingRunIndex}
      isViewingHistory={isViewingHistory}
      isLiveRunActive={executionState === EXECUTION_STATES.RUNNING}
      onSelectRun={(runIndex) => {
        vscode.postMessage({ type: MESSAGE_TYPES.LOAD_RUN_HISTORY, runIndex });
      }}
      onBackToLive={() => {
        useWorkflowStore.getState().restoreLiveView();
        useUiStore.getState().clearHistoryView();
      }}
    />
  )}
  <button className="icon-btn py-0.5 px-2" title="Export output to markdown"
    onClick={handleExport} disabled={!hasOutput}>
    <i className="codicon codicon-export" />
  </button>
</div>
```

**RunSelector component** (new shared component in `components/shared/`):

```tsx
// Renders as a dropdown button in the output header
// Shows: "Run 3 of 3 ▼" (current/live) or "Run 2 of 3 ▼" (historical)

interface RunSelectorProps {
  availableRuns: number;
  currentRunIndex: number;    // 0 = newest
  isViewingHistory: boolean;
  isLiveRunActive: boolean;   // Whether a workflow is currently executing
  onSelectRun: (runIndex: number) => void;
  onBackToLive: () => void;
}
```

Dropdown options:
```
► Run 3  Jan 21, 2:20 PM  (live)          ← shown when isLiveRunActive, always at top
  Run 3  Jan 21, 2:20 PM  ✓ completed    ← or shown after completion
  Run 2  Jan 21, 11:45 AM ✓ completed
  Run 1  Jan 21, 10:30 AM ✓ completed
```

> **Note on indexing:** `outputHistory[]` is stored newest-first. `runIndex: 0` = most recent. "Run N of M" label: `runNumber = availableRuns - runIndex`.

**History view rendering:**

When `isViewingHistory: true`, `OutputSection` renders from `historyOutputs` instead of `cliOutputs`. This shows all steps from the historical run in order, regardless of current workflow state.

```tsx
// In OutputSection.tsx — determine what to render:
const { historyOutputs } = useWorkflowStore();
const { isViewingHistory } = useUiStore();

// In history mode: render all steps from the historical run
// In live mode: render steps from the current workflow (existing behavior)
const stepsToRender = isViewingHistory && historyOutputs
  ? Array.from({ length: historyOutputs.stepCount }, (_, i) => ({
      stepIndex: i,
      cliOutputs: historyOutputs.steps[i]?.cliOutputs ?? [],
      statusMessages: historyOutputs.steps[i]?.statusMessages ?? [],
    }))
  : currentPrompts.map((_, i) => ({
      stepIndex: i,
      cliOutputs: cliOutputs[i] ?? [],
      statusMessages: statusMessages[i] ?? [],
    }));
```

Each step renders identically — the same `CliOutput` component, `StatusMessage` component, etc. The `CliOutput` component already shows the `prompt` field as the prompt header and `cliCommand` as the command — this is already the live view behavior. No new rendering code needed.

**History view banner** (shown in output body when `isViewingHistory: true`):

```tsx
{isViewingHistory && historyOutputs && (
  <div className="history-banner">
    <span>
      Run {historyOutputs.runMetadata.runId} · {formatTimestamp(historyOutputs.runMetadata.startedAt)}
      {historyOutputs.runMetadata.completedAt ? " ✓" : " (incomplete)"}
    </span>
    {isLiveRunActive && (
      <button
        onClick={() => {
          useWorkflowStore.getState().clearHistoryOutputs();
          useUiStore.getState().clearHistoryView();
        }}
        className="back-to-live"
      >
        Back to Live ●
      </button>
    )}
  </div>
)}
```

The "Back to Live" button is only shown when a workflow is actively running — otherwise the most recent run IS the live run, so no distinction is needed.

#### Auto-scroll: smart scroll replaces checkbox

**Decision:** Remove the auto-scroll checkbox entirely. Replace with behavior-based scroll:

- **Auto-scroll active by default** — output scrolls to bottom as new content arrives
- **User scrolls up → disable auto-scroll** — detected via scroll event: `scrollTop + clientHeight < scrollHeight - threshold` (threshold: ~50px to avoid hair-trigger)
- **User scrolls to bottom → re-enable auto-scroll** — detected when scroll position reaches bottom within threshold

```typescript
// In uiStore: remove autoscrollEnabled field, remove setAutoscroll action
// Smart scroll is managed entirely in OutputSection via a ref

// In OutputSection.tsx:
const isAtBottomRef = useRef(true); // Tracks whether auto-scroll is active

const handleScroll = useCallback(() => {
  if (!outputRef.current) return;
  const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
  isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
}, []);

useEffect(() => {
  if (isAtBottomRef.current && outputRef.current) {
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }
}, [allMessages, streamingChunks]);
```

**Phase 1 task addition:** Remove `autoscrollEnabled` and `setAutoscroll` from `uiStore`; implement smart scroll in `OutputSection`.

#### message-handler additions

In the existing message handler:

```typescript
case MESSAGE_TYPES.OUTPUT_HISTORY_LOADED: {
  const { history, availableRuns, currentRunIndex } = message;
  useWorkflowStore.getState().loadHistoryRun(history, availableRuns, currentRunIndex);
  break;
}
```

#### Live output capture during history browsing

When a workflow is running and the user is viewing a historical run:

1. `cliOutputs` in `workflowStore` = live data, always updated by streaming handlers (unchanged)
2. `historyOutputs` in `workflowStore` = historical snapshot being displayed
3. History file on disk = always written regardless of what is displayed
4. `OutputSection` renders from `historyOutputs` when `isViewingHistory=true`, from `cliOutputs` when `false`

When the user clicks "Back to Live":
- `clearHistoryOutputs()` sets `historyOutputs: null`
- `uiStore.clearHistoryView()` sets `isViewingHistory: false`
- `OutputSection` immediately switches to rendering from `cliOutputs`, which already has the current live state

**No data copying, no snapshots.** The live outputs were always in `cliOutputs` — we just switch which data source the UI renders from.

---

### 6. Settings Configuration

**File:** `package.json`

Add to `contributes.configuration.properties`:

```json
{
  "flightpath.saveOutputHistory": {
    "type": "boolean",
    "default": true,
    "description": "Save CLI output history for each workflow run. History is stored in .flightpath/.history/ and excluded from version control."
  },
  "flightpath.maxHistoryRuns": {
    "type": "number",
    "default": 10,
    "minimum": 1,
    "maximum": 100,
    "description": "Maximum number of runs to keep per workflow. Older runs are automatically deleted."
  },
  "flightpath.autoLoadMostRecentOutput": {
    "type": "boolean",
    "default": true,
    "description": "Automatically display output from the most recent run when opening a workflow."
  }
}
```

Add helpers to `ConfigurationUtils`:

```typescript
isSaveOutputHistoryEnabled(): boolean {
  return getConfig().get<boolean>("saveOutputHistory", true);
},

getMaxHistoryRuns(): number {
  return getConfig().get<number>("maxHistoryRuns", 10);
},

shouldAutoLoadMostRecentOutput(): boolean {
  return getConfig().get<boolean>("autoLoadMostRecentOutput", true);
},
```

---

## Behavior Specifications

### Scenario 1: First Run (No History)

1. User opens workflow, clicks Run
2. `FlightPathManager.takeOff()` → `outputHistoryManager.initializeRun()` creates:
   - `.flightpath/.history/<workflow-id>/run-1-<timestamp>.json`
3. Working file updated: `outputHistory = ["run-1-<timestamp>.json"]`
4. After each prompt: `outputHistoryManager.saveStepOutput()` writes to history file
5. Dashboard shows output in real-time (unchanged from current behavior)
6. On completion: `finalizeRun()` updates `completedAt` and `executionState`
7. No history navigation UI shown (only 1 run available)

### Scenario 2: Re-run Workflow

1. User clicks Run again on the same workflow
2. `initializeRun()` creates `run-2-<timestamp>.json`
3. Working file: `outputHistory = ["run-2-...", "run-1-..."]` (newest first)
4. Previous run (run-1) preserved — no new working file created, same `.queue/` entry
5. Dashboard sends `OUTPUT_HISTORY_LOADED` with `currentRunIndex: 0` (live run)
6. Run selector in Output panel header shows "Run 2 of 2 ▼" (with live indicator)
7. After completion: dropdown shows both runs, user can select Run 1 to compare

### Scenario 3: Load Old Workflow (VS Code Restart)

1. User opens workflow with `outputHistory = ["run-3-...", "run-2-...", "run-1-..."]`
2. `FlightPathWebviewProvider` checks `autoLoadMostRecentOutput` setting
3. Loads run-3 history file, sends `OUTPUT_HISTORY_LOADED` message
4. `workflowStore.loadHistoryRun()` populates `historyOutputs` (self-contained snapshot)
5. `uiStore.setHistoryView(0, 3)` sets `isViewingHistory: true`
6. `OutputSection` renders all steps from `historyOutputs` (run-3's step count)
7. Each step shows: Status messages → Prompt → CLI Command → Output (same as live)
8. Shows "Run 3 · Jan 21, 2:20 PM ✓" banner in output body
9. Run selector in header shows "Run 3 of 3 ▼"

### Scenario 4: Live Run While Viewing History

1. User is viewing run-1 history (run-2 is the most recent completed run)
2. User clicks Run → run-3 begins
3. `clearAllRuntimeState()` called (existing behavior) — clears live `cliOutputs`
4. `uiStore.isViewingHistory` remains true (user is still viewing run-1)
5. `workflowStore.liveCliOutputs` begins accumulating run-3 data
6. History file `run-3-<timestamp>.json` is being written in background
7. Run selector shows "Run 1 of 3 ▼" with a "● Back to Live" button in the output header
8. User clicks "Back to Live" → `restoreLiveView()` swaps in `liveCliOutputs`, `isViewingHistory: false`
9. Output shows current run-3 state
10. After run-3 completes: dropdown shows "Run 3 of 3 ▼" with all 3 runs available

### Scenario 5: Prompts Changed Between Runs

1. User ran workflow with 10 prompts → `historyOutputs.stepCount = 10`, `promptOutputs: { 0..9 }`
2. User edits the workflow file: deletes 9 prompts, leaving 1
3. User loads the historical run → `OutputSection` renders all 10 steps from `historyOutputs`
4. Each of the 10 steps shows its original prompt text (from `CliOutput.prompt`) and full output
5. The history banner ("Run 1 · Jan 21, 10:30 AM ✓") makes clear this is a historical snapshot
6. Current workflow's prompt list is not shown at all in history mode — history is fully self-contained

This is the correct behavior: the user can see exactly what the AI produced for each of the original 10 prompts, regardless of what the workflow looks like today.

### Scenario 6: History Disabled

1. User sets `flightpath.saveOutputHistory = false`
2. `initializeRun()` returns `""`
3. No history directory created, no `outputHistory` in working file
4. Dashboard behaves exactly as before (no history navigation)

---

## Migration & Backward Compatibility

**No breaking changes.** The `outputHistory` field on `WorkingFile` is optional. Legacy workflows without it work identically to the current behavior. The first run after upgrade silently begins creating history.

**.gitignore recommendation:** Add `.flightpath/.history/` to workspace `.gitignore`. History files are local artifacts similar to `.queue/` files — they are large, user-specific, and can be regenerated.

---

## Error Handling Strategy

- **File I/O errors:** Log warning, continue (never crash the workflow)
- **Corrupted history:** `loadHistory()` throws → `FlightPathWebviewProvider` catches, logs, shows empty state
- **Missing `.history/` directory:** Auto-create in `initializeRun()` via `mkdir({ recursive: true })`
- **Large outputs:** No size limit in Phase 1. Phase 3 adds configurable truncation.

---

## Implementation Phases

### Phase 1: Core History Storage (MVP)

**Goal:** Save and restore output for single runs

**Tasks:**
1. Create `src/types/OutputHistoryTypes.ts` (new types file)
2. Add `HISTORY_DIR` to `PATH_CONSTANTS` in `ConfigurationUtils.ts`
3. Add `outputHistory` field to `WorkingFile` in `FlightPathTypes.ts`
4. Add `OUTPUT_HISTORY_LOADED`, `LOAD_RUN_HISTORY`, `CLEAR_RUN_HISTORY` to `MESSAGE_TYPES`
5. Implement `OutputHistoryManager` class
6. Add `historyFilePath` / `outputHistoryManager` to `WorkflowContext`
7. Integrate into `WorkflowExecutor`:
   - Add `private stepStatusMessages: Map<number, StatusMessage[]>` accumulator
   - Push to accumulator alongside every `dashboardProvider.addStatusMessage()` call
   - Call `outputHistoryManager.saveStepOutput(historyFilePath, stepIndex, cliOutputs, statusMessages)` in both `sendFinalOutputToDashboard()` and the retry path
8. Integrate into `FlightPathManager`: init run in `takeOff()`, finalize on completion; pass single `OutputHistoryManager` instance to `FlightPathWebviewProvider`
9. Integrate into `FlightPathWebviewProvider`: load history on session restore, handle `LOAD_RUN_HISTORY` and `CLEAR_RUN_HISTORY`
10. Update `workflowStore.ts`: add `historyOutputs` field; add `loadHistoryRun()` and `clearHistoryOutputs()` actions; **no changes** to `cliOutputs`/`statusMessages` or streaming handlers (live capture is unaffected)
11. Update `uiStore.ts`: add `isViewingHistory`, `viewingRunIndex`, `availableRuns`; add `setHistoryView()` and `clearHistoryView()` actions; **remove** `autoscrollEnabled` and `setAutoscroll`
12. Update `OutputSection.tsx`:
    - Replace auto-scroll checkbox with smart scroll (scroll-up disables, scroll-to-bottom re-enables)
    - Switch rendering source: `historyOutputs` (history mode) vs `cliOutputs` (live mode)
    - History mode renders all `historyOutputs.stepCount` steps (independent of current prompt list)
    - Add run selector dropdown in output header
    - Add history banner with "Back to Live" button
13. Create `RunSelector` component in `components/shared/`
14. Update message handler: handle `OUTPUT_HISTORY_LOADED`
15. Update `OutputHistoryManager.finalizeRun()` to also write `runStepCount` (total steps executed)
16. Add settings to `package.json` + helpers to `ConfigurationUtils`
17. Update `WorkspaceSessionManager` (or clear history handler): also delete `.history/<workflow-id>/` on clear
18. Manual testing: first run, re-run, history browsing during live run, load old workflow (fewer prompts than original run), disabled setting

**Success Criteria:**
- ✅ History files created in `.history/<workflow-id>/`
- ✅ Outputs saved after each prompt
- ✅ Working file `outputHistory` updated
- ✅ VS Code restart → dashboard loads and displays most recent run
- ✅ Settings control behavior

---

### Phase 2: Run Navigation UI

**Goal:** Allow users to cycle through previous runs

**Tasks:**
1. Add `isViewingHistory`, `availableRuns`, `currentRunIndex`, `outputHistory` to `workflowStore`
2. Update `OutputSection.tsx`: add run navigation bar (prev/next buttons, run indicator, timestamp)
3. Add `clearHistoryView()` action + "Back to Live" button
4. Update `FlightPathWebviewProvider`: handle `LOAD_RUN_HISTORY` and `CLEAR_RUN_HISTORY`
5. Add clear history confirmation dialog
6. Manual testing: navigation, timestamps, clear history

**Success Criteria:**
- ✅ Run navigation UI appears when `availableRuns > 1`
- ✅ Prev/Next buttons load historical runs
- ✅ "Viewing Run N of M" indicator with timestamp
- ✅ Clear history deletes files and resets UI

---

### Phase 3: Pruning & Polish

**Goal:** Automatic cleanup and edge cases

**Tasks:**
1. Implement `pruneOldRuns()` (called in `initializeRun()`)
2. Add `maxHistoryRuns` setting
3. Handle corrupted history files (graceful degradation)
4. Add status message persistence (currently only `cliOutputs` saved)
5. Performance: defer history writes to not block workflow execution
6. Optionally add per-run size warning if history file exceeds threshold

---

### Phase 4: Advanced Features (Future)

- Diff view between runs (side-by-side output comparison)
- Token usage charts across runs
- Export comparison report (markdown)
- Search across run history
- Compression for large outputs

---

## Decisions & Resolved Questions

### 1. Status message persistence: WorkflowExecutor accumulates messages ✅

**Decision:** Option (a) — `WorkflowExecutor` maintains an internal `statusMessages` map per step and passes it to `OutputHistoryManager.saveStepOutput()`.

**Implementation:** In `WorkflowExecutor`, alongside the existing `sendFinalOutputToDashboard()` path, track status messages in a `private stepStatusMessages: Map<number, StatusMessage[]>`. Whenever `dashboardProvider.addStatusMessage()` is called in `WorkflowExecutor`, also push to this map.

**Why this works for history restore:** When loading history, `loadHistoryRun()` populates both `workflowStore.cliOutputs` AND `workflowStore.statusMessages` from the saved data. The existing `StatusMessage` React component renders them identically — same component, same render path, whether from a live run or history. Zero new rendering code.

---

### 2. Single `OutputHistoryManager` instance ✅

**Decision:** Single instance created in `FlightPathManager`, passed to `FlightPathWebviewProvider` via constructor/setter.

---

### 3. Immediate saves ✅

**Decision:** Save after each step completion (immediate). Debounce deferred to Phase 3 if profiling shows bottleneck.

---

### 4. UX for run history: Per-workflow run selector in Output panel header ✅

**Decision:** Each workflow maintains a run history. "Re-running" a workflow creates a new run entry in that workflow's history (does NOT create a new working file or clutter `.queue/`). Users navigate run history via a dropdown in the Output panel header.

**Why not "each re-run = new workflow":**
- Would clutter `.queue/` with duplicate working files for the same prompt file
- Can't re-run while a workflow is running (current limitation)
- The dropdown in recent workflows would show confusing duplicates
- Harder to answer "what was the output last time I ran this?" — requires navigating to a different workflow

**Run selector placement: Output panel header**

```
┌───────────────────────────────────────────────────────┐
│  Output                         Run: [3 of 3 ▼]       │
├───────────────────────────────────────────────────────┤
│  [live streaming output...]                           │
└───────────────────────────────────────────────────────┘
```

Dropdown:
```
► Run 3  Jan 21, 2:20 PM  (live)
  Run 2  Jan 21, 11:45 AM ✓
  Run 1  Jan 21, 10:30 AM ✓
```

**Live capture during history browsing:** History is written to disk regardless of what the user is viewing. `workflowStore` maintains a `liveCliOutputs` snapshot that always holds the current run's data, so "Back to Live" instantly restores it.

**Parallel workflows compatibility:** When parallel workflows arrive, each workflow tab has its own Output panel. The run selector naturally scopes to that tab's workflow — `uiStore` can hold `viewingRunIndex: Record<workflowId, number>` with no structural changes to this architecture.

---

### 5. Auto-scroll: smart scroll replaces checkbox ✅

**Decision:** Remove `autoscrollEnabled` / `setAutoscroll` from `uiStore`. Replace the checkbox with behavior-based smart scroll in `OutputSection`:
- Auto-scroll is active by default
- User scrolling up disables it (detected when `scrollHeight - scrollTop - clientHeight > 50px`)
- User scrolling to bottom re-enables it

This is strictly better UX and removes a control from the already-busy header. The checkbox was a workaround for not having smart scroll. Smart scroll is managed entirely in `OutputSection` via a `useRef` — no store state needed.

---

### 6. Full history snapshot rendered independently of current prompt list ✅

**Decision:** History rendering is self-contained. When viewing a historical run, `OutputSection` renders all `runStepCount` steps from `historyOutputs`, not the current workflow's prompt list. If the original run had 10 prompts and the workflow now has 2, the history view still shows all 10 steps with their original `prompt` text, `cliCommand`, and output.

**Why:** "Load the history for the prompts that still exist" would lose information and create confusing gaps. The full snapshot gives the user complete historical context.

**Rendering fidelity:** Each historical step shows the same `Prompt → CLI Command → Output` layout as the live view, because `CliOutput.prompt` (unexpanded prompt text) and `CliOutput.cliCommand` are already part of the saved data — no extra storage needed.

**Live capture unaffected:** `cliOutputs` in `workflowStore` is never touched by history loading. The `historyOutputs` field is a completely separate display buffer. History browsing has zero impact on live execution.

---

### 7. Orphaned history is acceptable; clear history removes `.history/` folder ✅

**Decision:** If a working file is deleted or renamed, its associated `.history/<workflow-id>/` directory becomes orphaned — acceptable for Phase 1. The existing "Clear Workflow History" action (which removes entries from the recent workflows list) will ALSO delete the corresponding `.flightpath/.history/<workflow-id>/` directory.

**Implementation note:** Update `WorkspaceSessionManager` (or wherever `clearWorkflowHistory` is handled) to also call `OutputHistoryManager.clearWorkflowHistory(workflowId)` which deletes the entire history directory.

---

## Parallel Workflows Compatibility

This architecture is designed to be a drop-in foundation for the parallel workflows plan (`docs/research/PARALLEL_WORKFLOWS_ARCHITECTURE.md`).

### How the designs align

| This design | Parallel workflows plan |
|---|---|
| One workflow, multiple run history | One `WorkflowInstance`, multiple run entries |
| History keyed by `workflowId` (working file basename) | History keyed by `WorkflowInstance.id` |
| `workflowStore.historyOutputs` — dedicated history buffer, never touches `cliOutputs` | Same pattern per workflow tab — `cliOutputs` = live, `historyOutputs` = selected run |
| `uiStore.viewingRunIndex: number` (single workflow) | `uiStore.viewingRunIndex: Record<workflowId, number>` (multi-workflow) |
| Run selector in Output panel header | Same — each workflow tab has its own Output panel with run selector |

### Migration path when parallel workflows land

1. `workflowStore` becomes per-workflow (one store instance per `WorkflowInstance`); each instance has its own `cliOutputs` (live) and `historyOutputs` (selected run display) — the pattern is identical
2. `uiStore.viewingRunIndex` changes from `number` to `Record<workflowId, number>`
3. `OutputHistoryManager` already uses `workflowId` as the key — no changes
4. Run selector component is already self-contained — reuse across tabs
5. `OUTPUT_HISTORY_LOADED` message gains a `workflowId` field to route to correct tab

**No architectural changes are needed to the history storage layer.** The `OutputHistoryManager`, `WorkflowOutputHistory` type, and `.history/` directory structure work identically for single and parallel workflows.
