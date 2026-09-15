# xterm.js + node-pty Terminal Architecture

## Overview

FlightPath embeds a full terminal experience in its dashboard using **xterm.js** (web-based terminal emulator) in the webview, backed by **node-pty** (native pseudo-terminal spawner) in the VS Code extension host. This document covers the lifecycle, reconnection behavior, and known issues with workflow switching and panel repositioning.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│  Webview (React)                                        │
│  ┌─────────────┐  ┌──────────────────────────────────┐  │
│  │ TerminalView│  │ terminalRegistry (module-level)   │  │
│  │  (layout)   │  │  - Map<key, RegistryEntry>       │  │
│  │             │  │  - create() / attach() / detach() │  │
│  │ ┌─────────┐ │  │  - freeze() / clearSession()     │  │
│  ││Terminal  │ │  └──────────────────────────────────┘  │
│  ││Instance │ │  ┌──────────────────────────────────┐  │
│  ││ (xterm  │ │  │ terminalStore (Zustand)          │  │
│  ││  DOM)   │ │  │  - sessions[workflowId]          │  │
│  │└─────────┘ │  │  - activeSessionIds[workflowId]   │  │
│  │            │  │  - pendingOutput[] (buffer)       │  │
│  └┬───────────┘  └──────────────────────────────────┘  │
└─┼──────────────────────────┬───────────────────────────┘
  │ postMessage              │ postMessage
  │                          ▼
  │  ┌───────────────────────────────────────────────┐
  │  │ WebviewMessageRouter (extension host)         │
  │  │  - TERMINAL_INPUT  → ptyManager.writeToSession│
  │  │  - TERMINAL_RESIZE → ptyManager.resizeSession │
  │  │  - TERMINAL_SPAWN_SHELL → ptyManager.spawnShell│
  │  └───────────────┬───────────────────────────────┘
  │                  │
  │                  ▼
  │  ┌───────────────────────────────────────────────┐
  │  │ PtyProcessManager (singleton)                 │
  │  │  - sessions: Map<sessionId, PtySession>       │
  │  │  - spawnPty() / spawnShell()                  │
  │  │  - writeToSession() / resizeSession()         │
  │  │  - killSession() / restartShellSession()      │
  │  │                                               │
  │  │  ┌─────────────────────────────────────────┐  │
  │  │  │ PtySession                              │  │
  │  │  │  - pty: IPty (node-pty)                │  │
  │  │  │  - reconnectBuffer: string[]            │  │
  │  │  │  - bufferChunk() / clearReconnectBuffer()│ │
  │  │  └─────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────┘
```

---

## Key Components

### 1. `terminalRegistry` (webview, module-level)

**File:** `src/ui/webview-react/terminalRegistry.ts`

A module-level Map that owns all xterm.js `Terminal` instances. Lives **outside** the React component tree so xterm instances (canvas, WebGL context, scrollback buffers) survive React unmounts.

**RegistryEntry structure:**

```typescript
interface RegistryEntry {
  term: Terminal; // xterm.js Terminal instance
  fitAddon: FitAddon; // auto-fit to container
  domEl: HTMLElement; // root element (may be detached from DOM)
  inputCapture: InputCapture; // keystroke accumulator for ai-cli
  frozen: boolean; // true for ended ai-cli sessions
  onDataDisposable?: { dispose(): void }; // input routing listener
}
```

**Key:** `${workflowId}:${sessionId}` in a global Map.

**Methods:**

| Method                        | What it does                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `create(wf, sid)`             | Creates xterm Terminal + FitAddon + div element. Dynamic imports xterm modules. Applies VS Code theme/font.                            |
| `attach(wf, sid, container)`  | Appends `domEl` to container. On first call, opens terminal + loads WebGL addon. On subsequent calls, moves existing DOM element back. |
| `detach(wf, sid)`             | Removes `domEl` from document. xterm survives in JS heap with all scrollback intact.                                                   |
| `freeze(wf, sid)`             | Disposes `onDataDisposable`, sets `frozen=true`. Prevents input routing for ended ai-cli sessions.                                     |
| `clearAiCliSessions(wf, ids)` | Disposes and deletes entries for ai-cli sessions (called on new run start).                                                            |
| `clearSession(wf, sid)`       | Disposes and deletes a single entry (user-close for shell sessions).                                                                   |

### 2. `TerminalInstance` (webview, React component)

**File:** `src/ui/webview-react/components/output/TerminalInstance.tsx`

Mount-point manager for a single xterm session. Does **not** own the xterm lifecycle — delegates to `terminalRegistry`.

**Mount effect flow:**

1. `terminalRegistry.create()` — creates or retrieves registry entry
2. Flush `pendingOutput` from terminalStore (output that arrived before the xterm was ready)
3. `terminalRegistry.attach()` — inserts DOM element into container, loads WebGL on first open
4. Register `term.onData()` → sends `TERMINAL_INPUT` message to extension host
5. Create `ResizeObserver` → calls `fitAddon.fit()` + sends `TERMINAL_RESIZE`

**Unmount cleanup:**

1. Dispose `onDataDisposable` (prevents duplicate listeners on remount)
2. `terminalRegistry.detach()` — removes DOM element (xterm survives)
3. Disconnect ResizeObserver

**Visibility:** Controlled by `display: none` (not unmounting) for within-workflow rail switching.

**`viewerOnly` mode:** When a browser tab views a workflow whose terminal is owned by the VS Code panel, renders a static message instead of creating an xterm.

### 3. `TerminalView` (webview, React component)

**File:** `src/ui/webview-react/components/output/TerminalView.tsx`

Horizontal resizable layout:

- **Left panel** (`terminal-canvas`): All `TerminalInstance` components mounted, only active one visible via `display` CSS
- **Right panel** (`terminal-session-rail`): Resizable/collapsible session list

**Rail switching:** Only changes `activeSessionIds[workflowId]` in terminalStore → `TerminalInstance.isVisible` changes → `display: none` toggles. No attach/detach calls.

**Across-workflow switching:** `TerminalView` unmounts entirely → all `TerminalInstance` unmount effects fire → `detach()` called for every session → xterm instances survive in registry.

### 4. `terminalStore` (webview, Zustand)

**File:** `src/ui/webview-react/store/terminalStore.ts`

Manages per-workflow session metadata:

```typescript
interface TerminalSession {
  id: string;
  workflowId: string;
  stepName: string;
  kind: SessionKind; // 'ai-cli' | 'shell'
  promptNumber?: number;
  status: TerminalSessionStatus; // 'running' | 'completed' | 'failed'
  pendingOutput: string[]; // buffered before xterm mounts
  viewerOnly?: boolean; // secondary observer client
}
```

**State shape:**

- `sessions: Record<string, TerminalSession[]>` — workflowId → ordered list
- `activeSessionIds: Record<string, string | null>` — workflowId → active sessionId

### 5. `PtyProcessManager` (extension host, singleton)

**File:** `src/flightpath/harness/PtyProcessManager.ts`

Manages native node-pty processes. Spawns, routes I/O, and tracks sessions.

**PtySession structure:**

```typescript
class PtySession {
  readonly id: string;
  readonly workflowId: string;
  readonly stepName: string;
  readonly kind: SessionKind;
  readonly pty: IPty; // native node-pty instance
  status: TerminalSessionStatus;
  readonly reconnectBuffer: string[]; // for webview reconnection
  private reconnectBufferSize = 0;

  bufferChunk(chunk: string); // ring buffer (max 50KB)
  clearReconnectBuffer(); // called after flush
}
```

**Reconnect buffer:** Every PTY output chunk is buffered in a ring buffer (max 50,000 bytes). When a webview reconnects (reload, panel reposition), this buffer is replayed immediately so the user sees previous output without waiting for new PTY data.

### 6. `WebviewMessageRouter` (extension host)

**File:** `src/ui/WebviewMessageRouter.ts`

Routes terminal messages between webview and PTY manager:

| Message                  | Direction           | Handler                                       |
| ------------------------ | ------------------- | --------------------------------------------- |
| `TERMINAL_STARTED`       | Extension → Webview | Registers session in terminalStore + rail     |
| `TERMINAL_OUTPUT`        | Extension → Webview | Writes to xterm directly (no React re-render) |
| `TERMINAL_ENDED`         | Extension → Webview | Freezes registry entry, updates rail status   |
| `TERMINAL_INPUT`         | Webview → Extension | `ptyManager.writeToSession()`                 |
| `TERMINAL_RESIZE`        | Webview → Extension | `ptyManager.resizeSession()`                  |
| `TERMINAL_SPAWN_SHELL`   | Webview → Extension | `ptyManager.spawnShell()`                     |
| `TERMINAL_RESTART_SHELL` | Webview → Extension | `ptyManager.restartShellSession()`            |
| `TERMINAL_CLOSE_SHELL`   | Webview → Extension | Kills PTY, clears registry + store            |

### 7. Terminal Message Handlers (webview)

**File:** `src/ui/webview-react/hooks/terminalMessageHandlers.ts`

- **TERMINAL_OUTPUT:** If xterm exists in registry → `entry.term.write(data)` (zero React overhead). If not yet mounted → buffers in terminalStore `pendingOutput`, flushed on mount.
- **TERMINAL_STARTED:** Registers session in terminalStore. For ai-cli, clears previous ai-cli session (only one per workflow at a time). Auto-switches to Terminal tab.
- **TERMINAL_ENDED:** Updates session status, freezes registry entry for ai-cli, auto-switches to Output tab if no shell sessions remain.

---

## Lifecycle: Normal Flow

### AI CLI Session Startup

```
1. CliIntegration (extension host) spawns AI CLI with interactive mode
   → PtyProcessManager.spawnPty()
   → Creates PtySession with reconnectBuffer

2. Extension host posts TERMINAL_STARTED to webview
   → terminalStore.addSession()
   → uiStore.setTerminalSessionActive(workflowId, true)

3. Extension host streams TERMINAL_OUTPUT messages
   → If TerminalInstance mounted: entry.term.write(data) immediately
   → If not yet mounted: terminalStore.pushPendingOutput()

4. TerminalInstance mount effect fires
   → terminalRegistry.create() — creates xterm
   → Flushes pendingOutput from terminalStore
   → terminalRegistry.attach() — inserts DOM element, opens terminal
   → Registers term.onData → sends TERMINAL_INPUT to extension

5. AI CLI process exits
   → Extension host posts TERMINAL_ENDED
   → terminalStore.endSession()
   → terminalRegistry.freeze() — disables onData
   → FrozenOverlay shown
```

### Shell Session (user-spawned)

```
1. User clicks "+" in terminal rail
   → Webview sends TERMINAL_SPAWN_SHELL
   → PtyProcessManager.spawnShell()
   → Posts TERMINAL_STARTED + streams TERMINAL_OUTPUT

2. User clicks × on shell session
   → Webview sends TERMINAL_CLOSE_SHELL
   → PtyProcessManager.killSession()
   → terminalRegistry.clearSession()
   → terminalStore.removeSession()
```

---

## Reconnection Scenarios

### Scenario A: Webview Reload (F5 / panel reposition)

**What happens:**

1. Webview JS context destroyed → all React components, stores, registry gone
2. Extension host PTY sessions **survive** (running in extension host process)
3. Webview reinitializes → `WebviewMessageRouter` handles `CLIENT_READY`
4. Router iterates `ptyManager.getAllSessions()` → resends `TERMINAL_STARTED` + replay reconnect buffer for every session

**Result:** Terminal output is restored from the reconnect buffer. The xterm DOM is recreated. Input routing is re-registered via mount effects.

**Code path:** `WebviewMessageRouter.ts` lines ~227-248

```typescript
const ptyManager = getPtyProcessManager();
if (ptyManager) {
  for (const session of ptyManager.getAllSessions()) {
    this.emitMessage({ type: MESSAGE_TYPES.TERMINAL_STARTED, ... });
    for (const chunk of session.reconnectBuffer) {
      this.emitMessage({ type: MESSAGE_TYPES.TERMINAL_OUTPUT, ... });
    }
    session.clearReconnectBuffer();
  }
}
```

### Scenario B: Switch Workflow (workflow A running → switch to B → switch back to A)

**What happens:**

1. User switches from workflow A to workflow B
2. `ACTIVE_WORKFLOW_CHANGED` message fires → `uiStore.activeWorkflowId` changes
3. `TerminalView` for workflow A **unmounts** → all `TerminalInstance` unmount effects fire → `terminalRegistry.detach()` for each session
4. `TerminalView` for workflow B mounts → creates/attaches xterm for B's sessions
5. User switches back to workflow A
6. `ACTIVE_WORKFLOW_CHANGED` → `uiStore.activeWorkflowId` changes to A
7. `TerminalView` for workflow A **remounts** → `TerminalInstance` mount effects fire

**🐛 THE BUG — what goes wrong at step 7:**

The `TerminalInstance` mount effect creates/retrieves the registry entry, attaches the DOM, and flushes pending output. **However**, no new `TERMINAL_STARTED` message is sent from the extension host when switching back to workflow A. The terminalStore for workflow A still has the session entries (they were never removed), and the xterm registry entries still exist (they were detached, not disposed).

The issue is that **the reconnect buffer is only flushed once on webview reload** (scenario A). For workflow switching (scenario B), there is no replay mechanism because the extension host doesn't know the webview switched workflows — it only knows about the PTY sessions it manages.

**What's missing:** When the webview switches back to workflow A, the `TerminalInstance` mount effect should either:

1. Request a replay from the extension host (send a message asking for previous output), or
2. Have the extension host proactively replay the reconnect buffer on `ACTIVE_WORKFLOW_CHANGED`, or
3. The webview should retain the xterm state in the registry and reattach it with scrollback intact (which it already does — the issue may be that the PTY is no longer sending output)

### Scenario C: Browser Tab Viewing Different Workflow

**What happens:**

1. Browser tab 1 views workflow A → `replayWorkflowStateTo(A, send, client1)`
2. Browser tab 2 views workflow B → `replayWorkflowStateTo(B, send, client2)`
3. Each tab gets `TERMINAL_STARTED` + reconnect buffer for its viewed workflow

**Result:** Works correctly. Each client independently requests state replay for its chosen workflow.

---

## Known Issues

### Issue 1: Workflow Switch Doesn't Reconnect Terminal

**Symptom:** Switch away from a running workflow, then switch back — terminal is blank.

**Root cause:** The `TerminalInstance` mount effect correctly re-attaches the xterm DOM element from the registry (scrollback preserved). However, the PTY session on the extension host side continues to stream `TERMINAL_OUTPUT` messages only to the **current active workflow's** webview connection. When you switch workflows, the extension host doesn't know to resume streaming output for the previously-active workflow.

**The disconnect:** `TERMINAL_OUTPUT` messages are posted by `CliTransportCoordinator` → `ptyPostMessage()` → broadcast to the webview. The broadcast goes to whichever workflow the orchestrator considers "active." Switching workflows in the UI doesn't change which PTY session is active on the extension host side.

**Potential fixes:**

1. **On workflow switch, request replay:** When `TerminalInstance` mounts for a session that already exists in the registry, send a `REQUEST_TERMINAL_REPLAY` message to the extension host, which replays the reconnect buffer for that session.
2. **Broadcast to all clients:** Change the output routing so `TERMINAL_OUTPUT` is broadcast to all connected webview clients for the relevant workflowId, not just the active one.
3. **Active workflow sync:** When `ACTIVE_WORKFLOW_CHANGED` fires, have the extension host check if there's an active PTY session for that workflow and replay its reconnect buffer.

### Issue 2: Panel Reposition Reloads Everything

**Symptom:** Moving the webview panel (e.g., from sidebar to activity bar) causes VS Code to destroy and recreate the webview → all xterm instances lost.

**Root cause:** VS Code's webview lifecycle management destroys the `<webview>` element when the panel changes position. The webview's JS context is completely destroyed and recreated. The `CLIENT_READY` handler in `WebviewMessageRouter` handles this correctly — it replays all active PTY sessions from the reconnect buffer.

**Why this actually works:** The reconnect buffer mechanism is designed for exactly this scenario. The PTY processes survive in the extension host, the ring buffer holds recent output, and `CLIENT_READY` replays everything.

**Potential improvements:**

1. **Increase reconnect buffer size:** 50KB may not be enough for long-running sessions. Consider making it configurable or using a larger default.
2. **Persist scrollback:** If the PTY has been running for a while, the 50KB ring buffer may have dropped early output. Consider a larger buffer or a disk-backed buffer for long sessions.

---

## Output Routing Detail

### Extension Host → Webview (TERMINAL_OUTPUT)

```
PTY onData(chunk)
  → session.bufferChunk(chunk)  // ring buffer in PtySession
  → postMessage({ TERMINAL_OUTPUT, workflowId, sessionId, data: chunk })
    → DashboardBroadcastHub.postTerminalOutput(workflowId, sessionId, chunk)
      → For each connected client viewing this workflow:
        → client.send({ TERMINAL_OUTPUT, workflowId, sessionId, data: chunk })
          → terminalMessageHandlers.TERMINAL_OUTPUT
            → entry = terminalRegistry.get(workflowId, sessionId)
            → if entry: entry.term.write(chunk)  // direct xterm write
            → else: terminalStore.pushPendingOutput()  // buffer until mount
```

### Webview → Extension Host (TERMINAL_INPUT)

```
TerminalInstance mount effect
  → entry.term.onData(input)
    → sendMessage(TERMINAL_INPUT, { workflowId, sessionId, data: input })
      → WebviewMessageRouter.TERMINAL_INPUT handler
        → ptyManager.writeToSession(sessionId, data)
          → session.pty.write(data)  // sends bytes to native PTY
```

### Resize (TERMINAL_RESIZE)

```
TerminalInstance ResizeObserver
  → fitAddon.fit()  // fits xterm to container
  → sendMessage(TERMINAL_RESIZE, { workflowId, sessionId, cols, rows })
    → WebviewMessageRouter.TERMINAL_RESIZE handler
      → ptyManager.resizeSession(sessionId, cols, rows)
        → session.pty.resize(cols, rows)  // notifies child process via SIGWINCH
```

---

## Session Kinds

| Kind     | Spawned by                        | Lifecycle                                       | Survives run boundary?        |
| -------- | --------------------------------- | ----------------------------------------------- | ----------------------------- |
| `ai-cli` | `CliIntegration` interactive mode | Frozen on process exit, disposed on new run     | No — cleared on new run       |
| `shell`  | User clicking "+" in rail         | Running until user closes or extension disposed | Yes — survives run boundaries |

---

## File Reference

| File                                                          | Role                                          |
| ------------------------------------------------------------- | --------------------------------------------- |
| `src/ui/webview-react/terminalRegistry.ts`                    | Module-level xterm owner (outside React tree) |
| `src/ui/webview-react/components/output/TerminalInstance.tsx` | Mount-point manager for xterm DOM             |
| `src/ui/webview-react/components/output/TerminalView.tsx`     | Horizontal layout: canvas + session rail      |
| `src/ui/webview-react/store/terminalStore.ts`                 | Zustand store for session metadata            |
| `src/ui/webview-react/hooks/terminalMessageHandlers.ts`       | Webview-side message handlers                 |
| `src/flightpath/harness/PtyProcessManager.ts`                 | Extension host PTY process manager            |
| `src/ui/WebviewMessageRouter.ts`                              | Message routing (extension host ↔ webview)    |
| `src/ui/DashboardBroadcastHub.ts`                             | Fan-out hub for terminal output to clients    |
| `src/flightpath/harness/shared/CliTransportCoordinator.ts`    | Spawns interactive PTY, routes I/O            |

---

## Recommendations for Fixing Workflow Switch Reconnection

### Option 1: Replay on Active Workflow Change (Recommended)

When `ACTIVE_WORKFLOW_CHANGED` fires, have the extension host check for active PTY sessions for the newly-active workflow and replay their reconnect buffers:

**Extension host side** (`WebviewMessageRouter.ts`):

```typescript
table.set(MESSAGE_TYPES.ACTIVE_WORKFLOW_CHANGED, async (msg) => {
  const ptyManager = getPtyProcessManager();
  if (!ptyManager || !msg.workflowId) return;
  const sessions = ptyManager.getSessionsForWorkflow(msg.workflowId);
  for (const session of sessions) {
    // Only replay if session is still running
    if (session.status === TERMINAL_SESSION_STATUS.RUNNING) {
      this.emitMessage({ type: MESSAGE_TYPES.TERMINAL_STARTED, ... });
      for (const chunk of session.reconnectBuffer) {
        this.emitMessage({ type: MESSAGE_TYPES.TERMINAL_OUTPUT, ... });
      }
    }
  }
});
```

**Webview side:** The `terminalMessageHandlers` already handle `TERMINAL_STARTED` by registering the session. If the session already exists (from before the switch), the store's `addSession` would need to be idempotent or updated to handle re-registration.

### Option 2: Registry Retention + Re-attach Only

Since `terminalRegistry` already preserves xterm instances across React unmounts, the issue may simply be that no new `TERMINAL_OUTPUT` arrives after re-switching (because the PTY is idle). In this case, the scrollback should already be intact — the terminal would just appear blank because there's no new content to display.

**Investigation needed:** Determine whether the xterm scrollback is truly lost (registry entry disposed) or whether the terminal is blank because the PTY stopped sending output after the workflow switch.

### Option 3: Persistent Output Log

Add a per-session output log (beyond the reconnect buffer) that persists in the extension host. On reconnection, replay the full log instead of just the last 50KB.

---

## VS Code Webview Lifecycle Notes

VS Code manages webview elements as follows:

- **Panel position change:** Destroys and recreates the `<webview>` element. JS context lost. Extension host receives `onDidDispose()` + new `onDidChangeViewState()` with `active=true`.
- **Tab switch (within same panel):** Webview is hidden/shown. JS context preserved. `onDidChangeViewState()` fires with `visible` flag.
- **Extension reload (F5):** Full destruction. Extension host restarts.

FlightPath's `WebviewMessageRouter` handles reload via the `CLIENT_READY` message, which triggers replay of all active PTY sessions from their reconnect buffers.
