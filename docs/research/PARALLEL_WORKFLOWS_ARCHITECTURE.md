# Parallel Workflows Architecture Plan

**Document Status**: Planning / Research
**Last Updated**: 2026-01-12
**Author**: Claude Code Planning Agent

---

## Executive Summary

This document outlines a comprehensive plan to re-architect FlightPath to support **concurrent workflow execution**. Currently, FlightPath is designed around a single-workflow-at-a-time model with a singleton `PromptQueue` and `FlightPathManager`. To enable parallel workflows, we need fundamental changes to state management, UI/UX, resource orchestration, and command routing.

**Key Goals**:

1. Allow users to run multiple workflows simultaneously
2. Maintain independent state for each workflow (queue, execution status, results)
3. Provide clear UI/UX for managing multiple workflows (tabs, controls, visual feedback)
4. Handle resource constraints (terminal sessions, process limits, API rate limits)
5. Preserve existing single-workflow UX for users who don't need parallelism

---

## Current Architecture Analysis

### Core Components (Single Workflow)

#### 1. FlightPathManager (Singleton Pattern)

**File**: `src/flightpath/FlightPathManager.ts`

**Current State**:

- Single `promptQueue: PromptQueue` instance
- Single `currentPromptFile?: { filePath: string; promptFile: PromptFile }` reference
- Single `activeIntegration?: CopilotIntegration` reference
- Single `workflowExecutor: WorkflowExecutor` instance
- Single `startPending: boolean` flag for race condition guard

**Responsibilities**:

- Orchestrates single workflow lifecycle (load, execute, pause, resume, stop, clear)
- Factory pattern for creating integrations (CLI/Chat)
- Delegates to `WorkflowExecutor` for execution loop
- Sends updates to single dashboard provider

**Key Methods**:

- `loadPromptFile(filePath)` - Loads a workflow
- `executeLoadedPromptFile(modeOverride?, continueFromCurrent?)` - Starts execution
- `pause()`, `resume()`, `stop()` - Execution controls (no workflow ID parameter)
- `clearWorkflow()` - Clears current workflow state

#### 2. PromptQueue (State Machine)

**File**: `src/flightpath/PromptQueue.ts`

**Current State**:

- Single queue state: `{ currentIndex, status, prompts, results, completedIds, workingFilePath, workflowName }`
- Single execution state: `IDLE → RUNNING → PAUSED/STOPPED/COMPLETED/ERROR`
- Single working file path (`.flightpath/.queue/workflow-timestamp.flightpath.json`)

**Responsibilities**:

- Manages single workflow state
- Sequential execution tracking (currentIndex, completedIds)
- Working file persistence (create, read, update)
- State change events (emits to FlightPathManager)

**Key Methods**:

- `start()`, `pause()`, `resume()`, `stop()` - State transitions (no workflow ID)
- `markCurrentAsSent()`, `completeCurrentAndMoveNext()` - Progress tracking
- `createWorkingFile()`, `updateWorkingFile()`, `restoreFromWorkingFile()` - Persistence

#### 3. WorkflowExecutor (Execution Loop)

**File**: `src/flightpath/WorkflowExecutor.ts`

**Current State**:

- Single execution loop (`execute()` method)
- Single pending response state (`pendingResponseResolver`, `pendingResponseText`)
- Single integration reference passed as parameter

**Responsibilities**:

- Sequential prompt execution with pause/resume support
- Response waiting and completion detection
- End condition evaluation (delegates to `EndConditionHandler`)
- Dashboard updates for single workflow

**Key Methods**:

- `execute(integration, context)` - Main execution loop
- `waitForResponseComplete()` - Blocks until response ready
- `hasPendingResponse()`, `resumePendingResponse()` - Pause/resume state

#### 4. Dashboard UI (Single Workflow View)

**Files**:

- Backend: `src/ui/FlightPathDashboardProvider.ts`
- Frontend: `src/ui/webview/dashboard.html`, `dashboard.js`

**Current State**:

- Single workflow status header (workflow name, execution state)
- Single prompts list (shows all prompts for current workflow)
- Single output stream (shows execution log for current workflow)
- Single editor (shared for creating/editing prompts)
- Single set of execution controls (run/pause/stop buttons apply to current workflow)

**Message Types** (from `src/types/DashboardConstants.ts`):

- `FILE_SELECTED` - Loads workflow into dashboard
- `EXECUTION_STARTED` - Starts showing progress
- `PROGRESS_UPDATE` - Updates current/total prompt counts
- `EXECUTION_STATE_CHANGED` - Updates status (IDLE, RUNNING, PAUSED, etc.)
- `STEP_STATUS_CHANGED` - Updates individual prompt status
- `EXECUTION_COMPLETED` - Marks workflow complete

**No Workflow Identification**: All messages assume single workflow context.

---

## Design Constraints & Considerations

### 1. Integration Limits (Critical)

**CLI Integrations** (Copilot, Claude, Codex):

- **Terminal Sessions**: Each workflow needs its own terminal/process
  - VS Code terminal limit: ~50 terminals (practical limit lower)
  - Background processes: No hard limit, but memory/CPU constraints apply
- **Session Continuity**: CLI integrations maintain session state (chat history)
  - Claude CLI: Maintains conversation history via `--session` flag
  - Copilot CLI: Maintains session via temp log files
  - Codex CLI: Maintains session via JSONL event streaming
- **Concurrent Execution**: ✅ Can run multiple CLI processes simultaneously
  - Each process is independent (no shared state)
  - Limited by system resources (RAM, CPU, file handles)

**Chat Integration** (Copilot Chat UI):

- **Single Chat Window**: Only one active Copilot Chat instance in VS Code
  - ❌ **Cannot run multiple Chat workflows in parallel**
  - Must serialize Chat workflows or fall back to CLI for parallelism
- **UI Automation**: Requires exclusive control of chat input
  - ⚠️ Race conditions if multiple workflows try to use chat simultaneously

**Recommendation**:

- ✅ Allow parallel CLI workflows (Copilot CLI, Claude CLI, Codex CLI)
- ❌ Restrict Chat integration to single workflow at a time
- Show warning if user tries to run multiple Chat workflows

### 2. Working File Conflicts

**Current System** (`.flightpath/.queue/`):

- Each workflow creates a working file: `{workflowName}-{timestamp}.flightpath.json`
- File watcher monitors working file for external changes (MCP appends)
- File naming prevents conflicts (timestamp ensures uniqueness)

**Parallel Workflows**:

- ✅ Each workflow gets its own working file (no conflicts)
- ✅ File watchers are per-workflow (no cross-talk)
- ⚠️ Increased disk I/O if many workflows run simultaneously
- ⚠️ .queue directory may accumulate many files (consider cleanup policy)

### 3. Resource Management

**Memory Usage**:

- Each workflow instance holds: queue state, prompts array, results array, completedIds set
- Estimated ~1-10 MB per workflow (depending on prompt count and response sizes)
- Limit: Recommend max 10-20 concurrent workflows

**CPU Usage**:

- CLI processes consume CPU during execution
- End condition scripts consume CPU
- Limit: Tied to process limits (see Integration Limits)

**API Rate Limits**:

- Copilot/Claude/Codex APIs may have rate limits
- Running 10+ workflows could hit rate limits
- Consider: Queue system for pending workflows if limit reached

### 4. UX Complexity

**Single Workflow** (Current):

- Simple, linear flow: Load → Run → Monitor → Complete
- All controls apply to one workflow (no ambiguity)
- User knows exactly what's running at any moment

**Parallel Workflows** (Proposed):

- **Cognitive load**: User must track multiple workflows
- **Control ambiguity**: Which workflow do commands apply to?
- **Visual clutter**: How to show 5+ workflows without overwhelming UI?
- **Context switching**: User must switch between workflows to monitor progress

**Design Goal**: Maintain simplicity while enabling parallelism for power users.

---

## Proposed Architecture (Multi-Workflow)

### Overview: Workflow Manager Pattern

**Core Concept**: Introduce a `WorkflowOrchestrator` that manages multiple `WorkflowInstance` objects. Each instance encapsulates its own queue, executor, state, and working file.

```
┌─────────────────────────────────────────────────────────────────┐
│                    WorkflowOrchestrator                          │
│  - Manages Map<workflowId, WorkflowInstance>                    │
│  - Routes commands to specific workflows                         │
│  - Tracks active workflow ID for context                         │
│  - Enforces resource limits (max concurrent workflows)           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ creates/manages
                              ▼
         ┌────────────────────────────────────────────┐
         │         WorkflowInstance                   │
         │  - id: string (UUID)                       │
         │  - promptQueue: PromptQueue                │
         │  - workflowExecutor: WorkflowExecutor      │
         │  - activeIntegration?: CopilotIntegration  │
         │  - currentPromptFile?: PromptFile          │
         │  - status: WorkflowStatus                  │
         │  - createdAt: number                       │
         │  - startedAt?: number                      │
         │  - completedAt?: number                    │
         └────────────────────────────────────────────┘
```

### Component Changes

#### 1. NEW: WorkflowOrchestrator

**File**: `src/flightpath/WorkflowOrchestrator.ts` (NEW)

**Responsibilities**:

- Create and destroy workflow instances
- Maintain registry of active workflows (Map<workflowId, WorkflowInstance>)
- Route commands to specific workflows (by workflowId)
- Track active workflow for keyboard shortcuts and context menus
- Enforce concurrent workflow limits (max count, resource checks)
- Coordinate with dashboard for multi-workflow UI updates

**Key Properties**:

```typescript
class WorkflowOrchestrator {
  private workflows: Map<string, WorkflowInstance> = new Map();
  private activeWorkflowId: string | null = null; // For context-aware commands
  private maxConcurrentWorkflows: number = 10; // Configurable setting
  private dashboardProvider?: FlightPathDashboardProvider;
  private context: vscode.ExtensionContext;
}
```

**Key Methods**:

```typescript
// Workflow Lifecycle
createWorkflow(filePath: string, options?: WorkflowOptions): Promise<WorkflowInstance>
destroyWorkflow(workflowId: string): Promise<void>
getWorkflow(workflowId: string): WorkflowInstance | undefined
getAllWorkflows(): WorkflowInstance[]
getActiveWorkflow(): WorkflowInstance | undefined
setActiveWorkflow(workflowId: string): void

// Execution Control (routes to specific workflow)
executeWorkflow(workflowId: string, modeOverride?: Provider): Promise<void>
pauseWorkflow(workflowId: string): void
resumeWorkflow(workflowId: string): Promise<void>
stopWorkflow(workflowId: string): Promise<void>
clearWorkflow(workflowId: string): void

// Resource Management
canCreateWorkflow(): { allowed: boolean; reason?: string }
getRunningWorkflowCount(): number
getTotalWorkflowCount(): number

// Context-aware shortcuts (use activeWorkflowId)
executeActive(): Promise<void>
pauseActive(): void
resumeActive(): Promise<void>
stopActive(): Promise<void>
```

**Resource Limits**:

```typescript
// Check before creating new workflow
canCreateWorkflow(): { allowed: boolean; reason?: string } {
  const runningCount = Array.from(this.workflows.values())
    .filter(w => w.status === 'RUNNING')
    .length;

  if (runningCount >= this.maxConcurrentWorkflows) {
    return {
      allowed: false,
      reason: `Maximum concurrent workflows reached (${this.maxConcurrentWorkflows}). Pause or stop a workflow first.`
    };
  }

  // Check Chat integration conflicts
  const chatWorkflows = Array.from(this.workflows.values())
    .filter(w => w.integration instanceof CopilotChatIntegration && w.status === 'RUNNING');

  if (chatWorkflows.length > 0) {
    return {
      allowed: false,
      reason: 'Cannot run multiple Chat workflows simultaneously. Use CLI mode for parallel execution.'
    };
  }

  return { allowed: true };
}
```

#### 2. NEW: WorkflowInstance

**File**: `src/flightpath/WorkflowInstance.ts` (NEW)

**Responsibilities**:

- Encapsulates single workflow's state and dependencies
- Wraps PromptQueue, WorkflowExecutor, and integration
- Provides workflow metadata (id, name, status, timestamps)
- Self-contained: Can be serialized/restored from working file

**Key Properties**:

```typescript
class WorkflowInstance {
  // Identity
  readonly id: string; // UUID generated at creation
  workflowName: string; // User-friendly name (editable)

  // Core Components (same as current FlightPathManager)
  private promptQueue: PromptQueue;
  private workflowExecutor: WorkflowExecutor;
  private activeIntegration?: CopilotIntegration;

  // Context
  currentPromptFile?: { filePath: string; promptFile: PromptFile };
  workingFilePath?: string;

  // Status
  status: WorkflowStatus; // 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'COMPLETED' | 'ERROR'
  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  // Execution State
  private startPending: boolean = false; // Race condition guard
}
```

**Key Methods**:

```typescript
// Lifecycle (mirrors current FlightPathManager methods)
async loadPromptFile(filePath: string): Promise<void>
async executeLoadedPromptFile(modeOverride?: Provider, continueFromCurrent?: boolean): Promise<void>
pause(): void
async resume(): Promise<void>
async stop(): Promise<void>
clearWorkflow(): void

// State Access
getQueueState(): QueueState
getCurrentPromptFile(): { fileName: string; prompts: any[] } | null
getStatus(): WorkflowStatus
getMetadata(): WorkflowMetadata
```

**Serialization Support**:

```typescript
// Export state for persistence
toJSON(): WorkflowInstanceState {
  return {
    id: this.id,
    workflowName: this.workflowName,
    workingFilePath: this.workingFilePath,
    currentPromptFilePath: this.currentPromptFile?.filePath,
    status: this.status,
    createdAt: this.createdAt,
    startedAt: this.startedAt,
    completedAt: this.completedAt,
    queueState: this.promptQueue.getState()
  };
}

// Restore from persisted state
static async fromJSON(state: WorkflowInstanceState, context: vscode.ExtensionContext): Promise<WorkflowInstance> {
  const instance = new WorkflowInstance(state.id, context);
  instance.workflowName = state.workflowName;
  instance.status = state.status;
  // ... restore all state
  if (state.workingFilePath) {
    await instance.promptQueue.restoreFromWorkingFile(state.workingFilePath);
  }
  return instance;
}
```

#### 3. REFACTOR: FlightPathManager

**File**: `src/flightpath/FlightPathManager.ts` (REFACTOR)

**Old Role**: Singleton orchestrator for single workflow
**New Role**: Thin facade over WorkflowOrchestrator for command routing

**Responsibilities** (Simplified):

- Command registration (register VS Code commands)
- Orchestrator lifecycle (create WorkflowOrchestrator on activation)
- Context-aware command routing (use activeWorkflowId from orchestrator)
- Dashboard provider coordination (pass to orchestrator)
- Settings management (read configuration, pass to orchestrator)

**Key Changes**:

```typescript
class FlightPathManager {
  // REMOVE: Single workflow state
  // private promptQueue: PromptQueue; ❌
  // private workflowExecutor: WorkflowExecutor; ❌
  // private activeIntegration?: CopilotIntegration; ❌
  // private currentPromptFile?: PromptFile; ❌

  // ADD: Orchestrator reference
  private workflowOrchestrator: WorkflowOrchestrator; ✅

  constructor(context: vscode.ExtensionContext, dashboardProvider?: FlightPathDashboardProvider) {
    this.context = context;
    this.dashboardProvider = dashboardProvider;

    // Create orchestrator (manages all workflows)
    this.workflowOrchestrator = new WorkflowOrchestrator(context, dashboardProvider);

    // Integration factories stay here (shared across workflows)
    this.copilotCliIntegration = new CopilotCommandLineIntegration(context);
    this.chatIntegration = new CopilotChatIntegration(context);
    this.claudeCliIntegration = new ClaudeCommandLineIntegration(context);
    this.codexCliIntegration = new CodexCommandLineIntegration(context);
  }

  // Command routing (context-aware: uses active workflow)
  async executeLoadedPromptFile(): Promise<void> {
    await this.workflowOrchestrator.executeActive();
  }

  pause(): void {
    this.workflowOrchestrator.pauseActive();
  }

  async resume(): Promise<void> {
    await this.workflowOrchestrator.resumeActive();
  }

  async stop(): Promise<void> {
    await this.workflowOrchestrator.stopActive();
  }
}
```

**Command Parameter Updates**:

```typescript
// OLD: No workflow ID (assumes single workflow)
vscode.commands.registerCommand("flightpath.pause", () => manager.pause());

// NEW: Optional workflow ID (defaults to active workflow)
vscode.commands.registerCommand("flightpath.pause", (workflowId?: string) => {
  if (workflowId) {
    orchestrator.pauseWorkflow(workflowId);
  } else {
    orchestrator.pauseActive();
  }
});
```

#### 4. REFACTOR: Dashboard (Multi-Workflow UI)

**Files**:

- Backend: `src/ui/FlightPathDashboardProvider.ts` (REFACTOR)
- Frontend: `src/ui/webview/dashboard.html` (MAJOR REFACTOR)
- Frontend: `src/ui/webview/dashboard.js` (MAJOR REFACTOR)

**UI Design: Tab-Based Layout**

```
┌────────────────────────────────────────────────────────────────┐
│  FlightPath Dashboard                                     [×]   │
├────────────────────────────────────────────────────────────────┤
│  ┌──────────┬──────────┬──────────┬─────────┬────────────┐     │
│  │ Workflow │ Workflow │ Workflow │         │ New (+)    │     │
│  │ 1 ●      │ 2 ✓      │ 3 ⏸      │   ...   │            │     │
│  └──────────┴──────────┴──────────┴─────────┴────────────┘     │
│                                                                  │
│  Active Tab Content (Workflow 1):                               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Workflow Name: "Feature Implementation"        [▶] [⏸] [⏹] │ │
│  │ Status: Running (3/5 prompts)                              │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ Prompts List                                               │ │
│  │  ✓ 1. Analyze codebase                                     │ │
│  │  ✓ 2. Design architecture                                  │ │
│  │  ● 3. Implement feature (running...)                       │ │
│  │    4. Write tests                                          │ │
│  │    5. Update docs                                          │ │
│  ├────────────────────────────────────────────────────────────┤ │
│  │ Output                                                     │ │
│  │  [Streaming response from prompt 3...]                     │ │
│  └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Tab States**:

- **Active Tab**: Bold text, highlighted border
- **Running Workflow**: Blue dot (●) indicator
- **Paused Workflow**: Orange pause icon (⏸)
- **Completed Workflow**: Green checkmark (✓)
- **Error Workflow**: Red X (✗)

**Tab Actions**:

- **Click Tab**: Switch to that workflow
- **Right-Click Tab**: Context menu (Pause, Stop, Close, Rename)
- **Close Button**: Close tab (confirm if running)
- **New Button**: Create new workflow

**Message Protocol Updates**:

Add `workflowId` to all messages for routing:

```typescript
// OLD: No workflow identification
{ type: 'EXECUTION_STARTED', fileName: 'test.yaml', totalSteps: 5 }

// NEW: Include workflow ID
{ type: 'EXECUTION_STARTED', workflowId: 'abc123', fileName: 'test.yaml', totalSteps: 5 }
```

**New Message Types** (add to `src/types/DashboardConstants.ts`):

```typescript
// Workflow Management
WORKFLOW_CREATED: 'workflow-created',           // New workflow instance created
WORKFLOW_CLOSED: 'workflow-closed',             // Workflow removed
WORKFLOW_SWITCHED: 'workflow-switched',         // User switched active tab
WORKFLOWS_LIST: 'workflows-list',               // Full list of workflows
SET_ACTIVE_WORKFLOW: 'set-active-workflow',     // Change active workflow

// Tab-Specific Updates (include workflowId in each)
WORKFLOW_STATUS_CHANGED: 'workflow-status-changed',  // Update tab status indicator
WORKFLOW_NAME_CHANGED: 'workflow-name-changed',      // Update tab label
```

**Frontend State Manager Updates**:

```javascript
// src/ui/webview/state-manager.js (REFACTOR)

window.FlightPathStateManager = {
  // OLD: Single workflow state
  // state: { workflowName, executionState, prompts, currentStep, totalSteps }

  // NEW: Multiple workflows state
  workflows: new Map(), // Map<workflowId, WorkflowState>
  activeWorkflowId: null, // Currently visible tab

  // Get active workflow state
  getActiveWorkflow() {
    return this.workflows.get(this.activeWorkflowId);
  },

  // Add new workflow
  addWorkflow(workflowId, initialState) {
    this.workflows.set(workflowId, initialState);
    this.activeWorkflowId = workflowId; // Auto-switch to new workflow
  },

  // Remove workflow
  removeWorkflow(workflowId) {
    this.workflows.delete(workflowId);
    if (this.activeWorkflowId === workflowId) {
      // Switch to another workflow or show empty state
      const remaining = Array.from(this.workflows.keys());
      this.activeWorkflowId = remaining.length > 0 ? remaining[0] : null;
    }
  },

  // Update specific workflow state
  updateWorkflow(workflowId, updates) {
    const workflow = this.workflows.get(workflowId);
    if (workflow) {
      Object.assign(workflow, updates);
    }
  },
};
```

**Tab Rendering**:

```javascript
// src/ui/webview/dashboard.js (NEW SECTION)

function renderWorkflowTabs() {
  const tabsContainer = document.getElementById("workflow-tabs");
  tabsContainer.innerHTML = "";

  // Render tabs for each workflow
  for (const [workflowId, workflow] of stateManager.workflows) {
    const tab = document.createElement("button");
    tab.className = "workflow-tab";
    if (workflowId === stateManager.activeWorkflowId) {
      tab.classList.add("active");
    }

    // Status indicator
    const statusIcon = getStatusIcon(workflow.executionState);

    // Tab content
    tab.innerHTML = `
      ${statusIcon}
      <span class="tab-label">${workflow.workflowName}</span>
      <button class="tab-close" onclick="closeWorkflow('${workflowId}')">&times;</button>
    `;

    // Click to switch
    tab.onclick = () => switchToWorkflow(workflowId);

    tabsContainer.appendChild(tab);
  }

  // New workflow button
  const newTab = document.createElement("button");
  newTab.className = "workflow-tab new-tab";
  newTab.innerHTML = '<i class="codicon codicon-add"></i> New';
  newTab.onclick = () => createNewWorkflow();
  tabsContainer.appendChild(newTab);
}

function switchToWorkflow(workflowId) {
  stateManager.activeWorkflowId = workflowId;
  renderWorkflowTabs();
  renderActiveWorkflowContent();

  // Notify extension
  vscode.postMessage({
    type: MESSAGE_TYPES.SET_ACTIVE_WORKFLOW,
    workflowId,
  });
}

function closeWorkflow(workflowId) {
  const workflow = stateManager.workflows.get(workflowId);

  // Confirm if running
  if (workflow.executionState === "RUNNING") {
    if (
      !confirm(
        `Workflow "${workflow.workflowName}" is still running. Stop and close?`
      )
    ) {
      return;
    }
  }

  // Notify extension to stop and destroy workflow
  vscode.postMessage({
    type: MESSAGE_TYPES.CLOSE_WORKFLOW,
    workflowId,
  });
}
```

#### 5. NEW: Multi-Workflow Settings

**File**: `package.json` (contributes.configuration)

**New Settings**:

```json
{
  "flightpath.maxConcurrentWorkflows": {
    "type": "number",
    "default": 10,
    "minimum": 1,
    "maximum": 50,
    "description": "Maximum number of workflows that can run simultaneously"
  },
  "flightpath.autoSwitchToNewWorkflow": {
    "type": "boolean",
    "default": true,
    "description": "Automatically switch to newly created workflows"
  },
  "flightpath.closeCompletedWorkflows": {
    "type": "boolean",
    "default": false,
    "description": "Automatically close workflow tabs when execution completes"
  },
  "flightpath.showWorkflowTabIcons": {
    "type": "boolean",
    "default": true,
    "description": "Show status icons in workflow tabs"
  }
}
```

---

## Migration Strategy

### Phase 1: Backend Refactoring (No UI Changes)

**Goal**: Refactor backend to support multiple workflows without changing UI.

**Steps**:

1. Create `WorkflowInstance` class (extract from FlightPathManager)
2. Create `WorkflowOrchestrator` class (manages instances)
3. Refactor FlightPathManager to use orchestrator (but keep single-workflow facade)
4. Add workflowId to internal state (not exposed to UI yet)
5. Update all command handlers to route through orchestrator

**Validation**: Existing single-workflow UX still works, no regressions.

### Phase 2: Message Protocol Updates

**Goal**: Add workflowId to all messages without breaking existing UI.

**Steps**:

1. Update all message types to include optional `workflowId` field
2. Dashboard provider appends workflowId to all outgoing messages
3. Update backend message handlers to extract workflowId (fallback to active workflow if missing)
4. Frontend ignores workflowId for now (backward compatible)

**Validation**: Messages flow correctly, workflowId routing works.

### Phase 3: Dashboard UI Refactoring

**Goal**: Implement tab-based multi-workflow UI.

**Steps**:

1. Add tab bar to dashboard.html
2. Update state-manager.js for multi-workflow state
3. Implement tab rendering and switching
4. Update all UI components to use active workflow state
5. Add "New Workflow" button and tab close functionality

**Validation**: Can create, switch between, and close workflow tabs.

### Phase 4: Parallel Execution Support

**Goal**: Enable concurrent workflow execution.

**Steps**:

1. Remove single-workflow constraints in orchestrator
2. Add resource limit checks (max concurrent workflows)
3. Implement Chat integration serialization (if Chat workflow running, block new Chat workflows)
4. Test concurrent execution with CLI integrations
5. Add execution queue for workflows that exceed limits

**Validation**: Can run 5-10 workflows simultaneously without conflicts.

### Phase 5: Polish & Edge Cases

**Goal**: Handle all edge cases and improve UX.

**Steps**:

1. Add workflow persistence (restore tabs on reload)
2. Implement keyboard shortcuts for tab navigation (Ctrl+Tab, Ctrl+1-9)
3. Add context menu for tabs (right-click: Pause, Stop, Close, Rename)
4. Handle working file cleanup (delete on tab close)
5. Add workflow history (recent workflows dropdown)
6. Add resource monitoring (show warning if approaching limits)

**Validation**: Production-ready, all edge cases handled.

---

## Command Updates

### Context-Aware Commands (Use Active Workflow)

These commands apply to the **active workflow** (visible tab):

| Command                    | Current Behavior  | New Behavior            |
| -------------------------- | ----------------- | ----------------------- |
| `flightpath.run`           | Runs current file | Runs active workflow    |
| `flightpath.pause`         | Pauses execution  | Pauses active workflow  |
| `flightpath.resume`        | Resumes execution | Resumes active workflow |
| `flightpath.stop`          | Stops execution   | Stops active workflow   |
| `flightpath.clearWorkflow` | Clears workflow   | Clears active workflow  |

**Implementation**:

```typescript
// OLD: Direct call to FlightPathManager
vscode.commands.registerCommand("flightpath.pause", () => {
  manager.pause(); // No workflow ID needed (only one workflow)
});

// NEW: Route through orchestrator (uses activeWorkflowId)
vscode.commands.registerCommand("flightpath.pause", (workflowId?: string) => {
  if (workflowId) {
    // Explicit workflow ID (from command palette with input)
    orchestrator.pauseWorkflow(workflowId);
  } else {
    // No ID specified - use active workflow
    orchestrator.pauseActive();
  }
});
```

### NEW: Multi-Workflow Commands

Add commands for explicit workflow management:

| Command                       | Description              | Parameters           |
| ----------------------------- | ------------------------ | -------------------- |
| `flightpath.createWorkflow`   | Create new workflow      | `filePath: string`   |
| `flightpath.closeWorkflow`    | Close workflow tab       | `workflowId: string` |
| `flightpath.switchToWorkflow` | Switch active workflow   | `workflowId: string` |
| `flightpath.listWorkflows`    | Show workflow picker     | None                 |
| `flightpath.pauseWorkflow`    | Pause specific workflow  | `workflowId: string` |
| `flightpath.resumeWorkflow`   | Resume specific workflow | `workflowId: string` |
| `flightpath.stopWorkflow`     | Stop specific workflow   | `workflowId: string` |

**Workflow Picker** (Command Palette):

```
> FlightPath: Switch to Workflow
  [Running] Workflow 1: Feature Implementation (3/5 prompts)
  [Paused]  Workflow 2: Bug Fix (2/3 prompts)
  [Done]    Workflow 3: Documentation Update (5/5 prompts)

  → Press Enter to switch
  → Press Delete to close
```

---

## Edge Cases & Solutions

### 1. Chat Integration Conflicts

**Problem**: Multiple workflows try to use Copilot Chat simultaneously.

**Solution**:

- Detect Chat integration in active workflows
- Block new Chat workflows if one is already running
- Show error: "Cannot run multiple Chat workflows. Use CLI mode or wait for current workflow to finish."
- Allow queueing: "Add to queue?" → Starts when current Chat workflow completes

**Implementation**:

```typescript
// WorkflowOrchestrator.canCreateWorkflow()
const runningChatWorkflows = Array.from(this.workflows.values()).filter(
  (w) =>
    w.integration instanceof CopilotChatIntegration && w.status === "RUNNING"
);

if (runningChatWorkflows.length > 0 && newWorkflow.usesChat) {
  return {
    allowed: false,
    reason: "Chat integration already in use",
    suggestQueue: true,
  };
}
```

### 2. Terminal Overload

**Problem**: 20 workflows = 20 terminals → VS Code UI becomes cluttered.

**Solution**:

- Default to **headless mode** for CLI integrations (background process, no terminal)
- Setting: `flightpath.cliExecutionMode` per workflow (interactive vs headless)
- Show terminal count warning: "12 terminals open. Consider using headless mode."
- Auto-cleanup: Close terminals for completed workflows

**Implementation**:

```typescript
// WorkflowInstance.getDefaultCliMode()
private getDefaultCliMode(): 'interactive' | 'headless' {
  const runningCount = this.orchestrator.getRunningWorkflowCount();

  // Auto-switch to headless if many workflows running
  if (runningCount > 5) {
    return 'headless';
  }

  return ConfigurationUtils.getCliExecutionMode();
}
```

### 3. Working File Cleanup

**Problem**: .queue directory fills up with working files from closed workflows.

**Solution**:

- Delete working file when workflow tab is closed
- Setting: `flightpath.keepWorkflowHistory` (default: true)
  - true: Move to `.flightpath/.history/` instead of deleting
  - false: Delete immediately
- Auto-cleanup: Delete history files older than 30 days
- Command: "FlightPath: Clear Workflow History"

**Implementation**:

```typescript
// WorkflowOrchestrator.destroyWorkflow()
async destroyWorkflow(workflowId: string): Promise<void> {
  const workflow = this.workflows.get(workflowId);
  if (!workflow) return;

  // Stop if running
  if (workflow.status === 'RUNNING') {
    await workflow.stop();
  }

  // Clean up working file
  const keepHistory = ConfigurationUtils.shouldKeepWorkflowHistory();
  if (workflow.workingFilePath) {
    if (keepHistory) {
      await this.moveToHistory(workflow.workingFilePath);
    } else {
      await fs.unlink(workflow.workingFilePath);
    }
  }

  // Remove from registry
  this.workflows.delete(workflowId);
}
```

### 4. Tab Overflow (Too Many Workflows)

**Problem**: 15 workflow tabs → Horizontal scrolling, hard to see all tabs.

**Solution**:

- Scrollable tab bar (horizontal scroll with mouse wheel)
- Tab overflow menu: "..." button shows dropdown with all workflows
- Keyboard shortcuts: Ctrl+1-9 switches to tabs 1-9, Ctrl+0 shows overflow menu
- Auto-close completed workflows (if setting enabled)

**UI Design**:

```
┌─────────────────────────────────────────────────────────┐
│ [Wkflow 1] [Wkflow 2] [Wkflow 3] [...] [+]             │
│           ◄────────────────────────────►                │
│           Scrollable Tab Bar                            │
└─────────────────────────────────────────────────────────┘
```

### 5. Resource Limit Reached

**Problem**: User tries to create 11th workflow (max is 10).

**Solution**:

- Show error with actionable options:

  ```
  Maximum concurrent workflows reached (10/10).

  What would you like to do?
  [ Pause a workflow ]  [ Stop a workflow ]  [ Increase limit ]  [ Cancel ]
  ```

- "Pause a workflow" → Quick pick of running workflows
- "Stop a workflow" → Quick pick of running workflows
- "Increase limit" → Opens settings
- Setting: `flightpath.maxConcurrentWorkflows` (default: 10, range: 1-50)

### 6. Workflow ID Conflicts (UUID Collisions)

**Problem**: Two workflows get same UUID (extremely rare but possible).

**Solution**:

- Use crypto.randomUUID() for strong uniqueness
- Fallback: If collision detected, regenerate UUID and retry
- Collision detection: Check workflows.has(uuid) before creating

**Implementation**:

```typescript
// WorkflowOrchestrator.generateWorkflowId()
private generateWorkflowId(): string {
  let attempts = 0;
  while (attempts < 10) {
    const id = crypto.randomUUID();
    if (!this.workflows.has(id)) {
      return id;
    }
    attempts++;
  }
  throw new Error('Failed to generate unique workflow ID after 10 attempts');
}
```

### 7. Session Restoration (Reload Extension)

**Problem**: User reloads VS Code → All workflow tabs disappear.

**Solution**:

- Persist workflow registry to workspace state
- On activation, restore all workflows from working files
- Preserve active workflow ID and tab order
- Show notification: "Restored 3 workflows from previous session"

**Implementation**:

```typescript
// WorkflowOrchestrator.saveState()
async saveState(): Promise<void> {
  const state = {
    activeWorkflowId: this.activeWorkflowId,
    workflows: Array.from(this.workflows.values()).map(w => w.toJSON())
  };
  await this.context.workspaceState.update('flightpath.workflows', state);
}

// WorkflowOrchestrator.restoreState()
async restoreState(): Promise<void> {
  const state = this.context.workspaceState.get<{ workflows: WorkflowInstanceState[] }>('flightpath.workflows');
  if (!state) return;

  for (const workflowState of state.workflows) {
    const workflow = await WorkflowInstance.fromJSON(workflowState, this.context);
    this.workflows.set(workflow.id, workflow);
  }

  this.activeWorkflowId = state.activeWorkflowId;
}
```

### 8. Context Menu Confusion (Which Workflow?)

**Problem**: User right-clicks file → "Run with FlightPath" → Which workflow should it use?

**Solution**:

- If no workflows exist: Create new workflow
- If one workflow exists and idle: Load into that workflow
- If multiple workflows exist: Show quick pick:
  ```
  Run "feature.flightpath.yaml" in:
  → [New Workflow]
  → [Existing] Workflow 1 (IDLE)
  → [Existing] Workflow 2 (PAUSED)
  ```
- Default: Create new workflow (safest)

### 9. Dashboard State Sync (Webview Reload)

**Problem**: Dashboard webview reloads → All state lost.

**Solution**:

- On webview ready (MESSAGE_TYPES.READY), send full state sync:
  ```typescript
  {
    type: 'WORKFLOWS_LIST',
    workflows: [
      { workflowId: 'abc', workflowName: 'Wkflow 1', status: 'RUNNING', ... },
      { workflowId: 'def', workflowName: 'Wkflow 2', status: 'PAUSED', ... }
    ],
    activeWorkflowId: 'abc'
  }
  ```
- Frontend rebuilds all tabs and state from this message
- Works same as current INIT message (just extended for multiple workflows)

### 10. API Rate Limits

**Problem**: 10 workflows running → Hit Copilot/Claude API rate limits.

**Solution**:

- Implement exponential backoff in integrations (already exists for CLI)
- Show warning when approaching rate limits: "8 workflows running. May encounter rate limits."
- Queue workflows instead of failing: "Rate limit reached. Workflow queued."
- Setting: `flightpath.maxApiRequestsPerMinute` (default: 0 = unlimited)
- If set, orchestrator delays workflow starts to stay under limit

---

## Testing Strategy

### Unit Tests

**New Test Files**:

1. `WorkflowOrchestrator.test.ts`
   - createWorkflow() / destroyWorkflow()
   - Resource limit enforcement
   - Active workflow tracking
   - Command routing

2. `WorkflowInstance.test.ts`
   - Lifecycle (load, execute, pause, resume, stop)
   - State serialization / deserialization
   - Integration with PromptQueue

3. `Dashboard.test.ts` (Frontend)
   - Tab rendering
   - Tab switching
   - State management for multiple workflows
   - Message routing

### Integration Tests

**Test Scenarios**:

1. **Parallel Execution**: Run 3 workflows simultaneously (all CLI mode)
   - Verify each workflow executes independently
   - Verify no cross-talk between workflows
   - Verify working files are separate

2. **Chat Serialization**: Try running 2 Chat workflows
   - Verify second workflow is blocked or queued
   - Verify first workflow completes before second starts

3. **Resource Limits**: Create 11 workflows (max is 10)
   - Verify 11th workflow is rejected with error
   - Verify can create 11th after closing one workflow

4. **Tab Management**: Create, switch, close workflows
   - Verify active workflow updates correctly
   - Verify tab states (running, paused, completed) update
   - Verify working files are cleaned up on close

5. **Session Restoration**: Create workflows, reload extension
   - Verify all workflows restored
   - Verify active workflow restored
   - Verify tab order preserved

### Manual Testing Checklist

- [ ] Create new workflow via dashboard button
- [ ] Create new workflow via context menu (right-click .flightpath.yaml)
- [ ] Run multiple CLI workflows simultaneously
- [ ] Switch between workflow tabs
- [ ] Pause/resume specific workflows
- [ ] Stop specific workflows
- [ ] Close workflow tabs (with/without confirmation)
- [ ] Rename workflow
- [ ] Keyboard shortcuts (Ctrl+1-9 for tab switching)
- [ ] Tab overflow menu (>10 workflows)
- [ ] Resource limit warning
- [ ] Chat workflow serialization
- [ ] Session restoration (reload extension)
- [ ] Working file cleanup
- [ ] Status indicators in tabs (running, paused, completed, error)

---

## Performance Considerations

### Memory Usage

**Current** (Single Workflow):

- ~5 MB per workflow instance (queue state, prompts, results)
- Total: ~5 MB

**Parallel** (10 Workflows):

- ~5 MB × 10 = ~50 MB
- Dashboard state: ~5 MB (all workflow metadata)
- Total: ~55 MB

**Optimization**:

- Lazy load completed workflows (don't keep in memory)
- Stream large responses to disk instead of keeping in memory
- Limit result history (keep last 100 prompts per workflow)

### CPU Usage

**Bottlenecks**:

- CLI processes (each workflow spawns 1-2 processes)
- End condition scripts (each validation spawns a process)
- Response parsing (JSON/markdown parsing for each workflow)

**Optimization**:

- Process pooling for end condition scripts (reuse instead of spawn)
- Throttle UI updates (batch dashboard updates every 100ms)
- Background thread for response parsing (Worker threads)

### Disk I/O

**Working Files**:

- Each workflow writes working file on every prompt completion
- 10 workflows × 10 prompts × 100KB = ~10 MB disk writes

**Optimization**:

- Debounce working file writes (write at most once per second)
- Batch writes (combine multiple updates into single write)
- Compress working files (gzip for storage, uncompress on read)

---

## Implementation Timeline

**Phase 1: Backend Refactoring** (2-3 weeks)

- Week 1: Create WorkflowInstance and WorkflowOrchestrator
- Week 2: Refactor FlightPathManager to use orchestrator
- Week 3: Add tests, validate single-workflow behavior unchanged

**Phase 2: Message Protocol** (1 week)

- Add workflowId to all messages
- Update backend message handlers
- Validate message routing

**Phase 3: Dashboard UI** (2-3 weeks)

- Week 1: Implement tab bar and switching
- Week 2: Update state manager for multi-workflow
- Week 3: Add tab actions (close, rename, context menu)

**Phase 4: Parallel Execution** (1-2 weeks)

- Week 1: Remove single-workflow constraints, add resource limits
- Week 2: Test concurrent execution, fix edge cases

**Phase 5: Polish** (1-2 weeks)

- Week 1: Session restoration, keyboard shortcuts
- Week 2: Working file cleanup, overflow menu

**Total: 7-11 weeks** (depending on complexity and testing)

---

## Future Enhancements

### 1. Workflow Groups

- Organize workflows into projects or categories
- Collapse/expand groups in dashboard
- Run all workflows in a group

### 2. Workflow Templates

- Save workflow configurations as templates
- Quick start: "Create workflow from template"
- Share templates across teams

### 3. Workflow Dependencies

- Workflow B waits for Workflow A to complete
- DAG (Directed Acyclic Graph) execution
- Parallel branches with merge points

### 4. Remote Workflows

- Run workflows on remote machines (SSH)
- Distribute load across multiple machines
- Enterprise feature for scaling

### 5. Workflow Monitoring Dashboard

- Real-time metrics (CPU, memory, API calls)
- Historical execution data
- Performance analytics

### 6. Workflow Marketplace

- Share workflows with community
- Download popular workflow templates
- Rate and review workflows

---

## Open Questions

### 1. Should we support workflow nesting?

- **Scenario**: Workflow A triggers Workflow B as a sub-workflow
- **Pros**: Modular workflows, reusable components
- **Cons**: Increased complexity, harder to debug
- **Decision**: Defer to v2 (not critical for initial release)

### 2. Should workflows persist across VS Code restarts?

- **Scenario**: User closes VS Code with 5 workflows running
- **Options**:
  - A) Persist and restore on next start (complex)
  - B) Prompt user: "5 workflows running. Save state?" (simpler)
  - C) Always discard (simplest, may lose work)
- **Decision**: Option B (prompt user) for v1, Option A for v2

### 3. How to handle global rate limits?

- **Scenario**: 10 workflows × 10 API calls/min = 100 calls/min (might exceed limits)
- **Options**:
  - A) Let API fail, show error (simple)
  - B) Global queue with rate limiting (complex)
  - C) User-configurable concurrency limits (middle ground)
- **Decision**: Option C (user sets max concurrent workflows)

### 4. Should dashboard show all workflows or just active?

- **Scenario**: 20 workflows created over time (5 running, 15 completed)
- **Options**:
  - A) Show all (cluttered but complete)
  - B) Show only running/paused (clean but incomplete)
  - C) Show running + recent completed (balanced)
- **Decision**: Option C (running + recent 5 completed)

### 5. Should we support workflow pause/resume all?

- **Scenario**: User wants to pause all 10 workflows at once
- **Pros**: Convenient for batch control
- **Cons**: May not be clear which workflows are affected
- **Decision**: Add in v1 as toolbar action "Pause All" / "Resume All"

---

## Conclusion

This plan outlines a comprehensive architecture for supporting parallel workflows in FlightPath. The key design decisions are:

1. **WorkflowOrchestrator pattern**: Central manager for multiple WorkflowInstance objects
2. **Tab-based dashboard**: Clear visual separation, familiar UX pattern
3. **Resource limits**: Protect against overload (terminal count, API rate limits)
4. **Chat serialization**: Only one Chat workflow at a time (technical constraint)
5. **Context-aware commands**: Commands apply to active workflow (visible tab)
6. **Phased migration**: Backward-compatible refactoring ensures smooth transition

**Next Steps**:

1. Review this plan with team
2. Create GitHub issues for each phase
3. Start Phase 1: Backend refactoring
4. Prototype dashboard UI in parallel
5. Iterate based on feedback

**Success Criteria**:

- [ ] Can run 5+ CLI workflows simultaneously without conflicts
- [ ] Dashboard clearly shows status of all workflows
- [ ] No regressions in single-workflow UX
- [ ] Working files properly managed (no leaks)
- [ ] Resource limits prevent overload
- [ ] Session restoration works reliably

---

## Appendix: Code Snippets

### A. WorkflowOrchestrator.createWorkflow()

```typescript
/**
 * Create a new workflow instance from a prompt file
 * @param filePath Path to prompt file (.flightpath.yaml, .json, .prompt.md)
 * @param options Optional configuration overrides
 * @returns Newly created workflow instance
 */
async createWorkflow(
  filePath: string,
  options?: WorkflowOptions
): Promise<WorkflowInstance> {
  // 1. Check resource limits
  const canCreate = this.canCreateWorkflow();
  if (!canCreate.allowed) {
    throw new Error(canCreate.reason);
  }

  // 2. Generate unique workflow ID
  const workflowId = this.generateWorkflowId();

  // 3. Create workflow instance
  const workflow = new WorkflowInstance(workflowId, this.context, {
    dashboardProvider: this.dashboardProvider,
    integrationFactory: this.createIntegrationForMode.bind(this),
    ...options
  });

  // 4. Load prompt file
  await workflow.loadPromptFile(filePath);

  // 5. Register workflow
  this.workflows.set(workflowId, workflow);

  // 6. Set as active workflow (if setting enabled)
  if (ConfigurationUtils.shouldAutoSwitchToNewWorkflow()) {
    this.activeWorkflowId = workflowId;
  }

  // 7. Notify dashboard
  if (this.dashboardProvider) {
    this.dashboardProvider.postMessage({
      type: MESSAGE_TYPES.WORKFLOW_CREATED,
      workflowId,
      workflow: workflow.getMetadata()
    });
  }

  // 8. Listen for workflow state changes
  workflow.onStateChange((state) => {
    this.handleWorkflowStateChange(workflowId, state);
  });

  Log.info(`Created workflow ${workflowId}: ${workflow.workflowName}`);

  return workflow;
}
```

### B. Dashboard Tab Switching (Frontend)

```javascript
/**
 * Switch to a different workflow tab
 * Updates UI to show selected workflow's prompts, output, and controls
 */
function switchToWorkflow(workflowId) {
  // 1. Update state manager
  const previousWorkflowId = stateManager.activeWorkflowId;
  stateManager.activeWorkflowId = workflowId;

  // 2. Re-render tabs (highlight active tab)
  renderWorkflowTabs();

  // 3. Update main content area
  renderActiveWorkflowContent();

  // 4. Update execution controls (enable/disable based on workflow state)
  updateExecutionControls();

  // 5. Clear editor (don't carry over prompt from previous workflow)
  editorManager.clearEditor();

  // 6. Scroll to current prompt in prompts list
  promptsManager.scrollToCurrentPrompt();

  // 7. Notify extension (update activeWorkflowId in backend)
  vscode.postMessage({
    type: MESSAGE_TYPES.SET_ACTIVE_WORKFLOW,
    workflowId,
    previousWorkflowId,
  });

  // 8. Save preference (restore active workflow on reload)
  try {
    localStorage.setItem("flightpath.activeWorkflowId", workflowId);
  } catch (error) {
    console.warn("Failed to save active workflow preference:", error);
  }
}

/**
 * Render content for the currently active workflow
 * Populates prompts list, output, and workflow header
 */
function renderActiveWorkflowContent() {
  const workflow = stateManager.getActiveWorkflow();

  if (!workflow) {
    // No workflows - show empty state
    showEmptyState();
    return;
  }

  // Update workflow header
  workflowManager.updateWorkflowHeader(
    workflow.workflowName,
    workflow.executionState
  );

  // Render prompts list
  promptsManager.renderPrompts(workflow.prompts, workflow.currentStep);

  // Render output
  outputManager.renderOutput(workflow.outputHistory);

  // Update progress bar
  workflowManager.updateProgress(workflow.currentStep, workflow.totalSteps);
}
```

### C. Resource Limit Check (Backend)

```typescript
/**
 * Check if a new workflow can be created without exceeding resource limits
 * @returns { allowed: true } if OK, { allowed: false, reason: string } if blocked
 */
canCreateWorkflow(): { allowed: boolean; reason?: string; suggestQueue?: boolean } {
  // 1. Check max concurrent workflows
  const runningCount = this.getRunningWorkflowCount();
  const maxConcurrent = ConfigurationUtils.getMaxConcurrentWorkflows();

  if (runningCount >= maxConcurrent) {
    return {
      allowed: false,
      reason: `Maximum concurrent workflows reached (${runningCount}/${maxConcurrent}). ` +
              `Pause or stop a workflow first, or increase the limit in settings.`
    };
  }

  // 2. Check Chat integration conflicts
  const runningChatWorkflows = Array.from(this.workflows.values()).filter(
    w => w.usesProvider(Provider.CopilotChat) && w.isRunning()
  );

  if (runningChatWorkflows.length > 0) {
    return {
      allowed: false,
      reason: 'A Chat workflow is already running. FlightPath can only run one Chat workflow at a time. ' +
              'Use CLI mode (Copilot CLI, Claude CLI, or Codex CLI) for parallel execution.',
      suggestQueue: true // Suggest adding to queue
    };
  }

  // 3. Check system resources (optional, may defer to v2)
  // const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024; // MB
  // if (memoryUsage > 500) { // More than 500 MB
  //   return {
  //     allowed: false,
  //     reason: 'System memory usage is high. Close some workflows before creating new ones.'
  //   };
  // }

  return { allowed: true };
}
```

---

**End of Document**
