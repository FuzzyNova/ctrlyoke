# Multi-Client Active Workflow Plan

## Problem Statement

`WorkflowOrchestrator` has a single "viewed slot" — `viewedInstance: WorkflowInstance | null`.
All live-update broadcasting is gated on `WorkflowInstance.isActive`, which is true for only one
instance at a time. When `setActiveWorkflow(id)` is called it broadcasts `ACTIVE_WORKFLOW_CHANGED`
and `SESSION_RESTORED` to **every** connected client (VS Code sidebar + all browser tabs).

This means:

- Switching the active workflow in any one client changes every other client's view.
- `LOAD_WORKFLOW` from a browser tab changes what VS Code is displaying.
- There is no way for two clients to simultaneously view different workflows.

The broadcast hub (`DashboardBroadcastHub`) and per-client replay (`replayWorkflowStateTo`) from
Phase 1 of the standalone-server work already laid the correct foundation. This plan completes the
architecture so each client owns its own active-workflow view independently.

---

## Partial Fix Already Applied (pre-Phase 1)

The following narrower fixes are already in `main` and unblock the most common cases:

| Fix                             | File                        | What it does                                                                                                                                         |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifyRunHistoryUpdated` added | `FlightPathHostedServer.ts` | Run history now reaches browser clients via broadcast hub                                                                                            |
| READY handler split             | `WebviewMessageRouter.ts`   | Browser READY uses `replayWorkflowStateTo` instead of `setDashboardReady()` — VS Code no longer gets a redundant broadcast on every browser tab open |
| LOAD_WORKFLOW per-client path   | `WebviewMessageRouter.ts`   | If the requested workflow is already tracked (running/paused), uses per-client replay and leaves VS Code's view untouched                            |

**Remaining gap:** workflows that are loaded but not currently running (idle/historical) still go
through the global `loadWorkingFile` path, which changes VS Code's view.

---

## Architecture After Full Fix

```
WorkflowOrchestrator
  ├── instances: Map<id, WorkflowInstance>   ← ALL loaded instances (any state)
  ├── vsCodeViewedId: string | null          ← what the VS Code sidebar is showing
  └── DashboardBroadcastHub
        ├── FlightPathWebviewProvider  (VS Code sidebar)
        └── FlightPathHostedServer     (all browser WS clients)
              └── connections: Set<WebSocket>

Each WorkflowInstance
  └── WorkflowTaggedSink               ← wraps hub, injects workflowId into every message

React client (VS Code or browser tab)
  └── activeWorkflowId (Zustand uiStore)  ← client-owned; only changes when THIS client switches
```

**Key principle:** the server never changes a client's active workflow without that client requesting
it. `ACTIVE_WORKFLOW_CHANGED` is always sent per-client (via scoped postMessage / direct WS send),
never broadcast.

---

## Phase 1 — Unified Instance Registry

**Goal:** break the single-slot constraint so `LOAD_WORKFLOW` from any client does not change other
clients' views.

### Changes

#### `src/flightpath/WorkflowOrchestrator.ts`

1. **Rename / merge registries**
   - Rename `this.workflows: Map<string, WorkflowInstance>` → `this.instances`.
   - Remove `this.viewedInstance`. Replace with `this.vsCodeViewedId: string | null`.
   - All existing callers of `this.workflows` updated to use `this.instances`.

2. **`createWorkflow()`** — no visible change. Creates a new `WorkflowInstance`, adds to
   `this.instances`. Does **not** set `vsCodeViewedId`.

3. **`loadWorkingFile(filePath)`** — split into a shared loader + a view-switch step:

   ```
   loadWorkingFile(filePath)
     → call _loadIntoRegistry(filePath)   // parse file, add instance to this.instances
     → call setVsCodeActiveWorkflow(id)   // VS Code only: update vsCodeViewedId + send to panel
   ```

   Called from VS Code context only (WorkflowSerializer.handleLoadWorkflow without scopedPostMessage).

4. **New: `loadWorkflowForClient(filePath, send)`**

   ```
   loadWorkflowForClient(filePath, send: PostMessageFn)
     → call _loadIntoRegistry(filePath)   // parse file, add instance to this.instances (or reuse)
     → call replayWorkflowStateTo(id, send) // send to ONLY this client
   ```

   Called from browser context (`LOAD_WORKFLOW` with `scopedPostMessage` set).

5. **`setActiveWorkflow(id)`** → renamed `setVsCodeActiveWorkflow(id)`
   - Updates `this.vsCodeViewedId`.
   - Replays state to the VS Code `defaultPostMessage` only (not broadcast hub).
   - Sends `ACTIVE_WORKFLOW_CHANGED` to VS Code only.

6. **`setDashboardReady()`** — update to use `vsCodeViewedId` instead of `viewedInstance`.

7. **`getActiveInstance()`** — update to look up `vsCodeViewedId` in `this.instances`.

8. **`getWorkflowSummaries()`** — iterate `this.instances` (includes idle instances too, which is
   useful for the workflow switcher dropdown).

#### `src/ui/WebviewMessageRouter.ts`

1. **`LOAD_WORKFLOW` handler** — use `loadWorkflowForClient(filePath, scopedPostMessage)` when
   `this.scopedPostMessage` is set; otherwise call `serializer.handleLoadWorkflow(message)` as
   before.

2. **`SWITCH_WORKFLOW` handler** — no change needed (already uses `replayWorkflowStateTo` for
   browser clients).

#### `src/ui/WorkflowSerializer.ts`

- `handleLoadWorkflow` calls `orchestrator.loadWorkingFile` (VS Code path unchanged).

#### `src/ui/WebviewMessageRouter.ts` — `setDashboardReady` replacement

- After Phase 1 the `READY` handler (already fixed) is correct: browser gets
  `replayWorkflowStateTo`, VS Code gets `setDashboardReady()`.

### What this does NOT yet fix

- Live updates (step status, streaming output) for a **running** workflow are still gated on
  `WorkflowInstance.isActive`. If a browser is viewing workflow B while workflow A is running, A's
  live updates are either buffered or broadcast to everyone. Phase 2+3 address this.

---

## Phase 2 — WorkflowTaggedSink: add `workflowId` to all live-update messages

**Goal:** every message that represents a state change for a specific workflow carries that
workflow's ID, so clients can filter independently.

### Design

Introduce `WorkflowTaggedSink` — a thin proxy around `IDashboardSink` that injects `workflowId`
into every forwarded message:

```typescript
// src/flightpath/WorkflowTaggedSink.ts  (new file)
export class WorkflowTaggedSink implements IDashboardSink {
  constructor(
    private readonly inner: IDashboardSink,
    private readonly workflowId: string
  ) {}

  updateStepStatus(stepIndex, status, details) {
    this.inner.updateStepStatus(stepIndex, status, details, this.workflowId);
  }
  updateCliOutput(stepIndex, output) {
    this.inner.updateCliOutput(stepIndex, output, this.workflowId);
  }
  // ... all IDashboardSink methods forwarded with workflowId appended
}
```

Each `WorkflowInstance` holds a `WorkflowTaggedSink(hub, this.id)` as its `dashboardSink`. No
call sites inside `WorkflowInstance` need to change — they call `this.dashboardSink.updateX()`
as before; the tag is injected transparently.

### Changes

#### `src/types/IDashboardSink.ts`

Add optional `workflowId?: string` parameter to all live-update methods:

- `updateStepStatus`
- `updateRetryAttempt`
- `updateCliOutput` / `updateCliStreamingChunk` / `updateCliStreamingEvents`
- `updateStatusMessage`
- `updateExecutionStarted` / `updateExecutionState` / `updateExecutionCompleted`
- `updateProgress`
- `updateFinalStep*` (all final-step variants)
- `updateSessionRestored` / `updateFileSelected`
- `notifyWorkflowStateReset` / `notifyStartPositionSet` / `notifyPromptsReordered`
- `updateWorkflowName`
- `notifyRunHistoryUpdated`

#### `src/ui/DashboardBroadcastHub.ts`

Forward the new `workflowId` parameter to each registered client.

#### `src/ui/FlightPathWebviewProvider.ts`

Include `workflowId` in the JSON message sent to the VS Code webview where relevant.

#### `src/server/FlightPathHostedServer.ts`

Include `workflowId` in the JSON message broadcast to browser WS clients.

#### `src/ui/PostMessageDashboardSink.ts`

Include `workflowId` in forwarded messages.

#### `src/flightpath/WorkflowTaggedSink.ts` (new)

New file as described above.

#### `src/flightpath/WorkflowInstance.ts`

Replace `this.dashboardSink = hub` with `this.dashboardSink = new WorkflowTaggedSink(hub, this.id)`.

---

## Phase 3 — Remove `isActive` buffering; filter client-side

**Goal:** all loaded workflow instances emit live updates immediately (no buffering). Each React
client filters by its own `activeWorkflowId`.

### Changes

#### `src/flightpath/WorkflowInstance.ts`

Remove:

- `private isActive: boolean`
- `private bufferedEvents: DeferredEvent[]`
- `setActive(value: boolean)` method
- `flushBufferedEvents()` method
- `activeDashboard` getter (all references replaced with direct `this.dashboardSink`)

All methods that previously guarded on `this.activeDashboard` now call `this.dashboardSink`
directly (always emit). The sink is always the `WorkflowTaggedSink` which tags with `workflowId`.

#### `src/flightpath/WorkflowOrchestrator.ts`

Remove all `instance.setActive(true/false)` calls. When `setVsCodeActiveWorkflow(id)` is called:

- Replay full state to the VS Code panel via `replayWorkflowStateTo`.
- No instance state changes needed.

#### `src/ui/webview-react/hooks/useMessageHandler.ts`

Add `workflowId` filter to all workflow-specific message handlers. Pattern:

```typescript
handlers[MESSAGE_TYPES.STEP_STATUS_UPDATED] = (message) => {
  if (
    message.workflowId &&
    message.workflowId !== useUiStore.getState().activeWorkflowId
  )
    return;
  // ... existing handler body
};
```

Handlers that need this guard (non-exhaustive):

- `STEP_STATUS_UPDATED`, `RETRY_ATTEMPT`
- `CLI_OUTPUT`, `CLI_STREAMING_CHUNK`, `CLI_STREAMING_EVENTS`
- `STATUS_MESSAGE`
- `EXECUTION_STARTED`, `EXECUTION_STATE`, `EXECUTION_COMPLETED`
- `PROGRESS`
- `FINAL_STEP_STATUS`, `FINAL_STEP_OUTPUT`, `FINAL_STEP_STREAMING_*`
- `SESSION_RESTORED`, `FILE_SELECTED`
- `WORKFLOW_STATE_RESET`, `START_POSITION_SET`, `PROMPTS_REORDERED`
- `WORKFLOW_NAME_UPDATED`
- `RUN_HISTORY_UPDATED`

Handlers that are **already** correctly workflowId-filtered or are global events (no change):

- `WORKFLOW_ADDED`, `WORKFLOW_DISMISSED`, `WORKFLOW_SUMMARY_UPDATED`
- `STEPS_EXTENDED` (already filtered by `workflowId`)
- `CLI_WATCH_OUTPUT` (already filtered by `workflowId`)

---

## Migration Notes

- Phases must be implemented in order (1 → 2 → 3). Each phase is independently shippable.
- Phase 1 unblocks the core multi-client UX. Phases 2+3 are required for correctness when
  multiple clients are viewing **different running** workflows simultaneously.
- No breaking changes to the React app's Zustand stores or message types — only new optional
  fields added to existing message shapes.
- Existing tests exercise `WorkflowInstance.setActive()` and `isActive` — these need updating
  in Phase 3 (`src/test/unit/WorkflowInstance.test.ts`).

---

## Status

| Phase                                                                   | Status         |
| ----------------------------------------------------------------------- | -------------- |
| Pre-fix (notifyRunHistoryUpdated, READY handler, LOAD_WORKFLOW partial) | ✅ Done        |
| Phase 1 — Unified instance registry                                     | ⬜ Not started |
| Phase 2 — WorkflowTaggedSink                                            | ⬜ Not started |
| Phase 3 — Remove isActive, client-side filtering                        | ⬜ Not started |
