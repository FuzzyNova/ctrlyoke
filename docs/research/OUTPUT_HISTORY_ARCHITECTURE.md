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

## Key Architectural Decision: Reuse CliEvent Format

**Design Choice:** Output history stores events using the existing `CliEvent[]` format from `CliOutputTypes.ts` instead of creating custom history types.

**Benefits:**

1. **Zero Duplication:** No need for separate history types (`PromptAttemptOutput`, custom rendering, etc.)
2. **Reuse Existing Rendering:** `output-manager.js` already renders `CliEvent[]` perfectly via `renderStructuredOutput()`
3. **Consistency:** Runtime display and history display use identical format and rendering logic
4. **Future-Proof:** New CLI event types (tools, thinking, etc.) automatically work in history
5. **Simplified Implementation:** Convert history → runtime format → render (single code path)
6. **Type Safety:** Leverage existing well-tested types from `CliOutputTypes.ts`

**Implementation Pattern:**

```typescript
// History storage (PromptAttemptOutput):
{
  attemptIndex: 0,
  prompt: "...",
  cliCommand: "...",
  workingDirectory: "/workspace",
  events: CliEvent[],        // Same format as runtime!
  metadata: OutputMetadata,  // Same format as runtime!
  status: "success",
  timestampMs: 123456789
}

// History rendering (output-manager.js):
function renderHistoryOutputs(history) {
  // Convert history format → runtime output format
  const runtimeOutput = {
    structured: {
      events: attempt.events,      // Direct reuse!
      metadata: attempt.metadata   // Direct reuse!
    }
  };

  // REUSE existing rendering logic
  html += renderStructuredOutput(runtimeOutput);
}
```

**Alternative Considered:** Custom history types with separate rendering logic.
**Rejected Because:** Creates duplication, maintenance burden, and inconsistency between runtime and history display.

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
- History directory: `<workflow-name-from-working-file>` (without timestamp)
- History files: `run-<N>-<ISO-timestamp>.json`
- N is sequential run number (1, 2, 3, ...)

**Why This Structure:**
- Groups all runs for same workflow together
- Easy to discover all runs for a workflow
- Sequential run IDs make navigation intuitive
- Timestamps enable sorting and display

---

## Schema Definitions

### 1. Working File Enhancement

**File:** `src/types/FlightPathTypes.ts`

```typescript
export interface WorkingFile extends PromptFile {
  originalFile: string;
  workflowName: string;
  startedAt: number;
  lastModifiedAt?: number;
  _runtime?: WorkingFileRuntime;

  /**
   * NEW: Array of history file references (newest first)
   * Relative filenames from .flightpath/.history/<workflow-id>/
   *
   * Example: ["run-3-2024-01-21T14-20-45.json", "run-2-...", "run-1-..."]
   *
   * - undefined = no history (legacy workflows, or history disabled)
   * - [] = history enabled but no completed runs yet
   * - [paths] = available run history files
   */
  outputHistory?: string[];
}
```

### 2. History File Schema

**File:** `src/types/OutputHistoryTypes.ts` (NEW)

```typescript
import { ExecutionState } from "./FlightPathTypes";
import { StatusMessageSeverity } from "./DashboardConstants";
import { CliEvent, OutputMetadata } from "./CliOutputTypes";

/**
 * Complete output history for a single workflow run
 * Stored in .flightpath/.history/<workflow-id>/run-N-<timestamp>.json
 *
 * IMPORTANT: Uses existing CliEvent[] format from CliOutputTypes.ts
 * This allows reuse of output-manager.js rendering logic (renderStructuredOutput)
 */
export interface WorkflowOutputHistory {
  // Metadata
  workflowId: string;        // Links back to working file (filename without extension)
  runId: number;             // Sequential run number (1, 2, 3, ...)
  startedAt: number;         // Run start timestamp (ms since epoch)
  completedAt?: number;      // Run completion timestamp (undefined if incomplete)
  executionState: ExecutionState; // Final state (completed, error, stopped, etc.)

  // Per-prompt outputs (keyed by stepIndex from workflow)
  promptOutputs: {
    [stepIndex: number]: PromptOutputData;
  };

  // Status messages (keyed by stepIndex)
  statusMessages: {
    [stepIndex: number]: StatusMessage[];
  };

  // Schema version for future migrations
  schemaVersion: string;     // "1.0.0"
}

/**
 * Output data for a single prompt (may have multiple attempts due to retries)
 *
 * Uses UniversalCliOutput format for consistency with runtime display.
 * Each attempt stores events in the same CliEvent[] format used by output-manager.js
 */
export interface PromptOutputData {
  // Prompt context
  promptText: string;        // For validation/matching
  promptId?: string;         // If prompt has ID
  sessionId?: string;        // CLI session ID (for resume)
  provider: string;          // Provider identifier (copilot-cli, claude-cli, codex-cli)
  model: string;

  // Array of attempts (initial + retries)
  // Each attempt uses the same CliEvent[] format as runtime
  attempts: PromptAttemptOutput[];
}

/**
 * Single attempt output (initial or retry)
 *
 * Stores CLI events in CliEvent[] format from CliOutputTypes.ts.
 * This matches the runtime format used by output-manager.js, enabling:
 * - Direct reuse of renderStructuredOutput() for history display
 * - Consistent event types (text, bashCommand, fileEdit, etc.)
 * - Full support for all CLI event types (tools, thinking, etc.)
 */
export interface PromptAttemptOutput {
  attemptIndex: number;      // 0 = initial, 1+ = retries

  // CLI execution details
  prompt?: string;           // Actual prompt sent (may differ from promptText due to automation instructions)
  cliCommand?: string;       // Full CLI command executed (for debugging)
  workingDirectory?: string; // Working directory for CLI execution

  // Structured events (same format as runtime - CliEvent[] from CliOutputTypes.ts)
  events: CliEvent[];        // Chronological events: text, tools, thinking, etc.

  // Response metadata (from CliOutputTypes.OutputMetadata)
  metadata: OutputMetadata;  // Tokens, elapsed time, session ID, model, provider

  // Result
  status: "success" | "failure" | "error" | "skipped";
  error?: string;            // Error message if failed

  // End condition
  endConditionResult?: boolean;
  scriptOutput?: string;     // End condition script output

  // Timestamp
  timestampMs: number;       // When this attempt started
}

/**
 * Status message (warnings, errors, info)
 */
export interface StatusMessage {
  message: string;
  timestamp: string;         // Formatted time (e.g., "10:30:15")
  timestampMs: number;       // Raw timestamp for sorting
  severity: StatusMessageSeverity; // info, warning, error
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
  OUTPUT_HISTORY_LOADED: "outputHistoryLoaded",      // Extension -> Webview: Send history data
  OUTPUT_HISTORY_UPDATED: "outputHistoryUpdated",    // Extension -> Webview: New run started
  LOAD_RUN_HISTORY: "loadRunHistory",                // Webview -> Extension: Request specific run
  CLEAR_RUN_HISTORY: "clearRunHistory",              // Webview -> Extension: Delete run history
} as const;
```

---

## Implementation Components

### 1. OutputHistoryManager (NEW)

**File:** `src/flightpath/orchestration/OutputHistoryManager.ts`

**Responsibility:** Manage workflow output history storage and retrieval

**Public API:**

```typescript
export class OutputHistoryManager {
  /**
   * Initialize a new run for a workflow
   *
   * Creates:
   * - .flightpath/.history/<workflow-id>/ directory (if needed)
   * - run-N-<timestamp>.json file with initial structure
   *
   * Updates:
   * - working file's outputHistory array (prepends new run)
   *
   * Returns:
   * - Absolute path to history file
   *
   * @param workflowId - Workflow identifier (from working file name)
   * @param workingFilePath - Path to working file (for updating outputHistory)
   * @param totalSteps - Total number of prompts in workflow
   * @returns Absolute path to new history file
   */
  async initializeRun(
    workflowId: string,
    workingFilePath: string,
    totalSteps: number
  ): Promise<string>;

  /**
   * Save prompt output to current run history file
   *
   * Called after each prompt completes (initial or retry).
   * Appends to attempts array if retry, replaces if initial.
   *
   * Output data uses CliEvent[] format from CliOutputTypes.ts, enabling:
   * - Direct reuse of output-manager.js rendering logic
   * - Consistent format between runtime and history
   * - Automatic support for all CLI event types
   *
   * @param historyFilePath - Path to current run history file
   * @param stepIndex - Prompt index in workflow (0-based)
   * @param outputData - Complete output data with CliEvent[] and OutputMetadata
   */
  async savePromptOutput(
    historyFilePath: string,
    stepIndex: number,
    outputData: PromptOutputData
  ): Promise<void>;

  /**
   * Save status message to current run history file
   *
   * @param historyFilePath - Path to current run history file
   * @param stepIndex - Prompt index in workflow (0-based)
   * @param statusMessage - Status message to save
   */
  async saveStatusMessage(
    historyFilePath: string,
    stepIndex: number,
    statusMessage: StatusMessage
  ): Promise<void>;

  /**
   * Finalize run (mark as completed/stopped/error)
   *
   * Updates completedAt timestamp and executionState.
   *
   * @param historyFilePath - Path to current run history file
   * @param executionState - Final execution state
   */
  async finalizeRun(
    historyFilePath: string,
    executionState: ExecutionState
  ): Promise<void>;

  /**
   * Load history file for display
   *
   * @param historyFilePath - Absolute path to history file
   * @returns Parsed history data
   * @throws Error if file not found or invalid
   */
  async loadHistory(historyFilePath: string): Promise<WorkflowOutputHistory>;

  /**
   * Get all runs for a workflow (sorted newest first)
   *
   * @param workflowId - Workflow identifier
   * @returns Array of history filenames (relative to .history/<workflow-id>/)
   */
  async getRunsForWorkflow(workflowId: string): Promise<string[]>;

  /**
   * Prune old runs based on maxHistoryRuns setting
   *
   * Deletes oldest runs beyond the limit.
   * Updates working file's outputHistory array.
   *
   * @param workflowId - Workflow identifier
   * @param workingFilePath - Path to working file
   * @param maxRuns - Maximum runs to keep (from settings)
   */
  async pruneOldRuns(
    workflowId: string,
    workingFilePath: string,
    maxRuns: number
  ): Promise<void>;

  /**
   * Get absolute path to history file
   *
   * @param workflowId - Workflow identifier
   * @param historyFileName - History filename (e.g., "run-3-2024-01-21T14-20-45.json")
   * @returns Absolute path
   */
  getHistoryFilePath(workflowId: string, historyFileName: string): string;

  /**
   * Extract workflow ID from working file path
   *
   * Example: "workflow-2024-01-21T10-30-00.flightpath.json" -> "workflow-2024-01-21T10-30-00"
   *
   * @param workingFilePath - Path to working file
   * @returns Workflow ID (filename without extension)
   */
  extractWorkflowId(workingFilePath: string): string;

  /**
   * Check if history is enabled via settings
   *
   * @returns true if flightpath.saveOutputHistory is enabled
   */
  isHistoryEnabled(): boolean;
}
```

**Implementation Details:**

**Constructor:**
```typescript
constructor(private workspaceFolder: vscode.WorkspaceFolder) {
  this.historyBaseDir = path.join(
    workspaceFolder.uri.fsPath,
    PATH_CONSTANTS.FLIGHTPATH_DIR,
    PATH_CONSTANTS.HISTORY_DIR
  );
}
```

**initializeRun() Logic:**
1. Check if history enabled (`flightpath.saveOutputHistory`)
2. If disabled, return empty string (skip history)
3. Extract workflowId from working file path
4. Create `.history/<workflow-id>/` directory if needed
5. Discover existing runs, determine next runId (max + 1, or 1 if none)
6. Generate filename: `run-<runId>-<ISO-timestamp>.json`
7. Create initial history file structure:
   ```json
   {
     "workflowId": "workflow-2024-01-21T10-30-00",
     "runId": 3,
     "startedAt": 1737470445000,
     "executionState": "running",
     "promptOutputs": {},
     "statusMessages": {},
     "schemaVersion": "1.0.0"
   }
   ```
8. Update working file: prepend filename to `outputHistory` array
9. Call `pruneOldRuns()` to enforce maxHistoryRuns limit
10. Return absolute path to history file

**savePromptOutput() Logic:**
1. Read history file (use fs.promises.readFile)
2. Parse JSON
3. If `promptOutputs[stepIndex]` doesn't exist, create:
   ```typescript
   history.promptOutputs[stepIndex] = {
     promptText: outputData.promptText,
     promptId: outputData.promptId,
     sessionId: outputData.sessionId,
     provider: outputData.provider,
     model: outputData.model,
     attempts: []
   };
   ```
4. Append attempt to `attempts` array (or replace if attemptIndex exists)
5. Write back to file (use fs.promises.writeFile with pretty JSON)
6. Handle errors gracefully (log warning, don't crash workflow)

**saveStatusMessage() Logic:**
1. Similar to savePromptOutput
2. Initialize `statusMessages[stepIndex]` array if needed
3. Append new message
4. Write back to file

**finalizeRun() Logic:**
1. Read history file
2. Update `completedAt` = Date.now()
3. Update `executionState`
4. Write back to file

**loadHistory() Logic:**
1. Read file using fs.promises.readFile
2. Parse JSON
3. Validate schema (basic checks: workflowId, runId, promptOutputs exist)
4. Return parsed object
5. Throw descriptive error if invalid

**getRunsForWorkflow() Logic:**
1. Build path: `.history/<workflow-id>/`
2. Check if directory exists (return [] if not)
3. Read directory contents
4. Filter to `run-*.json` files
5. Sort by runId (extract from filename)
6. Return array of filenames (newest first)

**pruneOldRuns() Logic:**
1. Get all runs via `getRunsForWorkflow()`
2. If count <= maxRuns, return (nothing to prune)
3. Identify runs to delete (oldest ones beyond limit)
4. Delete files using fs.promises.unlink
5. Read working file
6. Update `outputHistory` array (remove deleted runs)
7. Write working file back

**Error Handling Strategy:**
- File I/O errors: Log warning, continue (don't crash workflow)
- Invalid JSON: Log error, skip that file
- Missing directory: Auto-create on next write
- Concurrent writes: Use file locking or atomic writes (future enhancement)

---

### 2. Integration with FlightPathManager

**File:** `src/flightpath/FlightPathManager.ts`

**Changes:**

1. **Add OutputHistoryManager instance:**
   ```typescript
   private outputHistoryManager: OutputHistoryManager;

   constructor(context: vscode.ExtensionContext) {
     // ... existing code ...
     this.outputHistoryManager = new OutputHistoryManager(workspaceFolder);
   }
   ```

2. **Modify takeOff() - Initialize run:**
   ```typescript
   async takeOff(promptFile: string | PromptFile): Promise<void> {
     // ... existing setup code ...

     // Initialize output history for this run
     const workflowId = this.outputHistoryManager.extractWorkflowId(
       this.queue.getWorkingFilePath()
     );
     const historyFilePath = await this.outputHistoryManager.initializeRun(
       workflowId,
       this.queue.getWorkingFilePath(),
       this.queue.getTotalSteps()
     );

     // Store history path for later use
     this.currentHistoryFilePath = historyFilePath;

     // ... rest of takeOff logic ...
   }
   ```

3. **Modify executeNextPrompt() - Save output after completion:**
   ```typescript
   private async executeNextPrompt(): Promise<void> {
     // ... existing execution code ...

     // After prompt completes successfully
     if (this.currentHistoryFilePath && result.success) {
       // Get the CLI output data (already in CliEvent[] format from dashboard)
       const cliOutput = this.dashboardProvider.getCliOutput(stepIndex, attemptIndex);

       // Collect output data using existing UniversalCliOutput format
       const outputData: PromptOutputData = {
         promptText: currentPrompt.prompt,
         promptId: currentPrompt.id,
         sessionId: currentPrompt._runtime?.sessionId,
         provider: resolvedProps.provider,
         model: resolvedProps.model,
         attempts: [{
           attemptIndex: retryCount || 0,
           prompt: result.prompt,
           cliCommand: result.cliCommand,
           workingDirectory: result.workingDirectory,

           // Store events in CliEvent[] format (same as runtime)
           events: cliOutput?.structured?.events || [],

           // Store metadata using OutputMetadata format
           metadata: cliOutput?.structured?.metadata || {
             sessionId: currentPrompt._runtime?.sessionId,
             model: resolvedProps.model,
             provider: resolvedProps.provider,
             usage: result.tokens ? {
               inputTokens: result.tokens.prompt,
               outputTokens: result.tokens.completion,
               totalTokens: result.tokens.prompt + result.tokens.completion
             } : undefined,
             elapsed: result.elapsed
           },

           status: STEP_STATUS.SUCCESS,
           endConditionResult: result.endConditionPassed,
           timestampMs: Date.now()
         }]
       };

       await this.outputHistoryManager.savePromptOutput(
         this.currentHistoryFilePath,
         this.queue.getCurrentIndex(),
         outputData
       );
     }

     // ... rest of execution logic ...
   }
   ```

4. **Modify onWorkflowComplete() - Finalize run:**
   ```typescript
   private async onWorkflowComplete(state: ExecutionState): Promise<void> {
     // ... existing completion code ...

     // Finalize history
     if (this.currentHistoryFilePath) {
       await this.outputHistoryManager.finalizeRun(
         this.currentHistoryFilePath,
         state
       );
       this.currentHistoryFilePath = undefined;
     }

     // ... rest of completion logic ...
   }
   ```

5. **Handle retries - Append retry attempts:**
   ```typescript
   private async handleRetry(stepIndex: number, retryCount: number): Promise<void> {
     // ... existing retry logic ...

     // After retry completes, append to same prompt's attempts
     if (this.currentHistoryFilePath && retryResult.success) {
       const outputData = /* build from retry result */;
       await this.outputHistoryManager.savePromptOutput(
         this.currentHistoryFilePath,
         stepIndex,
         outputData
       );
     }
   }
   ```

6. **Status messages - Save to history:**
   ```typescript
   private sendStatusMessage(stepIndex: number, message: string, severity: string): void {
     // ... existing dashboard update ...

     // Save to history
     if (this.currentHistoryFilePath) {
       this.outputHistoryManager.saveStatusMessage(
         this.currentHistoryFilePath,
         stepIndex,
         {
           message,
           timestamp: formatTime(Date.now()),
           timestampMs: Date.now(),
           severity
         }
       );
     }
   }
   ```

---

### 3. Integration with DashboardProvider

**File:** `src/ui/FlightPathDashboardProvider.ts`

**Changes:**

1. **Add OutputHistoryManager instance:**
   ```typescript
   private outputHistoryManager: OutputHistoryManager;

   constructor(context: vscode.ExtensionContext) {
     // ... existing code ...
     this.outputHistoryManager = new OutputHistoryManager(/* workspace */);
   }
   ```

2. **Modify updateState() - Load history on session restore:**
   ```typescript
   public async updateState(state: QueueState, file?: string): Promise<void> {
     // ... existing state update ...

     // If loading session with outputHistory, load most recent run
     if (workingFile.outputHistory && workingFile.outputHistory.length > 0) {
       const workflowId = this.outputHistoryManager.extractWorkflowId(
         state.workingFilePath || ""
       );
       const mostRecentRun = workingFile.outputHistory[0];
       const historyPath = this.outputHistoryManager.getHistoryFilePath(
         workflowId,
         mostRecentRun
       );

       try {
         const history = await this.outputHistoryManager.loadHistory(historyPath);

         // Send to webview
         this.postMessage({
           type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
           history,
           availableRuns: workingFile.outputHistory.length,
           currentRunIndex: 0
         });
       } catch (error) {
         Log.warn("Failed to load output history:", error);
         // Continue without history
       }
     }
   }
   ```

3. **Add message handler - Load specific run:**
   ```typescript
   private async handleWebviewMessage(message: any): Promise<void> {
     // ... existing handlers ...

     if (message.type === MESSAGE_TYPES.LOAD_RUN_HISTORY) {
       await this.handleLoadRunHistory(message.runIndex);
       return;
     }

     if (message.type === MESSAGE_TYPES.CLEAR_RUN_HISTORY) {
       await this.handleClearRunHistory();
       return;
     }
   }

   private async handleLoadRunHistory(runIndex: number): Promise<void> {
     const workingFile = /* get from queue */;
     if (!workingFile.outputHistory || runIndex >= workingFile.outputHistory.length) {
       return;
     }

     const workflowId = this.outputHistoryManager.extractWorkflowId(
       workingFile.originalFile
     );
     const historyFileName = workingFile.outputHistory[runIndex];
     const historyPath = this.outputHistoryManager.getHistoryFilePath(
       workflowId,
       historyFileName
     );

     try {
       const history = await this.outputHistoryManager.loadHistory(historyPath);
       this.postMessage({
         type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
         history,
         availableRuns: workingFile.outputHistory.length,
         currentRunIndex: runIndex
       });
     } catch (error) {
       vscode.window.showErrorMessage(`Failed to load run history: ${error}`);
     }
   }

   private async handleClearRunHistory(): Promise<void> {
     const confirm = await vscode.window.showWarningMessage(
       "Delete all output history for this workflow?",
       { modal: true },
       "Delete"
     );

     if (confirm !== "Delete") {
       return;
     }

     const workingFile = /* get from queue */;
     const workflowId = this.outputHistoryManager.extractWorkflowId(
       workingFile.originalFile
     );

     // Delete all runs
     const runs = await this.outputHistoryManager.getRunsForWorkflow(workflowId);
     for (const run of runs) {
       const historyPath = this.outputHistoryManager.getHistoryFilePath(workflowId, run);
       await fs.promises.unlink(historyPath);
     }

     // Update working file
     workingFile.outputHistory = [];
     await this.saveWorkingFile(workingFile);

     // Notify webview
     this.postMessage({
       type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
       history: null,
       availableRuns: 0,
       currentRunIndex: 0
     });

     vscode.window.showInformationMessage("Output history cleared");
   }
   ```

---

### 4. Dashboard Webview Changes

**File:** `src/ui/webview/dashboard.html`

**Add run navigation UI to output section header:**

```html
<section id="outputSection" class="panel-section">
  <div class="section-header">
    <div class="header-left">
      <h3>Output</h3>
      <!-- NEW: Run navigation controls -->
      <div class="run-navigation" id="runNavigation" style="display: none;">
        <button id="prevRun" class="icon-btn" title="Previous run">
          <span class="codicon codicon-chevron-left"></span>
        </button>
        <span id="runIndicator" class="run-indicator">Run 1 of 1</span>
        <button id="nextRun" class="icon-btn" title="Next run">
          <span class="codicon codicon-chevron-right"></span>
        </button>
        <span id="runTimestamp" class="run-timestamp"></span>
      </div>
    </div>

    <div class="section-actions">
      <label class="checkbox-label">
        <input type="checkbox" id="autoscrollCheckbox" checked />
        <span>Auto-scroll</span>
      </label>
      <button id="exportBtn" class="icon-btn" title="Export to markdown">
        <span class="codicon codicon-export"></span>
      </button>
      <!-- NEW: Clear history button -->
      <button id="clearHistoryBtn" class="icon-btn" title="Clear output history">
        <span class="codicon codicon-trash"></span>
      </button>
      <button id="btnCollapseOutput" class="icon-btn" title="Collapse output section">
        <span class="codicon codicon-chevron-down"></span>
      </button>
    </div>
  </div>

  <div class="section-content">
    <div id="outputContent" class="output-content"></div>
  </div>
</section>
```

**File:** `src/ui/webview/dashboard.scss`

**Add styles for run navigation:**

```scss
.run-navigation {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 16px;
  padding-left: 16px;
  border-left: 1px solid var(--vscode-panel-border);

  .icon-btn {
    padding: 2px 4px;

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }

  .run-indicator {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }

  .run-timestamp {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
}
```

**File:** `src/ui/webview/state-manager.js`

**Add state fields for output history:**

```javascript
let state = {
  // ... existing fields ...

  // NEW: Output history state
  outputHistory: null,        // Currently loaded WorkflowOutputHistory object
  availableRuns: 0,           // Total number of runs available
  currentRunIndex: 0,         // Which run is displayed (0 = newest, 1 = second newest, etc.)
};
```

**File:** `src/ui/webview/output-manager.js`

**Add functions for history handling:**

```javascript
/**
 * Load and display output history
 * @param {Object} history - WorkflowOutputHistory object
 * @param {number} availableRuns - Total runs available
 * @param {number} currentRunIndex - Index of this run (0 = newest)
 */
function loadOutputHistory(history, availableRuns, currentRunIndex) {
  stateManager.updateState({
    outputHistory: history,
    availableRuns,
    currentRunIndex
  });

  // Show/hide run navigation
  if (availableRuns > 1) {
    elements.runNavigation.style.display = 'flex';
    updateRunNavigation();
  } else {
    elements.runNavigation.style.display = 'none';
  }

  // Render outputs from history
  renderHistoryOutputs(history);
}

/**
 * Update run navigation UI
 */
function updateRunNavigation() {
  const state = stateManager.getState();

  // Update indicator
  elements.runIndicator.textContent =
    `Run ${state.currentRunIndex + 1} of ${state.availableRuns}`;

  // Update buttons
  elements.prevRun.disabled = state.currentRunIndex === 0;
  elements.nextRun.disabled = state.currentRunIndex >= state.availableRuns - 1;

  // Update timestamp
  if (state.outputHistory) {
    const timestamp = new Date(state.outputHistory.startedAt);
    elements.runTimestamp.textContent = formatTimestamp(timestamp);
  }
}

/**
 * Render outputs from history object
 *
 * SIMPLIFIED: Since history uses CliEvent[] format, we can reuse renderAllCliOutputs logic!
 * Just need to convert history format to the expected state format.
 */
function renderHistoryOutputs(history) {
  if (!history || !history.promptOutputs) {
    elements.outputContent.innerHTML =
      '<p class="empty-state">No output available</p>';
    return;
  }

  // Build chronological message list (same logic as renderAllCliOutputs)
  const allMessages = [];

  // Iterate through promptOutputs
  for (const [stepIndex, promptData] of Object.entries(history.promptOutputs)) {
    const statusMessages = history.statusMessages?.[stepIndex] || [];

    // Add status messages (same as runtime)
    statusMessages.forEach((msg) => {
      allMessages.push({
        type: 'status',
        stepIndex: parseInt(stepIndex),
        timestamp: msg.timestampMs,
        data: msg
      });
    });

    // Add prompt attempts
    promptData.attempts.forEach((attempt) => {
      allMessages.push({
        type: 'copilot-cli',
        stepIndex: parseInt(stepIndex),
        timestamp: attempt.timestampMs,
        data: {
          // Convert history format to runtime output format
          prompt: attempt.prompt,
          cliCommand: attempt.cliCommand,
          workingDirectory: attempt.workingDirectory,
          structured: {
            events: attempt.events,  // CliEvent[] - already in correct format!
            metadata: attempt.metadata  // OutputMetadata - already in correct format!
          },
          tokens: attempt.metadata.usage ? {
            prompt: attempt.metadata.usage.inputTokens,
            completion: attempt.metadata.usage.outputTokens
          } : undefined,
          elapsed: attempt.metadata.elapsed,
          timestampMs: attempt.timestampMs,
          isStreaming: false
        },
        attemptIndex: attempt.attemptIndex
      });
    });
  }

  // Sort by timestamp
  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  // Render messages using EXISTING logic from renderAllCliOutputs
  let html = '';
  allMessages.forEach((item) => {
    if (item.type === 'status') {
      const statusMsg = item.data;
      const severityClass = statusMsg.severity
        ? `status-${statusMsg.severity}`
        : 'status-info';
      html += `<div class="status-message ${severityClass}">`;
      html += `<span class="status-time">[${statusMsg.timestamp}]</span> `;
      html += `<span class="status-text">${escapeHtml(statusMsg.message)}</span>`;
      html += '</div>';
    } else if (item.type === 'copilot-cli') {
      const output = item.data;
      const attemptIndex = item.attemptIndex;
      const stepIndex = item.stepIndex;
      const attemptLabel =
        attemptIndex === 0 ? 'Initial Attempt' : `Retry ${attemptIndex}`;

      html += '<div class="cli-output-item">';
      html += `<div class="output-header">[Prompt ${stepIndex + 1}] ${attemptLabel}</div>`;

      if (output.prompt) {
        html += `<div class="output-prompt">${escapeHtml(output.prompt)}</div>`;
      }

      if (output.cliCommand) {
        const workingDir = output.workingDirectory || 'workspace';
        html += `<div class="output-cli-command">${escapeHtml(workingDir)}> ${escapeHtml(output.cliCommand)}</div>`;
      }

      // REUSE existing renderStructuredOutput function!
      html += renderStructuredOutput(output);

      if (output.tokens) {
        const total = output.tokens.prompt + output.tokens.completion;
        html += `<div class="output-stats">Tokens: ${output.tokens.prompt} prompt / ${output.tokens.completion} completion / ${total} total</div>`;
      }

      if (output.elapsed !== undefined) {
        html += `<div class="output-stats">${output.elapsed}s</div>`;
      }

      html += '</div>';
    }
  });

  elements.outputContent.innerHTML = html;
}

/**
 * Navigate to previous run
 */
function navigateToPreviousRun() {
  const state = stateManager.getState();
  if (state.currentRunIndex === 0) return;

  const newIndex = state.currentRunIndex - 1;
  vscode.postMessage({
    type: MESSAGE_TYPES.LOAD_RUN_HISTORY,
    runIndex: newIndex
  });
}

/**
 * Navigate to next run
 */
function navigateToNextRun() {
  const state = stateManager.getState();
  if (state.currentRunIndex >= state.availableRuns - 1) return;

  const newIndex = state.currentRunIndex + 1;
  vscode.postMessage({
    type: MESSAGE_TYPES.LOAD_RUN_HISTORY,
    runIndex: newIndex
  });
}

// Event listeners
elements.prevRun.addEventListener('click', navigateToPreviousRun);
elements.nextRun.addEventListener('click', navigateToNextRun);
elements.clearHistoryBtn.addEventListener('click', () => {
  if (confirm('Delete all output history for this workflow?')) {
    vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_RUN_HISTORY });
  }
});
```

**File:** `src/ui/webview/message-router.js`

**Add handler for OUTPUT_HISTORY_LOADED:**

```javascript
messageHandlers[MESSAGE_TYPES.OUTPUT_HISTORY_LOADED] = (message) => {
  outputManager.loadOutputHistory(
    message.history,
    message.availableRuns,
    message.currentRunIndex
  );
};
```

---

## Settings Configuration

**File:** `package.json`

Add to `contributes.configuration.properties`:

```json
{
  "flightpath.saveOutputHistory": {
    "type": "boolean",
    "default": true,
    "description": "Save CLI output history for each workflow run. History is stored in .flightpath/.history/ directory."
  },
  "flightpath.maxHistoryRuns": {
    "type": "number",
    "default": 10,
    "minimum": 1,
    "maximum": 100,
    "description": "Maximum number of runs to keep per workflow. Older runs are automatically deleted. Set to 100 to keep all runs (not recommended for large workflows)."
  },
  "flightpath.autoLoadMostRecentOutput": {
    "type": "boolean",
    "default": true,
    "description": "Automatically load output from most recent run when opening a workflow."
  }
}
```

**Usage in code:**

```typescript
// Check if history enabled
const historyEnabled = vscode.workspace
  .getConfiguration("flightpath")
  .get<boolean>("saveOutputHistory", true);

// Get max runs limit
const maxRuns = vscode.workspace
  .getConfiguration("flightpath")
  .get<number>("maxHistoryRuns", 10);

// Auto-load setting
const autoLoad = vscode.workspace
  .getConfiguration("flightpath")
  .get<boolean>("autoLoadMostRecentOutput", true);
```

---

## Behavior Specifications

### Scenario 1: First Run (No History)

**Steps:**
1. User opens workflow file
2. User clicks Run
3. FlightPathManager.takeOff() calls outputHistoryManager.initializeRun()
4. OutputHistoryManager creates:
   - `.flightpath/.history/<workflow-id>/` directory
   - `run-1-<timestamp>.json` file with initial structure
5. Working file updated: `outputHistory = ["run-1-<timestamp>.json"]`
6. As prompts execute, outputs saved incrementally via savePromptOutput()
7. Dashboard shows output in real-time (normal behavior)
8. On completion, finalizeRun() updates completedAt and executionState
9. Dashboard shows "Run 1 of 1" (no navigation needed)

### Scenario 2: Re-run Workflow

**Steps:**
1. User clicks Run again on same workflow
2. outputHistoryManager.initializeRun() creates `run-2-<timestamp>.json`
3. Working file updated: `outputHistory = ["run-2-...", "run-1-..."]` (newest first)
4. Previous run (run-1) preserved in history
5. Dashboard switches to showing run-2 output in real-time
6. Run navigation appears: "Run 2 of 2"
7. User can click "← Previous" to view run-1 output
8. Clicking "Next →" returns to run-2

### Scenario 3: Load Old Workflow

**Steps:**
1. User opens workflow from .queue/ directory (or auto-loaded on VS Code start)
2. Working file has: `outputHistory = ["run-3-...", "run-2-...", "run-1-..."]`
3. DashboardProvider checks autoLoadMostRecentOutput setting
4. If true (default):
   - Load run-3 history via outputHistoryManager.loadHistory()
   - Send OUTPUT_HISTORY_LOADED message to webview
   - Dashboard displays output from run-3
   - Shows "Run 3 of 3 • Jan 21, 14:20"
5. Output panel populated with prompts, responses, status messages
6. User can navigate through runs 1, 2, 3

### Scenario 4: Legacy Workflow (No outputHistory)

**Steps:**
1. User opens old workflow created before this feature
2. Working file has no `outputHistory` field
3. DashboardProvider skips history loading
4. Dashboard shows empty output: "Output will appear here during execution"
5. User clicks Run
6. First run creates `outputHistory = ["run-1-..."]`
7. Future runs will have history

### Scenario 5: History Disabled via Settings

**Steps:**
1. User sets `flightpath.saveOutputHistory = false`
2. User runs workflow
3. outputHistoryManager.initializeRun() returns empty string (skip history)
4. No history directory created
5. Working file does not get `outputHistory` field
6. Dashboard behaves like legacy mode (no history navigation)

### Scenario 6: Corrupted History File

**Steps:**
1. User loads workflow with `outputHistory = ["run-2-...", "run-1-..."]`
2. run-2 file is corrupted (invalid JSON)
3. outputHistoryManager.loadHistory() throws error
4. DashboardProvider catches error, logs warning
5. Shows message: "Failed to load output (history corrupted)"
6. User can still navigate to run-1 (fallback)
7. User can run workflow to create new run-3

### Scenario 7: Max History Limit Exceeded

**Steps:**
1. User has 10 runs (maxHistoryRuns = 10)
2. User runs workflow again (creates run-11)
3. outputHistoryManager.initializeRun() calls pruneOldRuns()
4. Oldest run (run-1) is deleted
5. Working file updated: `outputHistory = ["run-11", "run-10", ..., "run-2"]` (10 total)
6. Dashboard shows "Run 11 of 10" (most recent 10)

---

## Implementation Phases

### Phase 1: Core History Storage (MVP)

**Goal:** Save and restore output for single runs

**Tasks:**
1. Create OutputHistoryTypes.ts with schema definitions
2. Implement OutputHistoryManager class:
   - initializeRun()
   - savePromptOutput()
   - saveStatusMessage()
   - finalizeRun()
   - loadHistory()
   - getRunsForWorkflow()
   - Helper methods (extractWorkflowId, getHistoryFilePath, isHistoryEnabled)
3. Update FlightPathTypes.ts: Add outputHistory field to WorkingFile
4. Add PATH_CONSTANTS.HISTORY_DIR to ConfigurationUtils
5. Integrate with FlightPathManager:
   - Call initializeRun() in takeOff()
   - Call savePromptOutput() after prompt completion
   - Call saveStatusMessage() for status messages
   - Call finalizeRun() in onWorkflowComplete()
   - Handle retries (append to attempts array)
6. Integrate with DashboardProvider:
   - Load history on session restore (updateState)
   - Send OUTPUT_HISTORY_LOADED message to webview
7. Update dashboard webview:
   - Add state fields (outputHistory, availableRuns, currentRunIndex)
   - Add loadOutputHistory() function in output-manager.js
   - Add renderHistoryOutputs() function
   - Add message handler for OUTPUT_HISTORY_LOADED
8. Add settings to package.json:
   - saveOutputHistory (default: true)
   - autoLoadMostRecentOutput (default: true)
9. Manual testing:
   - First run creates history
   - Re-run creates second history file
   - Load old workflow shows previous output
   - Disable history setting prevents creation

**Estimated Effort:** 3-4 days

**Success Criteria:**
- ✅ History files created in .history/<workflow-id>/ directory
- ✅ Outputs saved after each prompt
- ✅ Working file updated with outputHistory array
- ✅ Dashboard loads and displays most recent run
- ✅ Settings control behavior (enabled/disabled)

---

### Phase 2: Run Navigation UI

**Goal:** Allow users to cycle through previous runs

**Tasks:**
1. Update dashboard.html:
   - Add run navigation controls (prev/next buttons, indicator, timestamp)
2. Update dashboard.scss:
   - Style run navigation UI
3. Update output-manager.js:
   - Add updateRunNavigation() function
   - Add navigateToPreviousRun() / navigateToNextRun()
   - Add event listeners for prev/next buttons
   - Show/hide navigation based on availableRuns
4. Update message-router.js:
   - Add LOAD_RUN_HISTORY message type
5. Update DashboardProvider:
   - Add handleLoadRunHistory() method
   - Load requested run via outputHistoryManager
   - Send OUTPUT_HISTORY_LOADED with new run
6. Add keyboard shortcuts (optional):
   - Alt+Left: Previous run
   - Alt+Right: Next run
7. Add "Clear History" button:
   - Add clearHistoryBtn to dashboard.html
   - Add handleClearRunHistory() in DashboardProvider
   - Confirm dialog before deletion
   - Delete all run files
   - Update working file (clear outputHistory)
8. Manual testing:
   - Create 3+ runs
   - Navigate between runs using prev/next
   - Verify run indicator updates
   - Verify timestamp displays correctly
   - Test clear history command

**Estimated Effort:** 2-3 days

**Success Criteria:**
- ✅ Run navigation UI appears when multiple runs exist
- ✅ Prev/Next buttons correctly load historical runs
- ✅ Run indicator shows current position (e.g., "Run 2 of 3")
- ✅ Timestamp displays for loaded run
- ✅ Clear history deletes all runs and updates UI

---

### Phase 3: Pruning & Polish

**Goal:** Automatic cleanup and edge case handling

**Tasks:**
1. Implement pruneOldRuns() in OutputHistoryManager
2. Call pruneOldRuns() in initializeRun() after creating new run
3. Add maxHistoryRuns setting to package.json (default: 10)
4. Handle edge cases:
   - Corrupted history files (graceful degradation)
   - Missing history directory (auto-create)
   - Concurrent runs (unlikely but possible)
5. Add telemetry (optional):
   - Track history file sizes
   - Track number of runs per workflow
6. Performance optimization:
   - Debounce savePromptOutput writes (batch updates)
   - Lazy load history only when needed
7. Error handling improvements:
   - Better error messages for users
   - Fallback to empty state if history fails
8. Documentation:
   - Update README with history feature
   - Add user guide screenshots
   - Document .history/ directory structure
9. Manual testing:
   - Create 15 runs (exceeds default max of 10)
   - Verify oldest runs deleted automatically
   - Test with corrupted history file
   - Test with missing .history directory

**Estimated Effort:** 2-3 days

**Success Criteria:**
- ✅ Old runs automatically pruned based on maxHistoryRuns
- ✅ Corrupted files handled gracefully (no crashes)
- ✅ Performance acceptable with large workflows (100+ prompts)
- ✅ Error messages clear and actionable
- ✅ Documentation complete

---

### Phase 4: Advanced Features (Future)

**Tasks (Post-MVP):**
1. **Diff view between runs:**
   - Side-by-side comparison of outputs
   - Highlight changes in responses
   - Useful for testing prompt improvements

2. **Export specific runs:**
   - Allow exporting run-2 separately
   - Include metadata (model, tokens, timing)

3. **Token usage comparison:**
   - Chart showing token usage across runs
   - Identify expensive prompts

4. **Search across run history:**
   - Full-text search in all outputs
   - Find when specific text first appeared

5. **Legacy log discovery (Phase 2 migration):**
   - Implement discoverLegacyOutputs()
   - Parse provider log files as fallback
   - Migrate to history format

6. **Compression for large outputs:**
   - Gzip responses over 100KB
   - Transparent decompression on load

**Estimated Effort:** 5-7 days (spread across multiple releases)

---

## Testing Strategy

### Unit Tests

**File:** `src/test/unit/OutputHistoryManager.test.ts`

**Test Cases:**
1. initializeRun() creates directory and file
2. initializeRun() determines correct runId (sequential)
3. savePromptOutput() creates new entry
4. savePromptOutput() appends retry attempts
5. saveStatusMessage() stores messages
6. finalizeRun() updates completedAt and state
7. loadHistory() parses valid file
8. loadHistory() throws error on invalid JSON
9. getRunsForWorkflow() returns sorted list
10. pruneOldRuns() deletes oldest runs
11. extractWorkflowId() parses filename correctly
12. isHistoryEnabled() respects setting

### Integration Tests

**File:** `src/test/integration/OutputHistory.integration.test.ts`

**Test Cases:**
1. Full workflow run creates history
2. Re-run creates second history file
3. Working file outputHistory updated correctly
4. Dashboard loads history on session restore
5. Navigation between runs works
6. Clear history deletes files and updates UI
7. Pruning happens automatically at limit
8. Disabled setting prevents history creation

### Manual Testing Checklist

**First Run:**
- [ ] .history/<workflow-id>/ directory created
- [ ] run-1-<timestamp>.json file created
- [ ] Outputs saved after each prompt
- [ ] Status messages saved
- [ ] completedAt set on finish
- [ ] Working file has outputHistory array

**Re-run:**
- [ ] run-2-<timestamp>.json created
- [ ] run-1 preserved
- [ ] outputHistory array updated (newest first)
- [ ] Dashboard shows "Run 2 of 2"

**Navigation:**
- [ ] Prev/Next buttons work
- [ ] Run indicator updates
- [ ] Timestamp displays
- [ ] Content changes correctly

**Edge Cases:**
- [ ] Corrupted history shows error
- [ ] Missing directory auto-creates
- [ ] Disabled setting prevents history
- [ ] Pruning deletes old runs
- [ ] Legacy workflows work without history

---

## Migration & Backward Compatibility

### Existing Working Files

**Strategy:** Graceful enhancement with no breaking changes

**Behavior:**
- Working files without `outputHistory` field continue to work
- First run after upgrade creates history structure
- `outputHistory` field is optional (undefined = no history yet)
- Dashboard handles both cases:
  - With history: Load and display
  - Without history: Show empty state

**No Changes Required:**
- All existing PromptFile and QueueState types work as-is
- No schema version bump needed (additive change)
- Users see no disruption

### .gitignore Update

**Recommendation:** Add `.history/` to .gitignore

**File:** `.flightpath/.gitignore` (or workspace .gitignore)

```
# FlightPath output history (local artifacts, not for version control)
.history/

# Working files (contains runtime state, not for version control)
.queue/
```

**Rationale:**
- History files are local artifacts (like .queue/)
- Large files (MBs for big workflows)
- Not useful for collaboration (user-specific runs)
- Can be regenerated by re-running workflows

---

## Error Handling & Edge Cases

### 1. File I/O Errors

**Scenario:** Disk full, permission denied, etc.

**Handling:**
```typescript
try {
  await this.outputHistoryManager.savePromptOutput(...);
} catch (error) {
  Log.warn("Failed to save output history:", error);
  // Continue workflow execution (don't block on history failure)
}
```

**User Impact:** Output not saved, but workflow continues

### 2. Corrupted History Files

**Scenario:** Invalid JSON, missing fields, etc.

**Handling:**
```typescript
async loadHistory(historyFilePath: string): Promise<WorkflowOutputHistory> {
  try {
    const content = await fs.promises.readFile(historyFilePath, "utf-8");
    const history = JSON.parse(content);

    // Basic validation
    if (!history.workflowId || !history.runId) {
      throw new Error("Invalid history file: missing required fields");
    }

    return history;
  } catch (error) {
    throw new Error(`Failed to load history: ${error.message}`);
  }
}
```

**Dashboard Behavior:**
- Show error message: "Failed to load output (history corrupted)"
- Attempt to load previous run as fallback
- Allow user to continue (don't crash)

### 3. Concurrent Workflow Runs

**Scenario:** User runs same workflow in multiple VS Code windows

**Current Limitation:** Not supported (last write wins)

**Future Enhancement:** File locking or atomic writes

**Mitigation:** Document limitation, detect concurrent access

### 4. Missing .history Directory

**Scenario:** User deleted .history/ manually

**Handling:**
```typescript
async initializeRun(...): Promise<string> {
  const historyDir = path.join(this.historyBaseDir, workflowId);

  // Auto-create directory if missing
  await fs.promises.mkdir(historyDir, { recursive: true });

  // Continue normally
}
```

**User Impact:** None (transparent recreation)

### 5. Large Outputs (>10MB)

**Scenario:** Prompt generates massive response

**Current Behavior:** Save entire response

**Future Enhancement:** Compression, truncation, or streaming

**Mitigation:** Monitor file sizes, add warning if >10MB

### 6. Workflow Renamed

**Scenario:** User renames working file

**Current Behavior:** New workflowId, loses link to old history

**Future Enhancement:** Track by UUID instead of filename

**Mitigation:** Document that renaming breaks history linkage

---

## Performance Considerations

### File I/O Frequency

**Problem:** Writing history after every prompt could slow down workflows

**Solution:** Batch updates or debounce writes
```typescript
private pendingUpdates: Map<string, any> = new Map();
private writeTimeout?: NodeJS.Timeout;

async savePromptOutput(historyFilePath: string, ...): Promise<void> {
  // Debounce writes
  if (this.writeTimeout) {
    clearTimeout(this.writeTimeout);
  }

  this.pendingUpdates.set(`${historyFilePath}:${stepIndex}`, outputData);

  this.writeTimeout = setTimeout(async () => {
    await this.flushPendingUpdates();
  }, 1000); // Wait 1s before writing
}
```

### Large Workflows (100+ prompts)

**Problem:** History files could be 10MB+ for workflows with 100 prompts

**Solution 1:** Compression (gzip)
```typescript
import * as zlib from "zlib";

async savePromptOutput(...): Promise<void> {
  const content = JSON.stringify(history, null, 2);
  const compressed = zlib.gzipSync(content);
  await fs.promises.writeFile(historyFilePath + ".gz", compressed);
}
```

**Solution 2:** Truncate very long responses
```typescript
const MAX_RESPONSE_LENGTH = 100_000; // 100KB

if (response.length > MAX_RESPONSE_LENGTH) {
  response = response.substring(0, MAX_RESPONSE_LENGTH) +
    "\n\n[Response truncated - exceeded 100KB limit]";
}
```

**Recommendation:** Implement truncation in Phase 3, compression in Phase 4

### Memory Usage

**Problem:** Loading 10 runs × 10MB = 100MB in memory

**Solution:** Lazy load only current run
```typescript
// Don't preload all runs, just metadata
const availableRuns = await this.getRunsForWorkflow(workflowId);

// Load on demand when user navigates
this.postMessage({
  type: MESSAGE_TYPES.OUTPUT_HISTORY_LOADED,
  history: null, // Don't send until requested
  availableRuns: availableRuns.length,
  currentRunIndex: 0
});
```

---

## Future Enhancements

### 1. Diff View Between Runs

**UI Mockup:**
```
┌─────────────────────────────────────────┐
│ Compare Runs                            │
│ [Run 2] <──> [Run 3]                   │
├─────────────────┬───────────────────────┤
│ Run 2           │ Run 3                 │
│ (Jan 21, 11:45) │ (Jan 21, 14:20)      │
├─────────────────┼───────────────────────┤
│ Prompt 1        │ Prompt 1              │
│ Response:       │ Response:             │
│ - Old line      │ + New line            │
│   Same line     │   Same line           │
└─────────────────┴───────────────────────┘
```

**Implementation:** Use diff library (e.g., diff-match-patch)

### 2. Token Usage Charts

**Visualization:** Line chart showing token usage per run
- X-axis: Run number
- Y-axis: Total tokens
- Hover: Show prompt/completion breakdown

**Library:** Chart.js or lightweight alternative

### 3. Export Comparison Report

**Format:** Markdown file with side-by-side comparison
```markdown
# Workflow Comparison: Run 2 vs Run 3

## Summary
- Run 2: 10 prompts, 5,432 tokens, 2m 15s
- Run 3: 10 prompts, 4,821 tokens, 1m 58s
- Improvement: -11% tokens, -12% time

## Prompt 1
### Run 2 Output
...

### Run 3 Output
...

### Diff
[+ Added content]
[- Removed content]
```

### 4. Search Across Runs

**UI:** Search box in output panel
- Full-text search across all runs
- Filter by run, prompt index, or date range
- Highlight matches in output

**Implementation:** In-memory search (load all runs on demand)

---

## Documentation Updates

### README.md

Add section:

```markdown
## Output History

FlightPath automatically saves CLI output for each workflow run. This allows you to:
- Review previous outputs after restarting VS Code
- Compare outputs across multiple runs
- Track improvements to your prompts over time

**Settings:**
- `flightpath.saveOutputHistory`: Enable/disable history (default: true)
- `flightpath.maxHistoryRuns`: Max runs to keep per workflow (default: 10)

**Storage:**
- History is stored in `.flightpath/.history/<workflow-id>/`
- Add `.history/` to your `.gitignore` (recommended)

**Navigation:**
- Use ← → buttons in the output panel to cycle through runs
- View timestamps and run numbers
- Clear history with the trash icon
```

### User Guide (docs/USER_GUIDE.md)

Add section with screenshots:
1. How history is saved automatically
2. How to navigate between runs
3. How to clear history
4. Settings explanation

### Developer Guide (docs/DEVELOPER_GUIDE.md)

Add section:
1. OutputHistoryManager API
2. History file schema
3. Integration points
4. How to extend for new features

---

## Summary Checklist

**Phase 1: Core History Storage**
- [ ] Create OutputHistoryTypes.ts
- [ ] Implement OutputHistoryManager class
- [ ] Update FlightPathTypes.ts (add outputHistory field)
- [ ] Integrate with FlightPathManager
- [ ] Integrate with DashboardProvider
- [ ] Update dashboard webview (state, rendering)
- [ ] Add settings to package.json
- [ ] Manual testing (first run, re-run, load old)

**Phase 2: Run Navigation UI**
- [ ] Add run navigation controls to dashboard.html
- [ ] Style run navigation UI
- [ ] Implement navigation logic in output-manager.js
- [ ] Add message handlers for LOAD_RUN_HISTORY
- [ ] Add "Clear History" button and handler
- [ ] Manual testing (navigation, clear)

**Phase 3: Pruning & Polish**
- [ ] Implement pruneOldRuns() logic
- [ ] Add maxHistoryRuns setting
- [ ] Handle edge cases (corruption, missing dirs)
- [ ] Performance optimization (debounce, lazy load)
- [ ] Documentation (README, user guide)
- [ ] Manual testing (pruning, edge cases)

**Future Enhancements (Phase 4+)**
- [ ] Diff view between runs
- [ ] Token usage charts
- [ ] Export comparison report
- [ ] Search across runs
- [ ] Compression for large outputs

---

## Questions for Implementation

1. **Debounce Interval:** Should we wait 1s, 5s, or immediately write history?
   - Recommendation: 1s debounce (balance between data safety and I/O frequency)

2. **Compression:** Enable by default or only for large files?
   - Recommendation: Add in Phase 4, optional via setting

3. **Max Response Size:** Should we truncate responses over 100KB?
   - Recommendation: Add in Phase 3, configurable setting

4. **Error Reporting:** Show error notifications or just log warnings?
   - Recommendation: Log warnings (don't interrupt workflow), show notification on load failure

5. **Legacy Migration:** Should Phase 1 include log file discovery?
   - Recommendation: No, defer to Phase 4 (keeps Phase 1 simple)

---

This plan provides a complete blueprint for implementing the output history architecture. Each phase is self-contained and builds on the previous one. The implementation can be done incrementally, with Phase 1 being the minimum viable product.
