# Startup Loading Overlay Plan

## Problem

During the extension startup window (typically 500ms–2000ms, up to ~5s on slow machines), the dashboard UI is fully interactive but the extension hasn't finished loading. If a user makes changes during this window, the late-arriving auto-load overwrites them. This causes lost settings and occasionally strange UI state.

---

## Root Cause Analysis

### Full Startup Sequence (Panel)

The startup involves two independent async pipelines racing toward the same UI:

```
Extension activate
│
├─ WorkflowOrchestrator.initialize()          [async, up to ~2s]
│   ├─ Promise.all([...7 x checkAvailability()])  ← subprocess spawns, slow
│   ├─ discoverPromptFiles()
│   ├─ setupCliWatching()
│   └─ orchestratorInitialized = true
│       └─ if dashboardReady: triggerAutoLoad()
│           └─ autoLoadRecentSession()
│               ├─ SESSION_RESTORED  →  webview
│               ├─ replayWorkflowStateTo()  →  webview
│               ├─ WORKFLOW_PROPERTIES_UPDATE  →  webview
│               └─ WORKFLOW_LOADED  →  webview      ← THE SAFE GATE
│
└─ FlightPathWebviewProvider.resolveWebviewView()
    ├─ settingsSync.sendInitialState()            ← early INIT (may get dropped)
    └─ React mounts → sends READY
        └─ Extension receives READY
            ├─ sendInitialState()                 ← INIT sent (all harnessStatus="checking")
            └─ setDashboardReady()
                └─ if orchestratorInitialized: triggerAutoLoad()  [else deferred]
```

**The user-facing window where damage can occur:**

```
INIT received ─────────────────────────────── WORKFLOW_LOADED received
     │                                                │
     └── UI is live and interactive ─────────────────┘
            User edits harness/model/steps
                        ↓
            WORKFLOW_PROPERTIES_UPDATE overwrites them
```

### Specific Race Conditions

1. **Properties overwrite**: User changes `harness`, `model`, or any `WorkflowPropertiesPanel` field. The `WORKFLOW_PROPERTIES_UPDATE` that follows `SESSION_RESTORED` replaces the entire `workflowProperties` object.

2. **Steps clobbered**: User adds or edits a step after `INIT` but before `SESSION_RESTORED`. The `loadWorkflow()` call in `SESSION_RESTORED` replaces the entire steps array.

3. **No-session edge case**: If `autoLoadRecentSession()` finds nothing, `WORKFLOW_LOADED` is never sent. The properties panel is already gated by `workflowLoaded=false` in this case, but global controls remain live without a clear "settled" signal.

### Why Existing Guards Don't Fully Protect

- `workflowLoaded` in `settingsStore` gates the `WorkflowPropertiesPanel`, but doesn't cover global settings or other interactions.
- `WORKFLOW_LOADED` is only sent when a session is found. There is no signal today for "startup settled, no session".
- `INIT` is sent with all harness statuses as `"checking"` — that's fine, status updates trickle in separately and don't need to block anything.

### What We Actually Need to Wait For

| Condition                       | Signal                         | Notes                                          |
| ------------------------------- | ------------------------------ | ---------------------------------------------- |
| Global settings ready           | `INIT` received                | Fast (~50ms), already handled                  |
| Harness status resolved         | `HARNESS_STATUS_UPDATE` (×7)   | Trickle updates. Don't need to block on these. |
| Auto-load complete with session | `WORKFLOW_LOADED`              | Already exists                                 |
| Auto-load complete, no session  | **Missing — needs new signal** | `triggerAutoLoad()` exits silently             |

---

## Solution: Startup Loading Overlay

### Approach

Show a semi-transparent full-screen overlay with a spinner and "Loading…" text immediately on first render. Dismiss it once startup is fully settled. The overlay intercepts all pointer events, preventing user interaction with the dashboard underneath.

This is the cleanest fix: no partial gating of individual controls, no complex per-component awareness of startup state, no risk of missing a control.

### Overlay Dismissal Triggers

The overlay lifts when **either**:

1. A new `STARTUP_COMPLETE` message is received from the extension, **or**
2. A safety timeout fires (default: **8 seconds**) — ensures the overlay never gets permanently stuck

`STARTUP_COMPLETE` is sent by the extension at the end of `triggerAutoLoad()` regardless of whether a session was found. It subsumes `WORKFLOW_LOADED` as the startup signal: `WORKFLOW_LOADED` continues to serve its existing purpose (enabling the WorkflowPropertiesPanel for user edits), while `STARTUP_COMPLETE` exclusively means "initial load sequence is done."

### What Is NOT Blocked

- Static layout rendering (panels, sections) — renders normally underneath
- Theme application — immediate
- INIT data (global settings, model options) — applied immediately
- Harness status trickle updates — applied immediately, just not visible until overlay lifts

---

## Implementation Plan

### Phase 1 — Extension: Add `STARTUP_COMPLETE` message

**File: `src/types/DashboardConstants.ts`**

Add after `WORKFLOW_LOADED`:

```typescript
STARTUP_COMPLETE: "startupComplete", // Extension -> Webview: Startup sequence done (with or without auto-load)
```

**File: `src/types/WebviewMessageTypes.ts`**

Add to the outbound union type:

```typescript
| { type: typeof MESSAGE_TYPES.STARTUP_COMPLETE }
```

**File: `src/flightpath/WorkflowOrchestrator.ts`** — `triggerAutoLoad()` method

Wrap the body in a `try/finally` and move both the callback cleanup and `STARTUP_COMPLETE` into `finally` so they fire regardless of whether a session was found or an exception was thrown:

```typescript
private async triggerAutoLoad(): Promise<void> {
  try {
    if (ConfigurationUtils.shouldAutoLoadRecentSession() && this.currentWorkspaceFolder) {
      // ... existing autoLoadRecentSession logic (callbacks cleared inside on success) ...
    }
  } finally {
    // Always clear pending callbacks — if no session was found or an error
    // occurred they'll never be invoked, so release them here.
    this.pendingBrowserAutoLoadCallbacks = [];
    // Notify all currently-connected clients that first startup is done.
    this.dashboardBroadcastHub.notifyStartupComplete();
  }
}
```

**File: `src/flightpath/WorkflowOrchestrator.ts`** — replace boolean flag with a settled Promise

This also fixes **Known Issue #2** (browser client stuck during startup auto-load race). The issue doc characterizes the window as "sub-millisecond" but `autoLoadRecentSession` contains multiple real async I/O awaits (`fs.stat`, directory read, JSON file read via `onLoad`) — the actual window is 100–500ms and the race is real.

Replace `startupAutoLoadTriggered: boolean` with a `Promise<string | null>` that resolves to the loaded workflow ID (or `null` if no session). This lets any client — whether it connects before, during, or after auto-load — simply await the same promise and receive the definitive result:

```typescript
// Replace:
private startupAutoLoadTriggered: boolean = false;

// With:
private startupAutoLoadSettled: Promise<string | null>;
private resolveStartupAutoLoad!: (id: string | null) => void;

// In constructor:
this.startupAutoLoadSettled = new Promise((resolve) => {
  this.resolveStartupAutoLoad = resolve;
});

// Keep existing getter for backward compat with callers that only check if triggered:
get isAutoLoadTriggered(): boolean {
  // Resolved if anyone has called resolveStartupAutoLoad
  return this._autoLoadHasSettled;
}

// New awaitable getter for the READY handler:
awaitStartupAutoLoad(): Promise<string | null> {
  return this.startupAutoLoadSettled;
}
```

In `triggerAutoLoad()`, resolve the promise in the `finally` block:

```typescript
private async triggerAutoLoad(): Promise<void> {
  let loadedWorkflowId: string | null = null;
  try {
    if (ConfigurationUtils.shouldAutoLoadRecentSession() && this.currentWorkspaceFolder) {
      await this.workspaceSessionManager.autoLoadRecentSession(
        this.currentWorkspaceFolder.uri.fsPath,
        async (workingFilePath: string) => {
          // ... existing skip/load/replay/callback logic ...
          loadedWorkflowId = this.getActiveInstance().id; // capture before finally
        }
      );
    }
  } finally {
    this._autoLoadHasSettled = true;
    this.resolveStartupAutoLoad(loadedWorkflowId);
    this.pendingBrowserAutoLoadCallbacks = []; // keep for safety; subsumed by promise
    this.dashboardBroadcastHub.notifyStartupComplete();
  }
}
```

**File: `src/ui/WebviewMessageRouter.ts`** — `READY` handler — replace fast-path boolean check with promise await

For the **panel** (after `setDashboardReady()`): `STARTUP_COMPLETE` arrives via the hub broadcast from `triggerAutoLoad()` — no change needed for the panel path.

For **browser clients** (inside the `clientId !== PANEL_CLIENT_ID` block): replace the `isAutoLoadTriggered` boolean check and the pending-callback registration with a single await on the settled promise:

```typescript
if (this.clientId !== PANEL_CLIENT_ID) {
  // Await startup auto-load completion regardless of when this client connected
  // (before, during, or after). The promise always resolves.
  const loadedWorkflowId = await orchestrator.awaitStartupAutoLoad();

  // If auto-load found a session and this client hasn't already received a replay
  // (handleClientReady may have replayed it if viewedId was set in time),
  // send a targeted replay now with the definitive workflow ID.
  const alreadyReplayed = !!this.getViewedWorkflowId(this.clientId);
  if (loadedWorkflowId && !alreadyReplayed) {
    await orchestrator.replayWorkflowStateTo(
      loadedWorkflowId,
      this.scopedPostMessage,
      this.clientId
    );
  }

  await this.settingsSync.sendWorkflowPropertiesToSettings(
    this.getCurrentPostMessage(),
    this.clientId
  );
  // Send STARTUP_COMPLETE directly to this client — the hub broadcast
  // from triggerAutoLoad() may have fired before this client connected.
  this.settingsSync.sendStartupComplete(this.getCurrentPostMessage());
}
```

This eliminates `pendingBrowserAutoLoadCallbacks` for browser clients entirely — every browser client now goes through a single unified path that correctly handles all timing scenarios. The `addBrowserAutoLoadCallback` method and its registration in the old `!isAutoLoadTriggered` branch can be removed.

> **Note on the panel path**: The panel sends `STARTUP_COMPLETE` via the hub broadcast from `triggerAutoLoad()` — the timing is correct because `setDashboardReady()` is always called before `triggerAutoLoad()` fires for the panel. On panel reload, `triggerAutoLoad()` doesn't re-run, so the panel gets `STARTUP_COMPLETE` from the `sendStartupComplete()` call after `sendWorkflowPropertiesToSettings()` (same approach as before, since `isAutoLoadTriggered` / `_autoLoadHasSettled` is true on reload). Keep the panel fast-path: after `sendWorkflowPropertiesToSettings()`, if `orchestrator._autoLoadHasSettled`, call `sendStartupComplete()`.

This covers every scenario:

- **Panel reload + session**: `WORKFLOW_LOADED` lifts overlay, then `sendStartupComplete()` fast-path confirms. No `CLEAR_WORKFLOW` (fileName set).
- **Panel reload + no session**: `sendStartupComplete()` fast-path. `fileName` null → `CLEAR_WORKFLOW` → "New Workflow".
- **Browser tab, any timing**: awaits promise, gets definitive result, targeted replay if needed, then `STARTUP_COMPLETE`. No race possible.
- **Fresh startup (panel)**: hub broadcast from `triggerAutoLoad()` `finally` block reaches panel via the broadcast hub.

**File: `src/ui/DashboardBroadcastHub.ts`**

Add `notifyStartupComplete()` that broadcasts `{ type: MESSAGE_TYPES.STARTUP_COMPLETE }` to all currently-registered sinks.

**File: `src/ui/WebviewSettingsSync.ts`**

Add `sendStartupComplete(postMessage)` method that emits `{ type: MESSAGE_TYPES.STARTUP_COMPLETE }` to the given targeted post function. Used by the fast path in the `READY` handler.

> **Why not just extend `WORKFLOW_LOADED`?** `WORKFLOW_LOADED` is sent per-client (scoped to a specific send function), but only when a session was found. `STARTUP_COMPLETE` must fire even when no session exists. Keeping them separate also keeps the semantics clean: `WORKFLOW_LOADED` means "a specific workflow is ready to edit", `STARTUP_COMPLETE` means "the startup sequence is fully settled".

### Phase 2 — Webview: `startupReady` state

**File: `src/ui/webview-react/store/uiStore.ts`**

Add a `startupReady: boolean` field initialized to `false`. This must **not** be persisted in `vscode.getState()` — every panel open should show the overlay until startup completes. Add `setStartupReady(ready: boolean)` action.

```typescript
startupReady: false,
setStartupReady: (ready) => set({ startupReady: ready }),
```

### Phase 3 — Webview: Handle `STARTUP_COMPLETE` and `WORKFLOW_LOADED` messages

**File: `src/ui/webview-react/hooks/useMessageHandler.ts`**

`STARTUP_COMPLETE` dismisses the overlay:

```typescript
handlers[MESSAGE_TYPES.STARTUP_COMPLETE] = () => {
  useUiStore.getState().setStartupReady(true);
};
```

`WORKFLOW_LOADED` also dismisses the overlay as a belt-and-suspenders fallback. In the reconnect/reload path the extension sends `WORKFLOW_LOADED` (via `sendWorkflowPropertiesToSettings`) before the fast-path `STARTUP_COMPLETE` has a chance to fire, so this ensures the overlay lifts immediately from whichever arrives first:

```typescript
// Existing WORKFLOW_LOADED handler — add one line:
handlers[MESSAGE_TYPES.WORKFLOW_LOADED] = () => {
  const settingsStore = useSettingsStore.getState();
  const editorStore = useEditorStore.getState();
  settingsStore.setWorkflowLoaded(true);
  editorStore.setHasActiveQueue(true);
  useUiStore.getState().setStartupReady(true); // ← add this
};
```

### Phase 4 — Webview: `StartupOverlay` component

**File: `src/ui/webview-react/components/layout/StartupOverlay.tsx`** _(new file)_

```tsx
import { useEffect } from "react";
import { useUiStore } from "@store/uiStore";

const STARTUP_TIMEOUT_MS = 8000;

export const StartupOverlay: React.FC = () => {
  const startupReady = useUiStore((s) => s.startupReady);
  const setStartupReady = useUiStore((s) => s.setStartupReady);

  // Safety timeout: dismiss overlay if STARTUP_COMPLETE never arrives
  useEffect(() => {
    if (startupReady) return;
    const id = setTimeout(() => setStartupReady(true), STARTUP_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [startupReady, setStartupReady]);

  if (startupReady) return null;

  return (
    <div
      className="absolute inset-0 z-[9999] bg-editor-bg/80 flex items-center justify-center"
      style={{ pointerEvents: "all" }}
      aria-live="polite"
      aria-label="Loading FlightPath…"
    >
      {/* Spinner */}
      <div className="flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-description-fg border-t-transparent rounded-full animate-spin" />
        <span className="text-xs text-description-fg select-none">
          Loading…
        </span>
      </div>
    </div>
  );
};
```

The overlay:

- Uses `absolute inset-0` to cover the full dashboard area (sits inside the `relative overflow-hidden` wrapper in `App.tsx`)
- `z-[9999]` ensures it's above all panels, separators, and drawers
- `bg-editor-bg/80` is semi-transparent (80% opacity) — panels are visible but dimmed underneath
- `pointerEvents: "all"` on the overlay div blocks all clicks/keyboard from reaching panel content
- `aria-live` for accessibility — screen readers announce "Loading FlightPath…" on mount

### Phase 5 — Render overlay in `App.tsx`

**File: `src/ui/webview-react/App.tsx`**

Import `StartupOverlay` and add it as the last child in both the mobile and desktop layout wrappers (inside the `relative` container so `absolute inset-0` fills the full layout):

**Desktop** — add inside the `<div className="flex-1 relative overflow-hidden flex flex-col min-h-0">`:

```tsx
<StartupOverlay />
```

**Mobile** — add inside the `<div className="flex-1 relative overflow-hidden flex">`:

```tsx
<StartupOverlay />
```

Export `StartupOverlay` from `components/layout/index.ts`.

### Phase 6 — `layout/index.ts` export

**File: `src/ui/webview-react/components/layout/index.ts`**

Add:

```typescript
export { StartupOverlay } from "./StartupOverlay";
```

---

## Edge Cases

| Scenario                                                 | Signal that lifts overlay                                                                          | Latency                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| Fresh start, session found                               | `STARTUP_COMPLETE` (broadcast after `triggerAutoLoad`)                                             | 500ms–2000ms               |
| Fresh start, no session                                  | `STARTUP_COMPLETE` (`finally` block in `triggerAutoLoad`)                                          | 500ms–2000ms               |
| Panel moved to new view / webview reload, session exists | `WORKFLOW_LOADED` (sent by `sendWorkflowPropertiesToSettings`) then `STARTUP_COMPLETE` (fast path) | <200ms                     |
| Panel moved to new view / webview reload, no session     | `STARTUP_COMPLETE` fast path (`isAutoLoadTriggered = true` in READY handler)                       | <50ms                      |
| New browser tab, session already loaded                  | `WORKFLOW_LOADED` then `STARTUP_COMPLETE` (fast path)                                              | <200ms                     |
| New browser tab, no session was loaded                   | `STARTUP_COMPLETE` fast path                                                                       | <50ms                      |
| Extension crashes before any signal                      | 8s safety timeout                                                                                  | 8s                         |
| CLI-managed workflow skipped by auto-load                | `STARTUP_COMPLETE` (`finally` fires even when callback is skipped)                                 | 500ms–2000ms               |
| Very fast startup (<100ms)                               | `STARTUP_COMPLETE` broadcast                                                                       | Brief flash, imperceptible |

---

## Files to Change

| File                                                        | Change                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/types/DashboardConstants.ts`                           | Add `STARTUP_COMPLETE` constant                                                                                                                                                                                                                                                      |
| `src/types/WebviewMessageTypes.ts`                          | Add `STARTUP_COMPLETE` to outbound union                                                                                                                                                                                                                                             |
| `src/flightpath/WorkflowOrchestrator.ts`                    | Replace `startupAutoLoadTriggered: boolean` with settled Promise; `triggerAutoLoad()` wrapped in `try/finally`, resolves promise + broadcasts `STARTUP_COMPLETE`; remove `addBrowserAutoLoadCallback` and `pendingBrowserAutoLoadCallbacks`                                          |
| `src/ui/WebviewMessageRouter.ts`                            | Browser READY path: replace `isAutoLoadTriggered` check + pending-callback registration with `await orchestrator.awaitStartupAutoLoad()` unified path; panel READY path: add fast-path `sendStartupComplete()` after `sendWorkflowPropertiesToSettings()` when `_autoLoadHasSettled` |
| `src/ui/DashboardBroadcastHub.ts`                           | Add `notifyStartupComplete()` broadcast method                                                                                                                                                                                                                                       |
| `src/ui/WebviewSettingsSync.ts`                             | Add `sendStartupComplete(postMessage)` targeted emit helper                                                                                                                                                                                                                          |
| `src/ui/webview-react/store/uiStore.ts`                     | Add `startupReady` + `setStartupReady` (not persisted)                                                                                                                                                                                                                               |
| `src/ui/webview-react/hooks/useMessageHandler.ts`           | Handle `STARTUP_COMPLETE`; also call `setStartupReady(true)` in existing `WORKFLOW_LOADED` handler                                                                                                                                                                                   |
| `src/ui/webview-react/components/layout/StartupOverlay.tsx` | New component                                                                                                                                                                                                                                                                        |
| `src/ui/webview-react/components/layout/index.ts`           | Export `StartupOverlay`                                                                                                                                                                                                                                                              |
| `src/ui/webview-react/App.tsx`                              | Render `<StartupOverlay />` in both mobile and desktop layouts                                                                                                                                                                                                                       |
| `dev/KNOWN_ISSUES.md`                                       | Mark Known Issue #2 as resolved by this plan                                                                                                                                                                                                                                         |

---

## Part 2: "New Workflow" String Standardization & Empty-State Elimination

### Problem

Three separate strings are used interchangeably to mean "no file has been saved yet":

| String                 | Where                                                                                      | Correct?                          |
| ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------- |
| `"New Workflow"`       | `DEFAULT_WORKFLOW_NAME` constant, `WorkflowInstance` (some paths), most new-workflow flows | ✅ canonical                      |
| `"Untitled"`           | `WorkflowInstance.ts` (3 literal occurrences), `UndoRedoControl.tsx` (1 occurrence)        | ❌ stray                          |
| `"No workflow loaded"` | `WorkflowStatus.tsx` italic empty state                                                    | ❌ shown when `fileName === null` |
| `"No workflows found"` | `RecentWorkflows.tsx` empty list state                                                     | ❌ dead-end text                  |

`DEFAULT_WORKFLOW_NAME = "New Workflow"` already exists in `DashboardConstants.ts` and is used correctly in most of the codebase. The `"Untitled"` literals are strays that slipped past the constant.

The two empty-state strings are a UX dead-end: a user opening FlightPath for the first time (or with no recent session) either sees italic `"No workflow loaded"` in the header, or a `"No workflows found"` message in the Recent Workflows dropdown — neither tells them what to do next and neither matches the "New Workflow" language used everywhere else.

### Fix 1 — Eliminate `"Untitled"` literal strings

Replace all four with the imported `DEFAULT_WORKFLOW_NAME` constant:

**`src/flightpath/WorkflowInstance.ts`** (3 occurrences):

- Line ~322: `state.workflowName || "Untitled"` → `state.workflowName || DEFAULT_WORKFLOW_NAME`
- Line ~355: same pattern in the second `sendFullStateToDashboard` variant
- Line ~1576: bare `"Untitled"` in `updatePromptDeleted` fallback → `DEFAULT_WORKFLOW_NAME`

`DEFAULT_WORKFLOW_NAME` is already imported in this file.

**`src/ui/webview-react/components/shared/UndoRedoControl.tsx`** (1 occurrence):

- Line ~92: `next.workflowName ?? "Untitled"` → `next.workflowName ?? DEFAULT_WORKFLOW_NAME`

Add import: `import { DEFAULT_WORKFLOW_NAME } from "@root/types/DashboardConstants";`

### Fix 2 — Auto-create blank workflow when startup completes with no session

When `STARTUP_COMPLETE` fires and no session was loaded (`fileName` is still `null` in the workflow store), the webview should automatically trigger a blank new workflow so the user always lands on a "New Workflow" state — never the italic "no workflow loaded" empty state.

**`src/ui/webview-react/hooks/useMessageHandler.ts`** — `STARTUP_COMPLETE` handler:

```typescript
handlers[MESSAGE_TYPES.STARTUP_COMPLETE] = () => {
  useUiStore.getState().setStartupReady(true);
  // If startup completed with no session, auto-create a blank workflow so the
  // user lands on "New Workflow" rather than the "No workflow loaded" empty state.
  const { fileName } = useWorkflowStore.getState();
  if (!fileName) {
    getVsCodeApi().postMessage({ type: MESSAGE_TYPES.CLEAR_WORKFLOW });
  }
};
```

`CLEAR_WORKFLOW` triggers `FlightPathWebviewProvider.handleNewWorkflow()` on the extension side, which calls `updateFileSelected(DEFAULT_WORKFLOW_NAME, [], undefined)` — setting `fileName = "New Workflow"`, empty steps, idle state. The user sees the blank ready-to-use dashboard.

> **Why `CLEAR_WORKFLOW` and not `NEW_WORKFLOW`?** `NEW_WORKFLOW` opens the "from template" modal, which requires user interaction. `CLEAR_WORKFLOW` silently resets to a blank workflow — the right behavior for an auto-triggered default state. The user can still open the template modal explicitly from the New button's dropdown.

### Fix 3 — Replace `"No workflow loaded"` italic text in `WorkflowStatus`

After Fix 2, the `fileName === null` branch in `WorkflowStatus.tsx` will only be visible during the brief startup overlay window (the overlay blocks it anyway) or as a fallback if `CLEAR_WORKFLOW` hasn't processed yet. Rather than deleting the branch, replace the unhelpful italic text with the standard name:

**`src/ui/webview-react/components/workflow/WorkflowStatus.tsx`** (~line 268–275):

Remove the `if (!fileName)` early-return entirely. The `displayName` computation already falls back to `DEFAULT_WORKFLOW_NAME` via `getWorkflowNameFromPath` when `fileName` is null:

```typescript
const displayName = fileName
  ? workflowName || getWorkflowNameFromPath(fileName)
  : DEFAULT_WORKFLOW_NAME; // was: "" (causing the italic empty-state render)
```

Remove the early-return block and let the component always render the full workflow status UI with `displayName = "New Workflow"` when there's no file yet.

> This also removes the now-misleading test `"shows 'No workflow loaded' when fileName is null"` — update it to assert `"New Workflow"` is shown instead.

### Fix 4 — Replace `"No workflows found"` in `RecentWorkflows` dropdown

The empty-list state in `RecentWorkflows.tsx` should offer a direct action instead of a dead-end message. Replace the text div with a clickable "New Workflow" row:

**`src/ui/webview-react/components/workflow/RecentWorkflows.tsx`** (~lines 48–51):

```tsx
{workflows.length === 0 ? (
  <button
    type="button"
    onClick={() => onNewWorkflow?.()}
    className="w-full px-3 py-2 text-left text-sm text-description-fg hover:bg-list-hover-bg hover:text-list-highlight-fg flex items-center gap-2"
  >
    <i className="codicon codicon-add text-[11px]" />
    New Workflow
  </button>
) : (
  // ... existing workflow list
)}
```

Add `onNewWorkflow?: () => void` to the `RecentWorkflows` props and wire it up in the parent to send `{ type: MESSAGE_TYPES.CLEAR_WORKFLOW }`.

### Updated Files for Part 2

| File                                                                    | Change                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/flightpath/WorkflowInstance.ts`                                    | Replace 3× `"Untitled"` literals with `DEFAULT_WORKFLOW_NAME`                        |
| `src/ui/webview-react/components/shared/UndoRedoControl.tsx`            | Replace `"Untitled"` with `DEFAULT_WORKFLOW_NAME`                                    |
| `src/ui/webview-react/hooks/useMessageHandler.ts`                       | `STARTUP_COMPLETE` handler: auto-send `CLEAR_WORKFLOW` if `fileName` is null         |
| `src/ui/webview-react/components/workflow/WorkflowStatus.tsx`           | Remove `!fileName` early-return; use `DEFAULT_WORKFLOW_NAME` as displayName fallback |
| `src/ui/webview-react/test/components/workflow/WorkflowStatus.test.tsx` | Update test asserting "No workflow loaded" → assert "New Workflow"                   |
| `src/ui/webview-react/components/workflow/RecentWorkflows.tsx`          | Replace "No workflows found" text with actionable "New Workflow" button row          |

---

## What This Does NOT Address

- **Harness status "checking" state in the dropdown** — this is intentional UX (shows the user that checks are running). Harness status resolution is independent of the loading overlay and should remain as-is.
- **Webview reload mid-workflow** — already handled correctly by `setDashboardReady` replay logic.
- **Multiple concurrent workflows** — startup overlay only covers the very first load; subsequent file loads are user-initiated and don't need overlay protection.
