# Symmetric Client Views Refactor

## Problem

The VS Code sidebar panel is treated as a globally-privileged client. The orchestrator holds a single `vsCodeViewedId` field tracking what the panel is currently viewing, and routes all active-view changes through a panel-specific broadcast path (`hub.notifyActiveWorkflowChanged`, `sendFullStateToDashboard`). Browser clients use a completely separate per-connection path (`replayWorkflowStateTo`).

This asymmetry is the root cause of a recurring class of bug where panel-triggered view changes bleed into browser clients:

- `ACTIVE_WORKFLOW_CHANGED` had to be restricted to `clients[0]` in the hub
- `FILE_SELECTED` / `SESSION_RESTORED` (broadcast via `sendFullStateToDashboard`) caused every browser tab to jump to whatever workflow the panel just loaded — **the bug that prompted this plan**
- Each fix adds another defensive no-op to `FlightPathHostedServer` rather than removing the source of the leak

## Goal

The panel becomes **just another client** with its own per-connection viewed-workflow state. All clients — panel and browser tabs — use the same code path for loading, switching, and replaying workflow state. There is no global "active workflow"; there is only "what each client is currently viewing."

## Key Conceptual Changes

| Before                                                         | After                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vsCodeViewedId: string \| null` — single global               | `viewerRegistry: Map<clientId, string \| null>` — one slot per connected client          |
| `vsCodeViewedRetiredInstance` — single retired ref             | `retiredInstances: Map<workflowId, WorkflowInstance>` — one per retired workflow, shared |
| Panel clientId: implicit (the global)                          | Panel clientId: `"panel"` (constant)                                                     |
| Browser clientId: `"browser:N"` scoped send                    | Browser clientId: `"browser:N"` scoped send (unchanged)                                  |
| `sendFullStateToDashboard()` → broadcasts to hub               | Full state only sent via `replayWorkflowStateTo(id, send)`                               |
| `hub.notifyActiveWorkflowChanged()` → panel-only special case  | `ACTIVE_WORKFLOW_CHANGED` always sent via scoped per-client send                         |
| `SWITCH_WORKFLOW`/`LOAD_WORKFLOW` split on `scopedPostMessage` | All clients route through same handler — panel's scoped send wraps its `postMessage`     |

---

## Implementation Phases

### Phase 1 — Per-Client Viewer Registry in WorkflowOrchestrator

**Goal:** Establish the data structures. `vsCodeViewedId` stays as a read-through shim to the registry during transition so nothing breaks yet.

**Changes to `src/flightpath/WorkflowOrchestrator.ts`:**

1. Add `private readonly PANEL_CLIENT_ID = "panel" as const`.

2. Add `private viewerRegistry = new Map<string, string | null>()`.
   - Initialized with `["panel", null]` in the constructor.

3. Add `private retiredInstances = new Map<string, WorkflowInstance>()`.
   - Replaces `vsCodeViewedRetiredInstance`.

4. Add helper methods:

   ```typescript
   getViewedWorkflowId(clientId: string): string | null
   setViewedWorkflowId(clientId: string, workflowId: string | null): void
   isWorkflowViewedByAnyClient(workflowId: string): boolean
   registerClient(clientId: string): void   // adds to registry with null
   unregisterClient(clientId: string): void // removes from registry; runs cleanup
   ```

5. Rewrite `getActiveWorkflowId()` to return `this.getViewedWorkflowId(this.PANEL_CLIENT_ID)` and `getActiveWorkflow()` / `getActiveInstance()` to match. These stay as named aliases so all existing callers (status bar, VS Code commands) continue to work without change.

6. `retireWorkflow(workflowId)`:
   - If `isWorkflowViewedByAnyClient(workflowId)`: move to `retiredInstances` map instead of `vsCodeViewedRetiredInstance`.
   - Else: dispose immediately (unchanged behavior).

7. `unregisterClient(clientId)`:
   - Get the workflowId that client was viewing.
   - If that workflowId is in `retiredInstances` and no other client views it: dispose and remove.
   - If that workflowId is an idle live instance and no other client views it: dispose and remove from `this.instances`.

**No behavior changes in this phase** — `vsCodeViewedId` stays as a getter over the registry.

---

### Phase 2 — Panel Gets a Scoped Send Function

**Goal:** Give the panel the same "scoped send" concept that browser clients already have, so it can be routed identically.

**Changes to `src/ui/FlightPathWebviewProvider.ts`:**

1. Expose `getPanelScopedSend(): (msg: unknown) => void`:
   ```typescript
   getPanelScopedSend(): (msg: unknown) => void {
     return (msg) => this.postMessage(msg);
   }
   ```
   This wraps `view.webview.postMessage` in the same shape as a WebSocket send function.

**Changes to `src/ui/WebviewMessageRouter.ts`:**

2. Set `this.scopedPostMessage` for the panel too — populated by calling `provider.getPanelScopedSend()` in the constructor when there is no WebSocket client. After this change, `this.scopedPostMessage` is **always** non-null; the `if (this.scopedPostMessage)` / `else` branches in the dispatch table collapse.

3. Set `this.clientId` for the panel to `"panel"` (previously only set for browser clients). Pass `clientId` to orchestrator calls that need it.

**Changes to `src/flightpath/WorkflowOrchestrator.ts`:**

4. Add `clientId` parameter to `replayWorkflowStateTo(workflowId, send, clientId)`. After replay, call `setViewedWorkflowId(clientId, workflowId)` so the registry is updated.

5. Add `clientId` parameter to `loadWorkflowForClient(filePath, send, clientId)` and `createWorkflowForClient(send, clientId)`. These already do the right thing; they just need to update the registry.

**No behavior changes yet** — `else` branches in WebviewMessageRouter still exist; we're just setting up the data.

---

### Phase 3 — Collapse the SWITCH_WORKFLOW / LOAD_WORKFLOW / CLEAR_WORKFLOW Branches

**Goal:** Remove the `if (this.scopedPostMessage)` / `else` split in WebviewMessageRouter for all workflow-loading operations. Panel and browser take the same code path.

**Changes to `src/ui/WebviewMessageRouter.ts`:**

Replace the current split handlers:

```typescript
// BEFORE
table.set(MESSAGE_TYPES.SWITCH_WORKFLOW, (message) => {
  if (this.scopedPostMessage) {
    orchestrator.replayWorkflowStateTo(workflowId, this.scopedPostMessage);
  } else {
    orchestrator.setActiveWorkflow(workflowId); // panel-only path
  }
});

// AFTER
table.set(MESSAGE_TYPES.SWITCH_WORKFLOW, (message) => {
  orchestrator.replayWorkflowStateTo(
    workflowId,
    this.scopedPostMessage,
    this.clientId
  );
});
```

Do the same for:

- `LOAD_WORKFLOW`: `loadWorkflowForClient(filePath, send, clientId)` for all clients
- `CLEAR_WORKFLOW`: `createWorkflowForClient(send, clientId)` for all clients

**Changes to `src/ui/WebviewMessageRouter.ts` — READY handler:**

```typescript
// BEFORE: branched on scopedPostMessage
if (this.scopedPostMessage) {
  // browser path: replay active
} else {
  // panel path: setDashboardReady(), PTY reconnect, server URL
}

// AFTER: shared workflow replay; panel-only extras are explicit
orchestrator.handleClientReady(this.clientId, this.scopedPostMessage);
// Panel-only extras remain in an explicit `if (this.clientId === "panel")` block:
//   - setDashboardReady() (startup auto-load gate)
//   - PTY session reconnect
//   - SERVER_STARTED reconnect
```

**Changes to `src/flightpath/WorkflowOrchestrator.ts`:**

Add `handleClientReady(clientId, send)`:

```typescript
async handleClientReady(clientId: string, send: (msg: unknown) => void): Promise<void> {
  this.registerClient(clientId);
  const viewedId = this.getViewedWorkflowId(clientId);
  if (viewedId) {
    await this.replayWorkflowStateTo(viewedId, send, clientId);
  }
  send({ type: MESSAGE_TYPES.WORKFLOWS_LIST, workflows: this.getWorkflowSummaries() });
}
```

The startup auto-load path in `setDashboardReady()` calls `replayWorkflowStateTo(loadedId, panelSend, "panel")` instead of `sendFullStateToDashboard() + notifyActiveWorkflowChanged()`.

---

### Phase 4 — Remove `setActiveWorkflow` and `createWorkflow` from the Public API

**Goal:** These are now dead code paths for the router. Remove them and clean up.

**Changes to `src/flightpath/WorkflowOrchestrator.ts`:**

1. `setActiveWorkflow(workflowId)`: make private. Only remaining caller is internal — the duplicate-workflow dialog's "Switch to Existing" branch. Replace that call with `replayWorkflowStateTo(workflowId, panelSend, "panel")`.

2. `createWorkflow(_filePath?)`: make private. Remaining callers in the orchestrator:
   - `loadWorkingFile()` (VS Code command): replace with `createWorkflowForClient(panelSend, "panel")` then load
   - `executePromptFile()`: same
   - Startup auto-load: already handled by `handleClientReady`
   - `resumeRecentWorkflowSession()` (command palette): replace with `createWorkflowForClient + loadWorkingFile`

3. Remove `vsCodeViewedId` field. `getActiveInstance()` is rewritten as:

   ```typescript
   private getActiveInstance(): WorkflowInstance {
     const id = this.getViewedWorkflowId(this.PANEL_CLIENT_ID);
     if (id) {
       return this.instances.get(id) ?? this.retiredInstances.get(id) ?? this.buildAndRegisterEmpty();
     }
     return this.buildAndRegisterEmpty();
   }
   ```

4. Remove `vsCodeViewedRetiredInstance`. All retirement logic uses `retiredInstances` map.

---

### Phase 5 — Remove `updateFileSelected` / `updateSessionRestored` from the Broadcast Layer

**Goal:** These methods exist only to push full workflow state to the dashboard. With per-client replay, they are never legitimately called by the hub. Remove them from the stack.

**Changes to `src/flightpath/WorkflowInstance.ts`:**

- `sendFullStateToDashboard()`: rename to `private replayStateToSink(sink: IDashboardSink)`. Make it private. It is only called by `replayFullStateTo(sink)`.

**Changes to `src/ui/IDashboardProvider.ts`:**

- Remove `updateFileSelected()` and `updateSessionRestored()` from the interface.

**Changes to `src/ui/DashboardBroadcastHub.ts`:**

- Remove `updateFileSelected()` and `updateSessionRestored()` methods.
- Remove the `panelClient` field and `setPanelClient()` method. `addClient()` is the only registration path.
- `notifyActiveWorkflowChanged()`: remove the method. `ACTIVE_WORKFLOW_CHANGED` is now always sent via `replayWorkflowStateTo`'s scoped send, never via the hub.
- Update interface implementation accordingly.

**Changes to `src/ui/FlightPathWebviewProvider.ts`:**

- Remove `updateFileSelected()` and `updateSessionRestored()` public methods.
- Remove `notifyActiveWorkflowChanged()`. The panel receives `ACTIVE_WORKFLOW_CHANGED` via its scoped send through `replayWorkflowStateTo`, same as any browser client.

**Changes to `src/server/FlightPathHostedServer.ts`:**

- Remove `updateFileSelected()` and `updateSessionRestored()` no-ops (no longer needed — they won't exist on the interface).
- Remove `notifyActiveWorkflowChanged()` no-op.

---

### Phase 6 — Client Lifecycle Wiring

**Goal:** Browser disconnections and panel teardown properly clean up the viewer registry.

**Changes to `src/server/FlightPathHostedServer.ts`:**

```typescript
ws.on("close", () => {
  this.connections.delete(ws);
  orchestrator?.unregisterClient(clientTag); // cleans up retired/idle instances with no viewers
});
```

**Changes to `src/ui/WebviewMessageRouter.ts`:**

The panel is never "disconnected" in the WebSocket sense, but when the extension deactivates, `WorkflowOrchestrator.dispose()` already tears down all instances. No additional wiring needed here.

---

## Files Changed Summary

| File                                     | Change                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/flightpath/WorkflowOrchestrator.ts` | Core: add `viewerRegistry`, `retiredInstances`, `handleClientReady`, collapse `setActiveWorkflow`/`createWorkflow` to private; remove `vsCodeViewedId`, `vsCodeViewedRetiredInstance` |
| `src/flightpath/WorkflowInstance.ts`     | Make `sendFullStateToDashboard` private, rename to `replayStateToSink`                                                                                                                |
| `src/ui/WebviewMessageRouter.ts`         | Collapse all `if (scopedPostMessage) / else` branches; `scopedPostMessage` always set; pass `clientId`                                                                                |
| `src/ui/FlightPathWebviewProvider.ts`    | Add `getPanelScopedSend()`; remove `updateFileSelected`, `updateSessionRestored`, `notifyActiveWorkflowChanged`                                                                       |
| `src/ui/DashboardBroadcastHub.ts`        | Remove `panelClient`, `setPanelClient`, `notifyActiveWorkflowChanged`, `updateFileSelected`, `updateSessionRestored`                                                                  |
| `src/ui/IDashboardProvider.ts`           | Remove `updateFileSelected`, `updateSessionRestored` from interface                                                                                                                   |
| `src/server/FlightPathHostedServer.ts`   | Remove all three no-ops; wire `unregisterClient` on WS close                                                                                                                          |
| `src/ui/PostMessageDashboardSink.ts`     | Remove `updateFileSelected`, `updateSessionRestored` (no longer on `IDashboardSink`)                                                                                                  |

---

## Invariants After Refactor

- `ACTIVE_WORKFLOW_CHANGED` is **always** sent via a scoped per-client send. It never touches the hub.
- `FILE_SELECTED` and `SESSION_RESTORED` no longer exist as hub-level messages. Full state reaches a client only via `replayWorkflowStateTo(id, send, clientId)`.
- The orchestrator's `getActiveInstance()` / `getActiveWorkflowId()` remain as panel-scoped convenience wrappers. They return the panel's viewed instance. VS Code commands, status bar, and MCP tools all legitimately operate on the panel's view — that doesn't change.
- Idle instance cleanup: an instance is eligible for disposal when no client's viewer slot points to it (and it's not running/paused). The `unregisterClient` path handles browser disconnections; the panel's create/switch paths handle panel-side transitions.
- Retired instance cleanup: a completed instance stays in `retiredInstances` as long as at least one client is viewing it. Disposed when the last viewer leaves.

## What Does NOT Change

- The panel can still be the "authoritative" view for VS Code commands (`pause`, `resume`, `stop`, `appendFromFile`, etc.) — these all go through `getActiveInstance()` which remains the panel's convenience accessor.
- The status bar continues to show the panel's workflow state (reads from `getActiveInstance()`).
- All hub broadcast events that legitimately go to everyone (`WORKFLOW_SUMMARY_UPDATED`, `WORKFLOW_ADDED`, `WORKFLOW_DISMISSED`, `STEPS_EXTENDED`, `CLI_WATCH_OUTPUT`, `HARNESS_STATUS_UPDATE`, etc.) continue unchanged. The hub remains the right place for these.
- Browser tabs are still independent — each has its own viewed-workflow slot. The refactor does not consolidate them; it just puts the panel on equal footing.

## Suggested Phase Order for PRs

1. **Phase 1**: Registry data structures only — zero behavior change, fully testable in isolation.
2. **Phases 2 + 3 together**: Scoped send + collapse branches — the core routing change.
3. **Phase 4**: Remove dead orchestrator methods — cleanup after routing is proven.
4. **Phases 5 + 6 together**: Strip the broadcast interface + wire lifecycle — final cleanup.

Each phase should pass the full test suite (`npm test`) before proceeding to the next.
