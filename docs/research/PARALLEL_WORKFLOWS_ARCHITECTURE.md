# Multi-Workflow Architecture

**Document Status**: Implemented  
**Last Updated**: 2026-02-26  
**Author**: Claude Code Planning Agent

---

## Implementation Summary

This document describes the **implemented** multi-workflow architecture in FlightPath. The original planning document (the old contents of this file) described the full intended design; this version reflects what was actually built after simplification.

**What was built**:

- `WorkflowOrchestrator` manages a `Map<string, WorkflowInstance>` — holds **RUNNING and PAUSED** instances only. Idle instances are never stored in the Map.
- `viewedInstance` is a separate field from the Map — it holds what the dashboard is currently showing and may or may not be in the Map.
- Auto-retire: completed/errored/stopped instances are removed from the Map automatically after a 500ms delay. No "dismiss" concept.
- `createWorkflow()` always switches the view to the new instance.
- `saveState()` / `restoreState()` are intentional no-ops — live running processes cannot survive a VS Code restart.
- Zero new extension settings, zero new commands.

---

## Memory Model

```
workflows: Map<string, WorkflowInstance>
  → Contains RUNNING and PAUSED instances only
  → Completed / errored / stopped instances are auto-retired after 500ms
  → Idle instances are never placed in the Map

viewedInstance: WorkflowInstance | null
  → What the dashboard is currently showing
  → May or may not be in the Map
  → Always set when the user has a workflow loaded
```

### Why Separate viewedInstance

The Map is the **execution registry** — it tracks what is actively running or paused. The viewedInstance is the **UI context** — what the user is looking at right now. These are deliberately decoupled because:

- A COMPLETED instance should leave the execution registry immediately (no resource leak)
- But the user is still looking at the completed workflow's output — `viewedInstance` stays set
- A RUNNING workflow in the background is in the Map but is NOT the `viewedInstance`

---

## Lifecycle Table

| State      | In Map? | viewedInstance? | Notes                                         |
| ---------- | ------- | --------------- | --------------------------------------------- |
| IDLE       | No      | Yes (if loaded) | Loaded but not yet run                        |
| RUNNING    | Yes     | Maybe           | Executing; may be background (not viewed)     |
| PAUSED     | Yes     | Maybe           | Paused; may be background (not viewed)        |
| COMPLETED  | No      | Maybe           | Auto-retired 500ms after completion           |
| ERROR      | No      | Maybe           | Auto-retired 500ms after error                |
| STOPPED    | No      | Maybe           | Auto-retired 500ms after stop                 |
| CANCELLING | Yes     | Maybe           | Transitional; removed on completion of cancel |

---

## WorkflowOrchestrator API

**File**: `src/flightpath/WorkflowOrchestrator.ts`

```typescript
class WorkflowOrchestrator {
  // Map holds RUNNING/PAUSED only
  private workflows: Map<string, WorkflowInstance>;
  // What the dashboard is currently showing (may differ from any Map entry)
  private viewedInstance: WorkflowInstance | null;

  // Workflow creation — creates a new instance, always switches view to it
  createWorkflow(filePath: string): Promise<WorkflowInstance>

  // Returns only RUNNING/PAUSED instances (Map contents)
  getWorkflowSummaries(): WorkflowSummary[]

  // Execution — adds instance to Map; removes on completion (auto-retire)
  executeWorkflow(workflowId?: string, modeOverride?: Provider): Promise<void>

  // View switching — changes viewedInstance, sends full state sync to dashboard
  setActiveWorkflow(workflowId: string): void

  // Delegation — apply to viewedInstance by default
  pauseWorkflow(workflowId?: string): void
  resumeWorkflow(workflowId?: string): Promise<void>
  stopWorkflow(workflowId?: string): Promise<void>
  clearWorkflow(workflowId?: string): void

  // No-ops (live processes cannot survive restart)
  saveState(): Promise<void>   // intentional no-op
  restoreState(): Promise<void> // intentional no-op
}
```

**retireWorkflow()** is private. Called automatically 500ms after a workflow reaches COMPLETED, ERROR, or STOPPED. Removes from Map, broadcasts updated `WORKFLOWS_LIST`.

---

## WorkflowInstance

**File**: `src/flightpath/WorkflowInstance.ts`

```typescript
class WorkflowInstance extends EventEmitter {
  // Identity
  readonly id: string;           // UUID
  workflowName: string;
  filePath: string;
  startedAt?: number;            // Set when execute() is first called

  // Whether this is the currently viewed workflow (controls buffering)
  isActive: boolean;

  // Background output buffering (cap: 500 events)
  private bufferedEvents: BufferedWorkflowEvent[];

  // Per-instance components (one each, fully isolated)
  private promptQueue: PromptQueue;
  private workflowExecutor: WorkflowExecutor;
  private activeIntegration?: HarnessIntegration;
  private endConditionHandler: EndConditionHandler;
  private workspaceSessionManager: WorkspaceSessionManager;
  private outputHistoryManager: OutputHistoryManager;
  private promptFileWatcher?: PromptFileWatcher;

  // Lifecycle
  async loadPromptFile(filePath: string): Promise<void>
  async execute(modeOverride?: Provider): Promise<void>
  pause(): void
  async resume(): Promise<void>
  async stop(): Promise<void>
  clear(): void

  // For dropdown display
  getSummary(): WorkflowSummary

  // Called by orchestrator on view switch — flushes buffered events to dashboard
  sendFullStateToDashboard(): void
}
```

---

## IntegrationFactory

**File**: `src/flightpath/IntegrationFactory.ts`

Creates `HarnessIntegration` instances on demand. Each `WorkflowInstance` gets its own integration when `execute()` is called. No shared integration state between instances.

```typescript
class IntegrationFactory {
  createForHarness(harness: Harness, context: vscode.ExtensionContext): HarnessIntegration
}
```

---

## FlightPathManager

**File**: `src/flightpath/FlightPathManager.ts`

Pure delegation shell (~280 lines). Public API is identical to the original monolithic manager. All logic lives in `WorkflowOrchestrator` and `WorkflowInstance`.

```typescript
class FlightPathManager {
  private orchestrator: WorkflowOrchestrator;

  // All methods delegate to orchestrator
  async loadPromptFile(filePath: string): Promise<void>
  async executeLoadedPromptFile(modeOverride?: Provider): Promise<void>
  pause(): void
  async resume(): Promise<void>
  async stop(): Promise<void>
  clear(): void
  // ... all other original public methods
}
```

---

## UI Changes

### WorkflowStatus Dropdown — "Running Workflows" Section

When `loadedWorkflows.length > 0` (i.e., there are RUNNING or PAUSED workflows), a **"Running Workflows"** section is prepended to the dropdown above the existing "Recent Workflows" section.

```
┌─────────────────────────────────────────┐
│ RUNNING WORKFLOWS                       │
│ ────────────────────────────────────    │
│ [●] Feature Work      01:32  (3/5)      │  ← RUNNING, live timer
│ [⏸] Bug Fix           00:45  (2/3)      │  ← PAUSED, frozen timestamp
│ ────────────────────────────────────    │
│ RECENT WORKFLOWS                        │
│  Old Workflow 1                         │
│  Old Workflow 2                         │
└─────────────────────────────────────────┘
```

No "dismiss" button. Workflows auto-retire when they complete. There is no concept of manually removing a workflow from the list.

### RunningWorkflowItem Component

**File**: `src/ui/webview-react/components/workflow/RunningWorkflowItem.tsx`

- Live mm:ss elapsed timer that ticks every second while status is RUNNING
- Timer freezes (shows last value) when status is PAUSED
- Pulsing green dot for RUNNING, pause icon for PAUSED

### Pulsing Indicator on Dropdown Trigger

When a background workflow is RUNNING (i.e., in the Map but `id !== activeWorkflowId`), a small pulsing dot appears on the `WorkflowStatus` dropdown trigger to signal background activity.

### WorkflowControls (Restrictions Removed)

All `disabled={isExecuting}` guards removed. New, Load, and Queue File buttons are always enabled — creating or loading a workflow while another runs is a core use case.

---

## Message Protocol

**New constants in `src/types/DashboardConstants.ts`**:

```typescript
// Extension → Webview
WORKFLOWS_LIST: "workflowsList",                    // Full WorkflowSummary[] for dropdown
WORKFLOW_ADDED: "workflowAdded",                    // New workflow created
WORKFLOW_DISMISSED: "workflowDismissed",            // Workflow auto-retired (removed)
WORKFLOW_SUMMARY_UPDATED: "workflowSummaryUpdated", // Status/progress changed
ACTIVE_WORKFLOW_CHANGED: "activeWorkflowChanged",   // View switched, full state follows

// Webview → Extension
GET_WORKFLOWS_LIST: "getWorkflowsList",             // Request current WorkflowSummary[]
SWITCH_WORKFLOW: "switchWorkflow",                  // Switch active: { workflowId }
```

All existing messages unchanged. No `workflowId` routing in the webview — messages always target the active/viewed workflow. Background instances buffer output internally until the user switches to them.

---

## WorkflowSummary Type

```typescript
interface WorkflowSummary {
  id: string;
  workflowName: string;
  filePath: string;
  executionState: ExecutionState;
  currentStep: number;
  totalSteps: number;
  startedAt?: number;    // Unix ms — used for elapsed time display
}
```

---

## What Did NOT Change

- **Execution semantics** — `PromptQueue`, `WorkflowExecutor`, `EndConditionHandler`, all harness integrations: untouched
- **Working file format** — `.flightpath/.queue/` structure: untouched
- **File formats** — `.flightpath.yaml`, `.flightpath.json`, `.prompt.md`: untouched
- **Extension settings** — no settings added or removed
- **Commands** — no commands added or removed
- **Single-workflow UX** — if user never loads a second workflow, experience is identical
- **Header layout** — `[New ▾] | [WorkflowStatus ▾] | [Run/Pause/Stop]`: untouched
- **Panel layout** — resizable Prompts / Output / Editor / Settings: untouched

---

## Rejected Decisions (Post-Implementation Simplifications)

| Original Plan                              | Rejected Because                                             |
| ------------------------------------------ | ------------------------------------------------------------ |
| `maxLoadedWorkflows` setting (default 20)  | Unnecessary complexity — no good reason to cap workflow count|
| `autoSwitchToNewWorkflow` setting          | Should always switch — opinionated behavior, no opt-out      |
| `autoDismissCompleted` setting             | Always auto-retire — another opinionated simplification      |
| `keepDismissedWorkflows` setting           | Tied to dismiss concept which was removed                    |
| `flightpath.switchWorkflow` command        | Accessible via dropdown; no command needed                   |
| `flightpath.dismissWorkflow` command       | No dismiss concept — auto-retire only                        |
| `flightpath.dismissAllWorkflows` command   | No dismiss concept — auto-retire only                        |
| `WorkflowSelectorItem` component           | Deleted; replaced by `RunningWorkflowItem` (no dismiss btn)  |
| "Loaded Workflows" dropdown section name   | Renamed to "Running Workflows" (more accurate)               |
| Explicit `DISMISS_WORKFLOW` message type   | Removed with the dismiss concept                             |
| `saveState()` / `restoreState()` (active)  | No-ops — live processes cannot survive reload                |

---

## Test Coverage

- **Build**: `npm run compile` → exit 0
- **Tests**: `npm test` → 495 passing, 0 failing
- All existing tests passed without modification (no regressions)
- No new test files required — multi-workflow behavior is tested via existing orchestration paths
