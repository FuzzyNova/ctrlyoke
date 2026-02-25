# Multi-Workflow Architecture Plan

**Document Status**: Active Planning
**Last Updated**: 2026-02-24
**Author**: Claude Code Planning Agent

---

## Executive Summary

This document outlines the plan to re-architect FlightPath to support **multiple loaded workflows with a dropdown selector UI**. The current single-workflow singleton model will be replaced by a `WorkflowOrchestrator` managing multiple `WorkflowInstance` objects, while the UI will use an extended version of the existing `WorkflowStatus` split-button dropdown — not a tab system.

**Core Design Decisions**:

- **True parallel execution** — multiple workflows run simultaneously, each in its own terminal/process; no single-runner constraint
- **Dropdown, not tabs** — the existing `WorkflowStatus` split-button pattern is extended to show all loaded workflows, not replaced by a tab bar
- **Controls are per-active-workflow** — Run/Pause/Stop apply to the currently viewed workflow; other running workflows are unaffected
- **Remove existing blocking restrictions** — `WorkflowControls` currently disables all actions when executing; those guards are removed to enable parallel creation and loading

**Key Goals**:

1. Load multiple workflows simultaneously, each maintaining independent state
2. Switch between loaded workflows via the existing dropdown UI pattern
3. Preserve existing single-workflow UX for users who never load a second workflow
4. Resume paused or completed workflows without losing their output history
5. Clean session/process management per workflow instance

---

## Current Architecture Analysis

### State of the Codebase (February 2026)

The codebase has evolved significantly since this plan was first drafted. The major additions:

- **React webview** (`src/ui/webview-react/`) fully replaces the old vanilla JS dashboard
- **Zustand stores** (`workflowStore`, `uiStore`, `editorStore`, `settingsStore`) manage all UI state
- **WorkflowExecutor** extracted from FlightPathManager (separation of concerns)
- **WorkspaceSessionManager** for session persistence
- **OutputHistoryManager** for run history
- **PromptFileWatcher** for dynamic queue file monitoring
- **`WorkflowStatus` split-button** with recent-workflows dropdown already implemented

### Existing Single-Workflow Components

#### FlightPathManager (`src/flightpath/FlightPathManager.ts`)

Currently the monolithic orchestrator (~1,866 lines). Manages:

```typescript
// Single workflow state
private promptQueue: PromptQueue;
private workflowExecutor: WorkflowExecutor;
private currentPromptFile?: { filePath: string; promptFile: PromptFile };
private activeIntegration?: HarnessIntegration;
private lastKnownPromptCount: number;

// All 4 harness integrations (shared factories)
private copilotCliIntegration: CliIntegration;
private chatIntegration: CopilotChatIntegration;
private claudeCliIntegration: CliIntegration;
private codexCliIntegration: CliIntegration;

// Supporting services
private endConditionEvaluator: EndConditionEvaluator;
private endConditionHandler: EndConditionHandler;
private dashboardProvider?: FlightPathWebviewProvider;
private workspaceSessionManager: WorkspaceSessionManager;
private outputHistoryManager: OutputHistoryManager;
private promptFileWatcher: PromptFileWatcher;
```

#### PromptQueue (`src/flightpath/PromptQueue.ts`)

State machine managing a single workflow's execution queue:

```typescript
interface QueueState {
  currentIndex: number;
  status: ExecutionState;
  prompts: PromptItem[];
  results: PromptResult[];
  stopped: boolean;
  completedIds: Set<string>;
  totalExecutionTime: number;
  queueExtensions: number;
  totalPausedDuration: number;
  workingFilePath?: string;
  workflowName?: string;
}
```

#### WorkflowExecutor (`src/flightpath/orchestration/WorkflowExecutor.ts`)

Extracted execution loop. Runs sequentially through prompts with pause/resume support.

#### React Webview (`src/ui/webview-react/`)

**Stores** (Zustand):

- `workflowStore.ts` — single workflow: `fileName`, `workflowName`, `executionState`, `prompts`, `cliOutputs`, etc.
- `uiStore.ts` — layout state, history view, modal state, `recentWorkflows`
- `editorStore.ts` — prompt editor state
- `settingsStore.ts` — harness/model configuration

**Key UI Components** (relevant to this plan):

- `Header.tsx` — `[WorkflowControls] | [WorkflowStatus (center)] | [Run/Pause/Stop]`
- `WorkflowStatus.tsx` — Split-button: workflow name (editable) + dropdown trigger
- `WorkflowControls.tsx` — Split-button: New/From Template/Load File/Queue File
- `RecentWorkflows.tsx` — Dropdown list of recent (historical) workflows

**Current Enforcement** (already in place):

- `WorkflowStatus` dropdown: `disabled={isRunning}` — cannot switch while running
- `WorkflowControls` buttons: `disabled={isExecuting}` — cannot load/create while running/paused

#### Message Types (`src/types/DashboardConstants.ts`)

All messages between extension ↔ webview. No `workflowId` field exists yet; all messages assume single workflow context.

---

## Design Constraints

### 1. True Parallel Execution

**Decision**: Multiple workflows can be `RUNNING` simultaneously. There is **no single-runner constraint**.

**Rationale**:

- Each CLI harness runs in its own independent terminal/process — there is no technical conflict
- Users should be able to, e.g., run a bug-fix workflow while a doc-generation workflow is already executing
- The whole purpose of this architecture is parallel execution

**Implications**:

- Run/Pause/Stop buttons in the header apply to the **currently viewed** workflow, not "the" workflow
- `WorkflowOrchestrator` tracks each instance's state independently
- The `runningWorkflowId` field is replaced by checking `instance.status === RUNNING` per-instance

**Chat harness caveat**: `CopilotChatIntegration` drives a single VS Code Chat window — running two Chat-harness workflows simultaneously would conflict. The orchestrator will warn but not hard-block (the user may know what they're doing). CLI harnesses (copilot-cli, claude-cli, codex-cli) have no such limitation.

### 2. Current UX Restrictions That Must Be Removed

The current codebase **explicitly blocks** these actions when any execution is in progress. These restrictions must be lifted to enable parallel workflows:

| Component              | Current Restriction                        | New Behavior                                                      |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `WorkflowControls.tsx` | All buttons `disabled={isExecuting}`       | Buttons always enabled (New, Load, Queue work while another runs) |
| `WorkflowStatus.tsx`   | Dropdown `if (isRunning) return`           | Dropdown always openable                                          |
| `Header.tsx`           | Run button checks `isRunning` globally     | Run button only checks the **active** workflow's own state        |
| `EditorSection.tsx`    | "New Prompt" button `disabled={isRunning}` | Always enabled                                                    |
| `EditorFooter.tsx`     | All editor buttons `disabled={isRunning}`  | Per-prompt status check instead of global `isRunning`             |

The key insight: controls apply to the **active/viewed** workflow. Whether other workflows are running is irrelevant.

### 3. Dropdown Selector (Not Tabs)

**Decision**: Extend the existing `WorkflowStatus` split-button to show **all loaded workflows** (not just recent history files). The dropdown becomes a "loaded workflow switcher."

**Rationale**:

- Consistent with existing UX — no new UI paradigm
- Fits the narrow panel width of a VS Code sidebar
- Avoids horizontal tab overflow issues
- The "recent workflows" concept already exists and works

**Dropdown sections**:

1. **Active Workflows** — currently loaded instances (with status badges)
2. **Recent Workflows** — historical files not currently loaded (existing behavior)
3. **Clear History** — existing footer action

### 4. Switching While Running

**Decision**: Switching the **viewed** workflow is allowed at any time. Creating/loading/running additional workflows is always allowed.

**Implementation**:

- `WorkflowStatus` dropdown: always openable (remove `if (isRunning) return`)
- `WorkflowControls` buttons: always enabled (remove `disabled={isExecuting}`)
- When "New" is clicked while the active workflow is running: creates a new instance and switches the view to it; the original keeps running in background
- Switching sends `SWITCH_WORKFLOW` message — UI replaces store contents with new workflow's state
- Running workflows continue executing and buffering output regardless of which is viewed

### 5. Working Files per Instance

Each `WorkflowInstance` gets its own working file in `.flightpath/.queue/`:

- Naming: `{workflowName}-{timestamp}.flightpath.json` (no conflicts, already unique by timestamp)
- File watchers: per-instance (no cross-talk)
- Cleanup: when workflow is dismissed from the loaded list

---

## Proposed Architecture

### Overview: WorkflowOrchestrator Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                    WorkflowOrchestrator                      │
│  - workflows: Map<workflowId, WorkflowInstance>              │
│  - activeWorkflowId: string | null  (currently viewed)       │
│  - Routes dashboard messages for active instance             │
│  - Buffers messages from non-active running instances        │
└─────────────────────────────────────────────────────────────┘
                              │
                    creates/manages N instances
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
  │WorkflowInst.  │   │WorkflowInst.  │   │WorkflowInst.  │
  │status: RUNNING│   │status: RUNNING│   │status: PAUSED │
  │promptQueue    │   │promptQueue    │   │promptQueue    │
  │executor       │   │executor       │   │executor       │
  │integration    │   │integration    │   │(no integration│
  └───────────────┘   └───────────────┘   └───────────────┘
   ← active/viewed →   ← background →      ← background →
```

### Component Changes

#### 1. NEW: `WorkflowOrchestrator` (`src/flightpath/WorkflowOrchestrator.ts`)

Replaces the singleton state in `FlightPathManager`. Manages the registry of loaded workflow instances.

```typescript
class WorkflowOrchestrator {
  private workflows: Map<string, WorkflowInstance> = new Map();
  private activeWorkflowId: string | null = null; // UI-visible workflow
  private dashboardProvider?: FlightPathWebviewProvider;
  private context: vscode.ExtensionContext;
  private integrationFactory: IntegrationFactory;

  // No runningWorkflowId — multiple can run; query via getRunningWorkflows()
}
```

**Key Methods**:

```typescript
// Workflow registry
createWorkflow(filePath: string): Promise<WorkflowInstance>
dismissWorkflow(workflowId: string): Promise<void>
getWorkflow(workflowId: string): WorkflowInstance | undefined
getAllWorkflows(): WorkflowInstance[]
getRunningWorkflows(): WorkflowInstance[]  // May be multiple

// Active workflow (UI-visible)
getActiveWorkflow(): WorkflowInstance | undefined
setActiveWorkflow(workflowId: string): void

// Command routing — all apply to active workflow by default
executeWorkflow(workflowId?: string, modeOverride?: Provider): Promise<void>
pauseWorkflow(workflowId?: string): void
resumeWorkflow(workflowId?: string): Promise<void>
stopWorkflow(workflowId?: string): Promise<void>
clearWorkflow(workflowId?: string): void

// Persistence
saveState(): Promise<void>
restoreState(): Promise<void>
```

**No single-runner restriction** — `executeWorkflow()` starts the specified (or active) workflow regardless of other instances' states. The only guard is for Chat harness conflicts:

```typescript
async executeWorkflow(workflowId?: string, modeOverride?: Provider): Promise<void> {
  const workflow = workflowId
    ? this.workflows.get(workflowId)
    : this.getActiveWorkflow();

  if (!workflow) { return; }

  // Warn (not block) if starting a second Chat-harness workflow
  const usesChat = workflow.harness === 'copilot-chat';
  const chatAlreadyRunning = this.getRunningWorkflows().some(
    w => w.id !== workflow.id && w.harness === 'copilot-chat'
  );
  if (usesChat && chatAlreadyRunning) {
    vscode.window.showWarningMessage(
      'Another Chat workflow is already running. Starting this one may cause conflicts.'
    );
    // Continue anyway — user decided
  }

  await workflow.execute(modeOverride);
}
```

**Dashboard Coordination**:

When the running workflow (not the active/viewed one) sends output events, the orchestrator buffers those events keyed by `workflowId`. When the user switches to view that workflow, the buffered events are sent as a state sync. This is an optimization — the working file already persists all state so a full reload from disk is always an option.

#### 2. NEW: `WorkflowInstance` (`src/flightpath/WorkflowInstance.ts`)

Encapsulates a single workflow's complete state and components. Extracted from `FlightPathManager`.

```typescript
class WorkflowInstance extends EventEmitter {
  // Identity
  readonly id: string; // UUID
  workflowName: string;
  filePath: string;

  // Components (same as current FlightPathManager fields)
  private promptQueue: PromptQueue;
  private workflowExecutor: WorkflowExecutor;
  private activeIntegration?: HarnessIntegration;
  private endConditionHandler: EndConditionHandler;
  private workspaceSessionManager: WorkspaceSessionManager;
  private outputHistoryManager: OutputHistoryManager;
  private promptFileWatcher?: PromptFileWatcher;

  // Prompt file context
  currentPromptFile?: { filePath: string; promptFile: PromptFile };

  // Buffered output (for background accumulation while not viewed)
  private bufferedEvents: BufferedWorkflowEvent[] = [];
  private isActive: boolean = false; // Whether this is the currently viewed workflow

  // Status
  status: WorkflowStatus; // derived from promptQueue.state.status
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

**Lifecycle Methods** (mirrors current `FlightPathManager` methods):

```typescript
async loadPromptFile(filePath: string): Promise<void>
async execute(modeOverride?: Provider, continueFromCurrent?: boolean): Promise<void>
pause(): void
async resume(): Promise<void>
async stop(): Promise<void>
clear(): void

// State access
getQueueState(): QueueState
getStatus(): WorkflowStatus
getSummary(): WorkflowSummary  // For dropdown display
```

**Background Buffering**:

```typescript
// Called by orchestrator when user switches away
setActive(isActive: boolean): void {
  this.isActive = isActive;
  if (isActive) {
    // Flush buffered events to dashboard
    this.flushBufferedEvents();
  }
}

private emit(eventType: string, data: unknown): void {
  if (this.isActive) {
    // Send directly to dashboard
    this.dashboardProvider?.sendMessage(eventType, data);
  } else {
    // Buffer for later
    this.bufferedEvents.push({ eventType, data, timestamp: Date.now() });
    // Also update in-memory state so getSummary() is current
  }
}
```

#### 3. REFACTOR: `FlightPathManager` (`src/flightpath/FlightPathManager.ts`)

**New Role**: Thin command dispatcher. All orchestration logic moves to `WorkflowOrchestrator` and `WorkflowInstance`.

```typescript
class FlightPathManager {
  // REMOVE: All single-workflow state fields
  // ADD: Single orchestrator reference
  private workflowOrchestrator: WorkflowOrchestrator;

  constructor(context, dashboardProvider) {
    // Integration factories stay at this level (shared across all instances)
    const integrationFactory = new IntegrationFactory(context);

    this.workflowOrchestrator = new WorkflowOrchestrator(
      context,
      dashboardProvider,
      integrationFactory
    );
  }

  // Command handlers just delegate to orchestrator
  async loadPromptFile(filePath: string): Promise<void> {
    await this.workflowOrchestrator.createWorkflow(filePath);
  }

  async executeLoadedPromptFile(modeOverride?: Provider): Promise<void> {
    await this.workflowOrchestrator.executeWorkflow(undefined, modeOverride);
  }

  pause(): void {
    this.workflowOrchestrator.pauseWorkflow();
  }
  async resume(): Promise<void> {
    await this.workflowOrchestrator.resumeWorkflow();
  }
  async stop(): Promise<void> {
    await this.workflowOrchestrator.stopWorkflow();
  }
  clear(): void {
    this.workflowOrchestrator.clearWorkflow();
  }
}
```

**Integration Factory** (extracted from FlightPathManager):

```typescript
class IntegrationFactory {
  // Creates HarnessIntegration instances on demand
  // Shared across all WorkflowInstances (each gets its own instance when executing)
  createForHarness(
    harness: Harness,
    context: vscode.ExtensionContext
  ): HarnessIntegration;
}
```

#### 4. REFACTOR: Dashboard Multi-Workflow UI

##### Backend: `FlightPathWebviewProvider.ts`

**New message handling**:

- All outgoing messages gain optional `workflowId` field
- New messages: `WORKFLOWS_LIST`, `WORKFLOW_ADDED`, `WORKFLOW_DISMISSED`, `ACTIVE_WORKFLOW_CHANGED`
- `SET_ACTIVE_WORKFLOW` from webview routes to `orchestrator.setActiveWorkflow(workflowId)`

**State sync on switch**:

```typescript
// When user switches to a workflow, send full state sync
async sendWorkflowStateSync(workflowId: string): Promise<void> {
  const workflow = this.orchestrator.getWorkflow(workflowId);
  if (!workflow) return;

  const queueState = workflow.getQueueState();

  // Send full workflow state (same as current INIT / SESSION_RESTORED flow)
  this.sendMessage(MESSAGE_TYPES.SESSION_RESTORED, {
    workflowId,
    fileName: workflow.filePath,
    workflowName: workflow.workflowName,
    prompts: queueState.prompts,
    executionState: queueState.status,
    currentStep: queueState.currentIndex,
    results: queueState.results,
    // ... buffered CLI outputs for steps
  });
}
```

##### Frontend: `WorkflowStatus.tsx` (Extended Dropdown)

The `WorkflowStatus` split-button dropdown is extended to show two sections:

**Section 1: Loaded Workflows** (new)

- All currently loaded `WorkflowInstance` objects
- Shows name, status badge, current step progress
- Clicking switches the active workflow (always enabled)

**Section 2: Recent Workflows** (existing behavior, renamed to "Load Another")

- Historical file list for loading additional workflows
- **Always enabled** — loading another workflow while one runs is a core parallel use case

**Changed behavior**: The dropdown trigger is **no longer disabled when `isRunning`**. It remains fully interactive to allow switching and loading additional workflows at any time.

```tsx
// WorkflowStatus.tsx - Updated dropdown toggle
const toggleDropdown = useCallback(() => {
  // CHANGED: Remove `if (isRunning) return;` restriction
  // Dropdown is always openable — switching is allowed while running
  if (!isDropdownOpen) {
    vscode.postMessage({ type: MESSAGE_TYPES.GET_WORKFLOWS_LIST });
  }
  setIsDropdownOpen(!isDropdownOpen);
}, [isDropdownOpen, vscode]);
```

**New dropdown content**:

```tsx
// RecentWorkflows.tsx → WorkflowSelector.tsx (renamed/extended)
<div className="workflow-selector flex flex-col h-full">
  {/* Section 1: Loaded Workflows (always shown if any loaded) */}
  {loadedWorkflows.length > 0 && (
    <>
      <SectionHeader>Loaded Workflows</SectionHeader>
      {loadedWorkflows.map((wf) => (
        <WorkflowSelectorItem
          key={wf.id}
          workflow={wf}
          isCurrent={wf.id === activeWorkflowId}
          onClick={() => onSwitchWorkflow(wf.id)}
          onDismiss={() => onDismissWorkflow(wf.id)}
        />
      ))}
      <Divider />
    </>
  )}

  {/* Section 2: Load Another (historical files) — always enabled, parallel is the goal */}
  <SectionHeader>Load Another</SectionHeader>
  {recentWorkflows.map((wf) => (
    <RecentWorkflowItem
      key={wf.filePath}
      workflow={wf}
      onClick={() => onLoadWorkflow(wf.filePath)}
    />
  ))}
  <ClearHistoryFooter />
</div>
```

**`WorkflowSelectorItem`** — new component for loaded workflows:

```tsx
// Shows: [status icon] [name] [step count] [X dismiss button]
// Status icon: spinning for RUNNING, pause for PAUSED, check for COMPLETED, etc.
// The dismiss X: confirms if workflow is paused mid-run
```

##### Frontend: `WorkflowControls.tsx` (Restrictions Removed)

The existing `disabled={isExecuting}` guards must be removed from all buttons. Creating a new workflow, loading from file, or queueing another file are all valid while the current workflow is running — that's the whole point.

```typescript
// BEFORE (current code — to be removed)
const isExecuting = isRunning || isPaused;
// All buttons: disabled={isExecuting}

// AFTER
// No isExecuting gate. Buttons are always enabled.
// The only remaining disable: "Queue File" when no file is loaded (hasQueue check stays)
```

The "New" button clicking while the active workflow is running creates a new instance and switches view to it. The original workflow keeps running uninterrupted.

##### Frontend: Zustand Stores

**`workflowStore.ts`** — minimal changes:

- Store continues to represent the **single active/viewed workflow**
- No need for `Map<workflowId, WorkflowState>` — switching workflows sends a full state sync, replacing store contents

**`uiStore.ts`** — new fields:

```typescript
// New multi-workflow UI state
loadedWorkflows: WorkflowSummary[];  // All loaded workflow instances (for dropdown)
activeWorkflowId: string | null;     // Currently viewed
```

Note: No `anyWorkflowRunning` gate — parallel running is the goal. Each `WorkflowSummary` carries its own `executionState`, so the dropdown can display running indicators per-instance.

**`WorkflowSummary`** type (for dropdown display, sent by extension):

```typescript
interface WorkflowSummary {
  id: string;
  workflowName: string;
  filePath: string;
  executionState: ExecutionState;
  currentStep: number;
  totalSteps: number;
  startedAt?: number;
  completedAt?: number;
}
```

#### 5. Message Protocol Updates

**New message types** in `DashboardConstants.ts`:

```typescript
// Extension -> Webview
WORKFLOWS_LIST: "workflowsList",          // Full list of loaded WorkflowSummary[]
WORKFLOW_ADDED: "workflowAdded",          // New workflow loaded
WORKFLOW_DISMISSED: "workflowDismissed",  // Workflow removed from loaded list
WORKFLOW_SUMMARY_UPDATED: "workflowSummaryUpdated", // Status/progress changed (for dropdown badge)
ACTIVE_WORKFLOW_CHANGED: "activeWorkflowChanged",   // Active workflow switched, full state follows

// Webview -> Extension
GET_WORKFLOWS_LIST: "getWorkflowsList",   // Request all loaded WorkflowSummary[]
SWITCH_WORKFLOW: "switchWorkflow",        // Switch active workflow: { workflowId }
DISMISS_WORKFLOW: "dismissWorkflow",      // Remove from loaded list: { workflowId }
```

**All existing messages remain unchanged** for backward compatibility. The `workflowId` field is added as optional to outgoing messages from the extension, allowing the webview to update dropdown summaries without disrupting the main workflow store.

**Key distinction**: `workflowId` in outgoing messages is used only to update `uiStore.loadedWorkflows` summaries. The main `workflowStore` state only updates on a full `SESSION_RESTORED` (switch) or the normal execution update messages (for the active workflow).

---

## Complete Constraint Removal Checklist

This section maps every single-runner constraint found in the codebase to how the plan removes it. Used as a pre-implementation verification checklist.

### Backend — FlightPathManager.ts

| Constraint                                                    | Location     | Resolution                                                                                  |
| ------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| Single `promptQueue` field                                    | ~L48         | Moved into `WorkflowInstance`; orchestrator holds `Map<id, WorkflowInstance>`               |
| Single `currentPromptFile` field                              | ~L60         | Moved into `WorkflowInstance`                                                               |
| Single `activeIntegration` field                              | ~L61         | Moved into `WorkflowInstance`; each instance owns its integration                           |
| `startPending: boolean` race guard                            | ~L64         | Removed — becomes a per-instance guard inside `WorkflowInstance.execute()`                  |
| `loadPromptFile()` calls `clearQueue()` (destructive replace) | ~L307        | `WorkflowOrchestrator.createWorkflow()` adds to registry without clearing existing          |
| `startWorkflowExecution()` sets global `startPending`         | ~L878        | Per-instance flag; no global gate                                                           |
| `pause()`, `resume()`, `stop()` call queue/executor directly  | ~L959-1057   | Delegate to `WorkflowInstance` by ID; active workflow is default                            |
| `clearWorkflow()` resets entire global state                  | ~L1088       | `dismissWorkflow(id)` removes specific instance; other instances unaffected                 |
| Pre-created shared harness integration instances              | ~L49-52      | `IntegrationFactory.createForHarness()` called per-instance on `execute()`                  |
| `triggerAutoLoad()` restores single last session              | (initialize) | `WorkflowOrchestrator.restoreState()` restores all persisted instances, all forced `PAUSED` |

### Backend — WorkflowExecutor.ts

| Constraint                                                                        | Location    | Resolution                                                                                       |
| --------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| Single `pendingResponseResolver` / `pendingResponseText` / `isWaitingForResponse` | ~L76-88     | One `WorkflowExecutor` per `WorkflowInstance`; fields scoped to that instance                    |
| Single `stepStatusMessages` accumulator                                           | ~L89        | Per-instance; cleared when instance is dismissed                                                 |
| Constructor takes single `PromptQueue` (one-to-one relationship)                  | constructor | Unchanged — executor is constructed inside `WorkflowInstance`, paired with that instance's queue |

### Backend — PromptQueue.ts

| Constraint                                       | Location | Resolution                                                                                  |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------- |
| Single `state` object (one workflow state total) | ~L83     | One `PromptQueue` per `WorkflowInstance` — no change to queue structure itself              |
| `clearQueue()` resets all state                  | ~L134    | Only called when the owning `WorkflowInstance` is dismissed; doesn't affect other instances |
| `loadPrompts()` replaces entire state            | ~L161    | Same — scoped to the instance's queue                                                       |
| Single `workingFilePath` in state                | ~L178    | Per-instance; filenames include workflow ID to guarantee uniqueness                         |

### Backend — FlightPathWebviewProvider.ts

| Constraint                                     | Location                  | Resolution                                                                                                                                                        |
| ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single `currentWorkflowName` field             | ~L63                      | Removed; `activeWorkflowId` maintained by orchestrator, name derived from active instance                                                                         |
| Single `pendingWorkflowProperties` set         | ~L92-100                  | Moved into `WorkflowInstance`; pending props scoped to each instance                                                                                              |
| `handleClearWorkflow()` clears single workflow | ~L1087                    | Routes to `orchestrator.dismissWorkflow(activeId)`                                                                                                                |
| `sendInit()` sends one workflow's state        | (sendInit)                | On switch: `sendWorkflowStateSync(workflowId)` sends full state for switched-to instance                                                                          |
| No `workflowId` on any outgoing message        | all `sendMessage()` calls | Active-workflow messages don't need workflowId (webview displays what's active). Summary updates use `WORKFLOW_SUMMARY_UPDATED` with id for dropdown-only updates |
| History tracking scoped to single workflow     | OutputHistoryManager refs | `OutputHistoryManager` instantiated per `WorkflowInstance`; history files namespaced by workflow ID                                                               |

### Backend — extension.ts (Command Registration)

| Constraint                                                                  | Location  | Resolution                                                                             |
| --------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `flightpath.takeOff` routes to single manager                               | ~L252     | Routes to `orchestrator.executeWorkflow()` (defaults to active workflow)               |
| `flightpath.pause/resume/stop` route to single manager                      | ~L276-295 | Routes to `orchestrator.pauseWorkflow()` / etc. (defaults to active workflow)          |
| `flightpath.runFromContext` calls `executePromptFile()` (replaces workflow) | ~L454     | Calls `orchestrator.createWorkflow(filePath)` then `executeWorkflow()` on new instance |
| `flightpath.loadFromContext` calls `loadPromptFile()` (replaces workflow)   | ~L475     | Calls `orchestrator.createWorkflow(filePath)` — adds to registry, switches active view |

### Frontend — Message Protocol (useMessageHandler.ts + DashboardConstants.ts)

| Constraint                                                                              | Location     | Resolution                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALL message handlers write directly to global `workflowStore` — no `workflowId` routing | all handlers | Strategy: **webview displays active workflow**. Active-workflow messages replace store contents as before. Inactive workflows' messages are handled by the backend buffering approach (not sent to webview until user switches). No per-message workflowId routing needed in the webview. |
| `FILE_SELECTED` handler calls `workflowStore.loadWorkflow()` (destructive)              | ~L136        | Replaced by `SESSION_RESTORED` / `ACTIVE_WORKFLOW_CHANGED` messages that do the same full-state replace                                                                                                                                                                                   |
| `SESSION_RESTORED` replaces entire store                                                | ~L161        | Behavior preserved — this is now also the switch mechanism                                                                                                                                                                                                                                |
| `PROMPTS_EXTENDED` mutates single prompt list                                           | ~L182        | Active-workflow-only message; behavior unchanged                                                                                                                                                                                                                                          |
| `EXECUTION_STATE_CHANGED` targets single store                                          | ~L285        | Active-workflow-only; behavior unchanged                                                                                                                                                                                                                                                  |
| `PROGRESS_UPDATE` targets single store                                                  | ~L293        | Active-workflow-only; behavior unchanged                                                                                                                                                                                                                                                  |

**Key design decision**: The webview always shows ONE workflow (the active one). Messages from background running workflows are held by the backend and only flushed when the user switches to that workflow. This means **no workflowId routing is needed in the webview message handlers**. This is the simplest approach and avoids restructuring the entire store.

### Frontend — Zustand Stores

| Constraint                                            | Location         | Resolution                                                                                                   |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `workflowStore` holds single workflow state           | workflowStore.ts | Structure unchanged. `loadWorkflow()` is the switch mechanism. Background workflows don't update this store. |
| `workflowStore.resetWorkflow()` clears everything     | workflowStore.ts | Used only when the active workflow is dismissed.                                                             |
| `uiStore` has no concept of multiple loaded workflows | uiStore.ts       | Add `loadedWorkflows: WorkflowSummary[]` and `activeWorkflowId` fields                                       |

### Frontend — UI Component Restrictions

| Component              | Constraint                                                                            | Resolution                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `WorkflowControls.tsx` | `isExecuting` guard on all handlers + `disabled={isExecuting}` on all buttons         | Remove all `isExecuting` guards and `disabled` props. Buttons always active.                                         |
| `WorkflowStatus.tsx`   | `if (isRunning) return` in `toggleDropdown`; `disabled={isRunning}` on chevron button | Remove both. Dropdown always openable.                                                                               |
| `Header.tsx`           | `canRun` / `canPause` / `canStop` logic all correct                                   | **No change needed** — these already scope to the active workflow's own state                                        |
| `EditorSection.tsx`    | "New Prompt" button `disabled={isRunning}`                                            | Remove — editing prompts in the active workflow while it's running (to add to the queue) should be allowed           |
| `EditorFooter.tsx`     | All editor action buttons `disabled={isRunning}`                                      | Review per-button: "Send" (add prompt) should work while running; "Save" should always work. Remove blanket disable. |
| `PromptsPanel.tsx`     | No blocking, reads from single store                                                  | No change needed — reads from active workflow store correctly                                                        |
| `OutputSection.tsx`    | No blocking, reads from single store                                                  | No change needed                                                                                                     |

### Persistence / Session Management

| Constraint                                                | Location                               | Resolution                                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single working file path per queue                        | PromptQueue.ts `state.workingFilePath` | Filenames include workflow instance ID (UUID segment) to prevent collision                                                                              |
| `OutputHistoryManager` tracks history for single workflow | (OutputHistoryManager)                 | Instantiated per `WorkflowInstance`; history directory namespaced by workflow (e.g. `.flightpath/.history/{workflowName}-{id}/`)                        |
| `WorkspaceSessionManager` restores single session         | (WorkspaceSessionManager)              | Instantiated per `WorkflowInstance`; session keys namespaced by workflow ID                                                                             |
| Auto-load loads single last session on extension start    | FlightPathManager.initialize()         | `WorkflowOrchestrator.restoreState()` reads persisted `WorkflowSummary[]` from `context.workspaceState`, creates instances for all, all forced `PAUSED` |

---

## Migration Strategy

### Phase 1: Backend — WorkflowInstance Extraction

**Goal**: Extract `WorkflowInstance` from `FlightPathManager` with zero behavior change. The orchestrator manages exactly one instance. No UI changes.

**Steps**:

1. Create `WorkflowInstance` class — move all per-workflow state and methods from `FlightPathManager`
2. Create `WorkflowOrchestrator` with `Map<string, WorkflowInstance>` but initially always contains ≤ 1 instance
3. Create `IntegrationFactory` — extract harness creation from `FlightPathManager`
4. Refactor `FlightPathManager` to delegate all execution to `WorkflowOrchestrator`
5. All tests pass, behavior identical

**Validation**: Full regression test — single workflow load/run/pause/resume/stop/complete unchanged.

### Phase 2: Backend — Multi-Instance Registry

**Goal**: Allow `WorkflowOrchestrator` to hold multiple `WorkflowInstance` objects and execute them concurrently. Backend fully supports parallel execution; UI not yet updated.

**Steps**:

1. `createWorkflow()` no longer replaces existing instance — adds to registry
2. Add `activeWorkflowId` tracking — all dashboard messages route from active instance
3. Implement `setActiveWorkflow()` with full state sync to dashboard
4. Implement background buffering in `WorkflowInstance` when not active
5. Add `dismissWorkflow()` with cleanup (working file, process, file watcher)
6. Add `saveState()` / `restoreState()` for persistence across VS Code restart
7. Each `WorkflowInstance` can call `execute()` independently — no coordination needed between instances

**Validation**: Load two workflow files, run both simultaneously, verify both progress independently with isolated working files.

### Phase 3: Message Protocol Updates

**Goal**: Add new message types for multi-workflow coordination. No UI changes yet.

**Steps**:

1. Add new `MESSAGE_TYPES` constants to `DashboardConstants.ts`
2. Add `workflowId` to outgoing messages from active instance
3. Implement `WORKFLOWS_LIST` / `WORKFLOW_ADDED` / `WORKFLOW_DISMISSED` dispatch from orchestrator
4. Implement `SWITCH_WORKFLOW` / `DISMISS_WORKFLOW` handlers in `FlightPathWebviewProvider`
5. Add `GET_WORKFLOWS_LIST` handler

**Validation**: New message types flow correctly; webview ignores unknown messages gracefully.

### Phase 4: Frontend — Dropdown Selector

**Goal**: Extend `WorkflowStatus` dropdown to show loaded workflows and enable switching.

**Steps**:

1. Add `loadedWorkflows`, `activeWorkflowId` to `uiStore`
2. Handle `WORKFLOWS_LIST`, `WORKFLOW_ADDED`, `WORKFLOW_DISMISSED`, `WORKFLOW_SUMMARY_UPDATED` in message handler — update `uiStore`
3. Handle `SESSION_RESTORED` / `ACTIVE_WORKFLOW_CHANGED` — replace `workflowStore` state
4. Rename/extend `RecentWorkflows.tsx` → `WorkflowSelector.tsx` with two sections
5. Create `WorkflowSelectorItem` component (with dismiss button)
6. Update `WorkflowStatus.tsx`:
   - Remove `if (isRunning) return` from `toggleDropdown` — always openable
   - Request `GET_WORKFLOWS_LIST` on dropdown open
   - Render `WorkflowSelector` in dropdown
7. Update `WorkflowControls.tsx` — **remove all `disabled={isExecuting}` guards** (parallel is the goal)
8. Update `Header.tsx` run/pause/stop — scoped to active workflow's own state only

**Validation**: Load two workflows, switch between them, verify output is preserved.

### Phase 5: Polish & Edge Cases

**Goal**: Handle all edge cases and improve UX.

**Steps**:

1. Workflow persistence (restore loaded workflows on VS Code reload)
2. Dismiss confirmation when paused mid-run: "Workflow is paused. Dismiss anyway?"
3. Running workflow badge on dropdown trigger (small pulsing indicator when background workflow runs)
4. Auto-dismiss completed workflows (opt-in setting, default: false)
5. Working file cleanup on dismiss (move to history or delete based on setting)
6. Handle `LOAD_WORKFLOW` when max instances reached (configurable, default: 20)

---

## UI/UX Design

### Header Layout (Unchanged Structure)

```
┌────────────────────────────────────────────────────────────────────┐
│  [New ▾]  │  [Workflow Name ● RUNNING  ▾]  │  [▶] [⏸] [⏹]       │
└────────────────────────────────────────────────────────────────────┘
```

- **`WorkflowControls` (left)**: Unchanged — "New" button disabled when any workflow executing
- **`WorkflowStatus` (center)**: Dropdown now shows active workflows, always openable
- **Run/Pause/Stop (right)**: Context-aware to active workflow; Run disabled if another is running

### WorkflowStatus Dropdown (Extended)

```
┌─────────────────────────────────────┐
│ LOADED WORKFLOWS                    │
│ ──────────────────────────────────  │
│ [●] Feature Work       3/5  [×]     │  ← running (● = pulsing)
│ [●] Code Review        1/4  [×]     │  ← also running in parallel
│ [⏸] Bug Fix            2/3  [×]     │  ← paused
│ [✓] Docs Update        5/5  [×]     │  ← completed
│ ──────────────────────────────────  │
│ LOAD ANOTHER                        │
│ ──────────────────────────────────  │
│  Old Workflow 1         idle        │  ← always enabled (parallel!)
│  Old Workflow 2         completed   │
│ ──────────────────────────────────  │
│  [Clear History]                    │
└─────────────────────────────────────┘
```

**Interaction rules**:

- Click any "Loaded Workflow" row → switch view (always enabled)
- Click [×] on a workflow → dismiss (confirm if running or paused)
- Click "Load Another" row → loads file as new instance (always enabled)
- Dropdown trigger always opens

### Status Badge on Dropdown Trigger

When a background workflow is running (not the viewed one), a small pulsing badge appears on the dropdown arrow:

```
[My Current Workflow (PAUSED) ●▾]
                              ^^ badge = another workflow is running
```

This gives the user peripheral awareness without cluttering the header.

### Running Workflow Scope

Controls in the header apply exclusively to the **active/viewed** workflow. Other workflows running in background have no bearing on button state:

| Active Workflow State | Run Button                 | Pause Button     | Stop Button                 |
| --------------------- | -------------------------- | ---------------- | --------------------------- |
| IDLE (no file)        | Disabled (no file loaded)  | Disabled         | Disabled                    |
| IDLE (file loaded)    | Enabled — starts execution | Disabled         | Disabled                    |
| RUNNING               | Disabled (already running) | Enabled          | Enabled                     |
| PAUSED                | Enabled (Restart)          | Enabled (Resume) | Enabled                     |
| STOPPED               | Enabled (Restart)          | Enabled (Resume) | Disabled                    |
| COMPLETED             | Enabled (Restart)          | Disabled         | Disabled                    |
| CANCELLING            | Disabled                   | Disabled         | Enabled (re-press to check) |

Note that **other workflows running in parallel do not affect these buttons**. If the viewed workflow is IDLE and another is RUNNING, the Run button is still enabled for the viewed one.

---

## Edge Cases & Solutions

### 1. Switching While Running

**Problem**: User switches to another workflow while one is running. Dashboard updates for the running workflow continue arriving.

**Solution**:

- `WorkflowInstance.setActive(false)` → instance buffers subsequent events in memory
- Running workflow's working file still updates on disk (no change to persistence)
- When user switches back: `setActive(true)` flushes buffer, sends `SESSION_RESTORED` for full sync
- Buffer capped at last N events per step (e.g., last 1000 streaming chunks) to prevent memory growth

### 2. Dismiss While Paused

**Problem**: User dismisses a workflow that's paused mid-execution.

**Solution**:

- Show confirmation: "Workflow is paused at step 2/5. Dismiss? Progress will be lost."
- If confirmed: call `workflow.stop()` then `orchestrator.dismissWorkflow(id)`
- Working file preserved in `.flightpath/.queue/` for manual recovery
- If the working file setting is "keep history," move to `.flightpath/.history/`

### 3. Loading Duplicate File

**Problem**: User loads the same `.flightpath.yaml` twice.

**Solution**:

- `WorkflowOrchestrator.createWorkflow(filePath)` checks for existing instance with same `filePath`
- If found and **idle**: switch to that instance, show toast "Switched to existing workflow"
- If found and **running/paused**: offer choice — "This workflow is already loaded and running. Switch to it, or create a new instance from the same file?" (new instance gets a copy of the file path)
- Default: switch to existing (avoids accidental duplicates)

### 4. VS Code Restart / Reload

**Problem**: All loaded workflow instances are lost on extension reload.

**Solution**:

- `WorkflowOrchestrator.saveState()` called on relevant lifecycle events (pausing, stopping, switching)
- Persists `WorkflowSummary[]` to `context.workspaceState`
- On activation: `restoreState()` creates `WorkflowInstance` for each persisted summary, restores from working file
- All restored instances are forced to `PAUSED` state (no auto-resume)
- Notification: "Restored 3 workflows from previous session"

### 5. Max Loaded Workflows

**Problem**: User accumulates many loaded workflows (memory growth).

**Solution**:

- Setting: `flightpath.maxLoadedWorkflows` (default: 20, range: 1–50)
- On create: if at limit, offer to dismiss oldest completed workflow automatically
- If all are non-completed and at limit, show error with list of workflows to dismiss

### 6. Chat Integration

**Problem**: `CopilotChatIntegration` drives a single VS Code Chat window — two Chat-harness workflows would both try to send messages to the same Chat UI, causing conflicts.

**Solution**: Warn but don't block. CLI harnesses (copilot-cli, claude-cli, codex-cli) run in independent terminals — fully parallel with no conflict. Chat is the edge case:

```typescript
// In WorkflowOrchestrator.executeWorkflow()
if (usesChat && chatAlreadyRunning) {
  const choice = await vscode.window.showWarningMessage(
    "A Chat workflow is already running. Starting another Chat workflow may cause conflicts.",
    "Start Anyway",
    "Cancel"
  );
  if (choice !== "Start Anyway") return;
}
```

**Recommendation**: Users mixing Chat + CLI workflows is fine (CLI runs independently). Two Chat workflows simultaneously is unsupported but not hard-blocked. The typical parallel use case is all CLI harnesses.

### 7. Editor Buttons While Another Workflow Runs

**Problem**: `EditorSection` and `EditorFooter` use `disabled={isRunning}` to block editing. With parallel workflows, "the running workflow" is no longer a global concept.

**Solution**: Change the disable logic from "any running workflow" to "this step is currently executing":

- "Send" button (add prompt to queue): Always enabled — user can queue prompts for a running workflow
- "Save" (update existing prompt): Disabled only if that specific prompt's status is `SENT` or `RUNNING`
- "Cancel Edit": Always enabled
- "Delete": Disabled only if the prompt is currently `SENT` or `RUNNING`

This removes the blanket `isRunning` guard in favor of per-prompt status checks.

### 8. Background Workflow Output (Memory)

**Problem**: Background running workflow accumulates buffered events. User never switches back. Memory grows.

**Solution**:

- Buffer cap: keep last 500 streaming chunks + all CLI output events per step
- For completed steps: keep full output (low size), streaming chunks cleared
- Dashboard can request a full reload from working file at any time (disk-based fallback)

---

## New Settings

```json
{
  "flightpath.maxLoadedWorkflows": {
    "type": "number",
    "default": 20,
    "minimum": 1,
    "maximum": 50,
    "description": "Maximum number of workflow instances that can be loaded simultaneously"
  },
  "flightpath.autoSwitchToNewWorkflow": {
    "type": "boolean",
    "default": true,
    "description": "Automatically switch the active view to newly loaded workflows"
  },
  "flightpath.autoDismissCompleted": {
    "type": "boolean",
    "default": false,
    "description": "Automatically dismiss workflow instances when execution completes"
  },
  "flightpath.keepDismissedWorkflows": {
    "type": "boolean",
    "default": true,
    "description": "Move working files to .flightpath/.history/ when workflow is dismissed (instead of deleting)"
  }
}
```

---

## Command Updates

### Context-Aware Commands (Apply to Active Workflow)

| Command                    | Current Behavior  | New Behavior                           |
| -------------------------- | ----------------- | -------------------------------------- |
| `flightpath.takeOff`       | Runs current file | Runs active workflow (if none running) |
| `flightpath.pause`         | Pauses execution  | Pauses active workflow                 |
| `flightpath.resume`        | Resumes execution | Resumes active workflow                |
| `flightpath.stop`          | Stops execution   | Stops active workflow                  |
| `flightpath.clearWorkflow` | Clears workflow   | Clears/dismisses active workflow       |

### New Commands

| Command                          | Description                          |
| -------------------------------- | ------------------------------------ |
| `flightpath.switchWorkflow`      | Show workflow selector quick-pick    |
| `flightpath.dismissWorkflow`     | Dismiss active workflow instance     |
| `flightpath.dismissAllWorkflows` | Dismiss all completed/idle workflows |

**Workflow Switcher Quick-Pick** (for command palette):

```
> FlightPath: Switch Workflow
  [●] Feature Work (3/5) — Running
  [⏸] Bug Fix (2/3) — Paused
  [✓] Docs Update (5/5) — Completed
  [ ] New Workflow (empty) — Idle

  → Press Enter to switch view
  → Press Delete to dismiss
```

---

## Testing Strategy

### Unit Tests

1. `WorkflowOrchestrator.test.ts`
   - `createWorkflow()` — creates instance, adds to registry without clearing existing
   - `executeWorkflow()` — runs specified instance; both A and B can run simultaneously
   - `setActiveWorkflow()` — updates `activeWorkflowId`, triggers state sync
   - `dismissWorkflow()` — removes from registry, cleans up; other instances unaffected
   - Duplicate file detection (offers switch or new instance)
   - `getRunningWorkflows()` — returns all instances with status RUNNING (can be > 1)
   - Chat conflict warning — two Chat-harness workflows: warns but proceeds

2. `WorkflowInstance.test.ts`
   - Lifecycle: load → execute → pause → resume → stop
   - `setActive(false)` → events buffered
   - `setActive(true)` → buffer flushed
   - `getSummary()` returns current state
   - `execute()` while another instance is also executing — both proceed independently

### Integration Tests

1. **Multi-workflow switching**: Load 3 workflows, switch between them, verify state isolated
2. **Parallel execution**: Run A and B simultaneously, verify both progress, independent working files, independent terminals
3. **Background buffering**: Start workflow A, switch to B, verify A's output buffered correctly, switch back and verify flush
4. **Session restoration**: Load 3 workflows (2 running), reload extension, verify all 3 restored (running ones forced to paused)
5. **Working file isolation**: 3 workflows → 3 separate working files, no cross-contamination
6. **Load while running**: Load new workflow while A is running; A continues, new workflow added to registry

### Manual Testing Checklist

- [ ] Load two workflows, run both simultaneously — each progresses independently in its own terminal
- [ ] Switch between running workflows via dropdown — both show live progress
- [ ] Switch to a background running workflow, see buffered output on switch-back
- [ ] Click "New" while a workflow is running — creates new instance, running one continues uninterrupted
- [ ] Load from File while a workflow is running — loads successfully, running one continues
- [ ] Dismiss a running workflow — confirmation shown, process killed, workflow cleaned up
- [ ] Dismiss a completed workflow — dropdown updates
- [ ] Load same file twice — offers switch vs new instance
- [ ] Reload VS Code with 3 loaded workflows — all restored
- [ ] Multiple pulsing status badges in dropdown when 2+ workflows running

---

## What Does NOT Change

To be explicit about scope boundaries:

- **Execution semantics** — `PromptQueue`, `WorkflowExecutor`, `EndConditionHandler`, all harness integrations: **untouched**
- **Working file format** — `.flightpath/.queue/` structure: **untouched**
- **File formats** — `.flightpath.yaml`, `.flightpath.json`, `.prompt.md`: **untouched**
- **Settings** — all existing settings: **untouched** (new settings added alongside)
- **Single-workflow UX** — if user never loads a second workflow, experience is identical
- **Header layout** — `[New ▾] | [WorkflowStatus ▾] | [Run/Pause/Stop]`: **untouched**
- **Panel layout** — resizable Prompts / Output / Editor / Settings: **untouched**
- **Tab-based UI** — explicitly **not implemented** (dropdown is the chosen pattern, not tabs)

---

## Success Criteria

- [ ] Can load 3+ workflows, each with independent state (prompts, outputs, step progress)
- [ ] Multiple workflows can run **simultaneously** in parallel (each in its own terminal)
- [ ] Switching between workflows via dropdown is instant (< 100ms UI response)
- [ ] Background running workflow continues executing while user views another
- [ ] `WorkflowControls` buttons (New, Load, Queue) work while other workflows are running
- [ ] Run/Pause/Stop apply to the currently viewed workflow only
- [ ] Working files properly isolated (no cross-workflow state)
- [ ] Session restoration works after VS Code reload
- [ ] No regressions in single-workflow UX

---

**End of Document**
