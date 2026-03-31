# Embedded Terminal Plan (xterm.js + node-pty)

## Overview

Replace the VS Code terminal tab context-switch with an embedded xterm.js terminal inside the
FlightPath webview. The interactive AI CLI session renders in the sidebar panel directly —
no tab switching, no focus loss. The existing log-processing pipeline (structured output,
undo/redo, diff views) runs untouched in parallel; the terminal is an additive view, not
a replacement.

This plan uses **node-pty as the only backend** — no VS Code terminal bridge. The hidden
`vscode.Terminal` is eliminated entirely. node-pty spawns the AI CLI process directly,
giving byte-accurate I/O and a clean path to the standalone server.

This architecture also directly enables `PARALLEL_STEPS_PLAN.md`: each parallel step
gets its own node-pty instance and its own xterm.js terminal instance. The terminal tab
shows a VS Code-style session selector rail when multiple terminals are running concurrently.

---

## Interactive Input: Fully Bidirectional

A real PTY (via `node-pty`) supports full bidirectional I/O. The xterm.js `Terminal` instance:

- **Renders output** — every byte the AI CLI writes (ANSI colors, cursor movement, TUI
  redraws) is passed to `term.write(chunk)` and rendered correctly in the browser canvas.
- **Accepts input** — `term.onData(handler)` fires on every keypress, including control
  sequences (Ctrl+C, Ctrl+D, arrow keys). The handler sends those bytes back to the PTY
  stdin via `pty.write(input)`. The AI CLI receives them as if the user typed in a real terminal.

This means the user can:

- Watch the AI CLI's TUI render in the FlightPath sidebar
- Type responses to AI prompts (e.g., `y` to approve a file change)
- Send Ctrl+C to interrupt
- Navigate history with arrow keys

All without leaving the FlightPath panel.

---

## Why Keep Both Views

The log-processing pipeline runs during interactive mode today. `CliIntegration` reads the
AI CLI's log file / session hook output in parallel with the terminal session, building
`streamingChunks`, `cliOutputs`, `workspaceSnapshots`, and the structured output events
that power undo/redo and diff views. **This continues unchanged.**

During interactive execution there are therefore two live views of the same session:

| View             | What it shows                                      | When it is useful                        |
| ---------------- | -------------------------------------------------- | ---------------------------------------- |
| **Output tab**   | Structured output: diffs, tool calls, undo buttons | Reviewing what changed, navigating steps |
| **Terminal tab** | Raw TUI output, ANSI-accurate, bidirectional input | Watching the AI work, typing responses   |

**Collapsed output panel:** If the user collapses the Output section or the FlightPath
sidebar, the embedded terminal is no longer visible. This is intentional — the user chose
to collapse it. The node-pty process continues running unaffected; the terminal is restored
with its scrollback when the user re-expands.

---

## Session Types

The Terminal tab hosts two distinct kinds of PTY sessions, both managed by `CliProcessManager`
and displayed in the same session rail:

| Kind     | Spawned by                    | Lifetime                | On exit                       |
| -------- | ----------------------------- | ----------------------- | ----------------------------- |
| `ai-cli` | FlightPath (`CliIntegration`) | Tied to harness process | Freeze (read-only scrollback) |
| `shell`  | User (via "+" button)         | User-owned              | Show "Restart" in rail        |

**AI CLI sessions** are created automatically when a workflow step runs in interactive mode.
When the PTY process exits — whether the AI CLI finishes naturally, the user types `exit`,
or Ctrl+C terminates the process — the session is frozen: `term.onData` is unregistered
so keystrokes no longer route to the dead PTY, and a subtle "Process exited" dim overlay
appears on the xterm canvas. The scrollback remains fully readable and copy-pasteable.
The rail entry shows ✓/✗ status and stays visible until the next run starts.

**Shell sessions** are user-initiated. Clicking "+" in the session rail spawns `$SHELL`
(or `cmd.exe` on Windows) in a new PTY rooted at the workspace directory. The user can
run any command — `npm test`, `git log`, file inspection — without leaving the FlightPath
panel. When the user types `exit`, the shell exits and the rail entry shows a "Restart"
button rather than disappearing. Shell sessions are **not** cleared when a new workflow run
starts — the user owns their lifetime and must close them explicitly. In the standalone
server context, shell sessions become first-class terminals for general dev work.

---

## UI Design: Output Section Header

### Current header

```
[ v  terminal  OUTPUT ]  [font-/+]              [run selector]  [diff toggle]  [export]
 ^^^^^^^^^^^^^^^^^^^^^^^^^
 entire left block is one collapse click target
```

### Proposed header

```
[ v  terminal ]  [ OUTPUT | TERMINAL* ]  [font-/+]    [run selector]  [diff toggle]  [export]
 ^^^^^^^^^^^^^^    ^^^^^^^^^^^^^^^^^^^^   ^^^^^^^^^     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 collapse only     tab buttons            Output-only   Output-only controls (hidden on Terminal tab)
```

**Key layout decisions:**

1. The collapse affordance (chevron + terminal icon) becomes a narrower click target — just
   the icon cluster, not the whole left group. This is necessary because the tab buttons are
   now siblings, not children of the collapse target.

2. The tab buttons (`OUTPUT` / `TERMINAL`) sit immediately after the icon, still on the left.
   They are visually integrated into the header label area, not in a separate tab bar. The
   overall header height stays at `h-[30px]`.

3. Font size stepper, run selector, diff toggle, and export button are all **Output-tab-only**
   controls. When Terminal tab is active they are hidden (they don't apply to raw terminal output).

4. The `TERMINAL` tab is only rendered when any terminal session exists for this workflow.
   Before any interactive session starts, only the `OUTPUT` tab label is shown — the header
   looks identical to today.

**Tab visibility rules:**

| State                     | Output tab                                   | Terminal tab                                       |
| ------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Idle, no session          | Shown, active (single label, no tab styling) | Hidden                                             |
| Interactive mode running  | Tab styling appears                          | Shown + live badge                                 |
| Interactive mode complete | Shown                                        | Shown (frozen scrollback preserved until next run) |
| Headless mode (any state) | Shown, active                                | Hidden                                             |
| User shell session exists | Shown                                        | Shown (shell sessions survive run boundaries)      |

**Auto-switch behavior:**

- When interactive mode begins → automatically switch to Terminal tab
- When interactive mode completes → automatically switch back to Output tab
- User can manually switch between tabs at any time during execution

---

## Terminal Tab Layout

The session rail is **always visible** when the Terminal tab is active. It does not hide
when there is only one session — it provides the permanent home for the "+" button and
matches VS Code's own terminal panel behavior where the terminal list is always shown.

```
┌──────────────────────────────────────────────────────┐
│ [ v terminal ] [ OUTPUT | TERMINAL● ]                 │  ← header
├───────────────────────────────────┬──────────────────┤
│                                   │ ● research-auth   │  ← ai-cli session (running)
│                                   │ ✓ research-db     │  ← ai-cli session (frozen)
│   xterm.js canvas                 │ ✗ research-perf   │  ← ai-cli session (frozen, failed)
│   (fills remaining space)         │ ──────────────── │
│                                   │  zsh        ↺    │  ← shell session (↺ = Restart)
│                                   │ ──────────────── │
│                                   │ [+] New Terminal  │  ← always at bottom
└───────────────────────────────────┴──────────────────┘
```

**Rail anatomy:**

- Rail width: fixed at ~140px; terminal canvas takes remaining flex width
- Each entry: kind indicator (● running / ✓ done / ✗ failed / dim frozen) + step name
- Frozen AI CLI entries: dim text, no active indicator
- Ended shell entries: dim text + "↺" restart button
- Active entry: highlighted background
- "+" button: always at bottom, sends `TERMINAL_SPAWN_SHELL` message

**Terminal canvas sizing:**
The canvas fills the full available height of the Output panel and resizes continuously
with it (panel separator drag, window resize, adjacent panel collapse/expand). See
Terminal Sizing section below.

**Empty state** (no sessions yet):

```
┌──────────────────────────────────────────────────────┐
│ [ v terminal ] [ OUTPUT | TERMINAL ]                  │
├───────────────────────────────────┬──────────────────┤
│                                   │                   │
│  Waiting for interactive          │ [+] New Terminal  │
│  session...                       │                   │
│                                   │                   │
└───────────────────────────────────┴──────────────────┘
```

---

## Architecture

### PTY Management (Extension Host)

`CliProcessManager` manages all PTY sessions — both AI CLI and user shell — and implements
`vscode.Disposable` for clean extension deactivation:

```typescript
import * as pty from 'node-pty';

type SessionKind = 'ai-cli' | 'shell';

const DEFAULT_COLS = 220;
const DEFAULT_ROWS = 50;

class PtySession {
  readonly id: string;
  readonly workflowId: string;
  readonly stepName: string;
  readonly kind: SessionKind;
  readonly pty: pty.IPty;
  status: 'running' | 'completed' | 'failed';

  // Ring buffer for reconnect: recent output replayed when webview reconnects
  readonly reconnectBuffer: string[] = [];
  private reconnectBufferSize = 0;
  private static readonly RECONNECT_BUFFER_MAX = 50_000; // bytes

  bufferChunk(chunk: string): void {
    this.reconnectBuffer.push(chunk);
    this.reconnectBufferSize += chunk.length;
    while (this.reconnectBufferSize > PtySession.RECONNECT_BUFFER_MAX) {
      const dropped = this.reconnectBuffer.shift()!;
      this.reconnectBufferSize -= dropped.length;
    }
  }
}

class CliProcessManager implements vscode.Disposable {
  private sessions = new Map<string, PtySession>();

  spawnPty(command: string, args: string[], opts: {
    workflowId: string; stepName: string; kind: SessionKind;
    cwd: string; env: NodeJS.ProcessEnv;
  }): PtySession { ... }

  spawnShell(opts: { workflowId: string; cwd: string }): PtySession {
    const shell = process.env.SHELL
      ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
    return this.spawnPty(shell, [], {
      workflowId: opts.workflowId,
      stepName: shell,
      kind: 'shell',
      cwd: opts.cwd,
      env: process.env,
    });
  }

  writeToSession(sessionId: string, data: string): void { ... }
  resizeSession(sessionId: string, cols: number, rows: number): void { ... }
  killSession(sessionId: string): void { ... }
  restartShellSession(sessionId: string): void { ... } // kills + respawns same shell

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.pty.kill();
    }
    this.sessions.clear();
  }
}
```

**PTY deactivation cleanup:** `CliProcessManager` is registered with `context.subscriptions`
in `extension.ts`. VS Code calls `dispose()` automatically on extension deactivation
(window close, extension reload, remote disconnect), killing all PTY processes cleanly.

```typescript
// extension.ts
context.subscriptions.push(cliProcessManager);
```

**I/O flow:**

```
CliIntegration.executeInTerminal()
    ↓
CliProcessManager.spawnPty(command, args, { workflowId, stepName, kind: 'ai-cli', cwd, env,
                                            cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
    ↓
node-pty.spawn(...)
    ↓
pty.onData(chunk) ──────────────────────────────────────────────────────────────────────┐
    |                                                                                    │
    ├── session.bufferChunk(chunk)   [reconnect ring buffer]                             │
    ├── (existing log pipeline) → log file / hook output → Output tab                   │
    └── webview: postMessage({ type: TERMINAL_OUTPUT, workflowId, sessionId, data: chunk })
                                                                                        │
User input (ai-cli session, while running):                                             │
xterm.onData(input) → postMessage({ type: TERMINAL_INPUT, workflowId, sessionId, data })│
    ↓                                                                                   │
CliProcessManager.writeToSession(sessionId, input) → pty.write(input)  ←──────────────┘

User input (ai-cli session, frozen after exit): onData unregistered — input discarded

User input (shell session):
xterm.onData(input) → postMessage({ type: TERMINAL_INPUT, workflowId, sessionId, data })
    ↓
CliProcessManager.writeToSession(sessionId, input) → pty.write(input)

Terminal resize:
xterm ResizeObserver → fitAddon.fit() → postMessage({ type: TERMINAL_RESIZE, workflowId, sessionId, cols, rows })
    ↓
CliProcessManager.resizeSession(sessionId, cols, rows) → pty.resize(cols, rows)
```

**Session exit handling:**

When `pty.onExit` fires (any exit cause: natural completion, `exit` command, Ctrl+C):

- Extension posts `TERMINAL_ENDED` with `{ workflowId, sessionId, kind, exitCode }`
- `kind: 'ai-cli'`: webview freezes the xterm (unregisters `onData`), shows "Process exited" overlay
- `kind: 'shell'`: webview marks session as ended, shows "↺" restart button in rail entry
- PTY object is released; the node-pty process is gone
- Reconnect buffer is retained until `clearWorkflow()` (ai-cli) or explicit close (shell)

**Initial PTY dimensions:** PTYs are spawned at `DEFAULT_COLS × DEFAULT_ROWS` (220×50).
Spawning too narrow causes hard line-wrapping artifacts that survive resize. The
`TerminalInstance` `ResizeObserver` fires immediately on first mount and corrects the PTY
to actual panel dimensions before any user interaction.

### Webview Reconnection

The webview JS context can be destroyed and recreated (VS Code panel close/reopen,
extension host reload). When this happens, `terminalRegistry` and all Zustand stores are
wiped, but node-pty sessions in the extension host are still running.

**Reconnection protocol:**

1. Webview sends `READY` (existing behavior).
2. Extension's `READY` handler — in addition to sending current workflow state — iterates
   all active `PtySession`s in `CliProcessManager` and sends:
   - `TERMINAL_STARTED` for each, to reconstruct `terminalStore` in the fresh webview
   - Immediately followed by each session's reconnect buffer flushed as `TERMINAL_OUTPUT`
     messages
   - Then clears each session's reconnect buffer
3. `TERMINAL_OUTPUT` streaming resumes normally — new output flows to the reconstructed
   xterm instances.
4. **Scrollback prior to the reconnect buffer window is lost.** Fresh xterm instances
   start from the buffered recent output (~50KB per session). This is accepted behavior —
   ANSI state replay is lossy for TUI apps using alternate screen buffers.

### Terminal Registry (Webview — Imperative, Outside React)

The central challenge: when the user switches between workflow tabs, the inactive
workflow's React component tree unmounts — which would destroy any xterm.js instances
held inside it and lose their scrollback buffers.

The solution is a **module-level Terminal Registry** that lives completely outside the
React component tree. xterm.js `Terminal` objects are created and owned by the registry.
`TerminalInstance` components are mount-point managers that attach and detach the
registry's xterm DOM elements into whatever container is currently visible.

```typescript
// src/ui/webview-react/terminalRegistry.ts

interface RegistryEntry {
  term: Terminal;
  fitAddon: FitAddon;
  domEl: HTMLElement;      // root element xterm rendered into; may be detached from DOM
  inputCapture: InputCapture;
  frozen: boolean;         // true for ended ai-cli sessions; input disabled
}

// key: `${workflowId}:${sessionId}`
const registry = new Map<string, RegistryEntry>();

export const terminalRegistry = {
  create(workflowId: string, sessionId: string, theme: ITheme): RegistryEntry {
    const term = new Terminal({ theme, scrollback: 5000, ... });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const domEl = document.createElement('div');
    domEl.style.cssText = 'width:100%;height:100%';
    const entry: RegistryEntry = { term, fitAddon, domEl, inputCapture: new InputCapture(), frozen: false };
    registry.set(`${workflowId}:${sessionId}`, entry);
    return entry;
  },

  // Called by TerminalInstance on mount (first time or after workflow switch)
  attach(workflowId: string, sessionId: string, container: HTMLElement): void {
    const entry = registry.get(`${workflowId}:${sessionId}`);
    if (!entry) return;
    if (!entry.term.element) {
      container.appendChild(entry.domEl);
      entry.term.open(entry.domEl);
    } else {
      container.appendChild(entry.domEl);
    }
    requestAnimationFrame(() => entry.fitAddon.fit());
  },

  // Called by TerminalInstance on unmount (workflow tab switch away)
  detach(workflowId: string, sessionId: string): void {
    registry.get(`${workflowId}:${sessionId}`)?.domEl.remove();
  },

  // Called when TERMINAL_ENDED received for an ai-cli session.
  // Unregisters onData so the frozen terminal ignores keystrokes.
  freeze(workflowId: string, sessionId: string): void {
    const entry = registry.get(`${workflowId}:${sessionId}`);
    if (!entry) return;
    entry.frozen = true;
    // TerminalInstance checks entry.frozen before registering onData on remount
  },

  get(workflowId: string, sessionId: string): RegistryEntry | undefined {
    return registry.get(`${workflowId}:${sessionId}`);
  },

  // Called on new run start — clears ai-cli sessions only; shell sessions survive
  clearAiCliSessions(workflowId: string, sessions: TerminalSession[]): void {
    for (const session of sessions) {
      if (session.kind !== 'ai-cli') continue;
      const key = `${workflowId}:${session.id}`;
      registry.get(key)?.term.dispose();
      registry.delete(key);
    }
  },

  // Called when user explicitly closes a shell session
  clearSession(workflowId: string, sessionId: string): void {
    const key = `${workflowId}:${sessionId}`;
    registry.get(key)?.term.dispose();
    registry.delete(key);
  },
};
```

**Two distinct switching scenarios:**

- **Within-workflow (rail switching):** all `TerminalInstance` components remain mounted;
  `isVisible` prop toggles `display: none`. No `attach`/`detach` calls.
- **Across-workflow (workflow tab switching):** `TerminalView` and children unmount →
  `detach()` removes DOM element from document (xterm object and scrollback survive in
  JS heap) → on return, `attach()` moves the existing DOM element back in.

**Why module-level (not Zustand):**
xterm.js Terminal objects hold a canvas, a WebGL context, and large internal buffers.
They are non-serializable and must never flow through React state or Zustand.

### Terminal Sizing

The terminal must fill the full available area of the Output panel and resize with it.

`TerminalInstance` sets its container div to `width: 100%; height: 100%` and attaches a
`ResizeObserver`. Whenever the container resizes — panel separator drag, window resize,
adjacent panel collapse/expand — the observer fires:

```typescript
const observer = new ResizeObserver(() => {
  const entry = terminalRegistry.get(workflowId, sessionId);
  if (!entry) return;
  entry.fitAddon.fit();
  const { cols, rows } = entry.term;
  postMessage({ type: TERMINAL_RESIZE, workflowId, sessionId, cols, rows });
});
observer.observe(containerRef.current);
```

`fitAddon.fit()` reads the container's pixel dimensions, computes integer cols/rows from
character cell size, and resizes the xterm.js Terminal. The resulting dimensions are sent
to the extension host to resize the PTY. The observer fires immediately on first mount,
correcting the PTY from its spawn-time default (220×50) to actual panel dimensions.

### Standalone Server

For the standalone server (future), the transport switches from `postMessage` to WebSocket:

```
pty.onData(chunk) → ws.send({ type: TERMINAL_OUTPUT, workflowId, sessionId, data: chunk })
xterm.onData(input) → ws.send({ type: TERMINAL_INPUT, workflowId, sessionId, data: input })
```

Shell sessions are particularly valuable in the standalone server context — they provide
a full terminal for any dev work without requiring a separate terminal application.
No changes to `TerminalView`, `TerminalInstance`, or `terminalRegistry`.

---

## New Message Types

Add to `src/types/DashboardConstants.ts`:

```typescript
// Terminal I/O — bidirectional between extension/server and webview
TERMINAL_OUTPUT:       "terminalOutput",      // extension → webview: { workflowId, sessionId, data }
TERMINAL_INPUT:        "terminalInput",       // webview → extension: { workflowId, sessionId, data }
TERMINAL_RESIZE:       "terminalResize",      // webview → extension: { workflowId, sessionId, cols, rows }
TERMINAL_STARTED:      "terminalStarted",     // extension → webview: { workflowId, sessionId, stepName, kind }
TERMINAL_ENDED:        "terminalEnded",       // extension → webview: { workflowId, sessionId, kind, exitCode }
TERMINAL_SPAWN_SHELL:  "terminalSpawnShell",  // webview → extension: { workflowId, cwd }
TERMINAL_RESTART_SHELL:"terminalRestartShell",// webview → extension: { workflowId, sessionId }
TERMINAL_CLOSE_SHELL:  "terminalCloseShell",  // webview → extension: { workflowId, sessionId }
```

---

## New Store State

### `uiStore` additions

```typescript
// Per-workflow output section tab state
// getActiveOutputTab returns 'output' for any workflowId not yet in the map
activeOutputTabs: Record<string, 'output' | 'terminal'>
setActiveOutputTab: (workflowId: string, tab: 'output' | 'terminal') => void
getActiveOutputTab: (workflowId: string) => 'output' | 'terminal'

terminalActiveWorkflows: Set<string>   // workflowIds with at least one running session
setTerminalSessionActive: (workflowId: string, active: boolean) => void
```

### `terminalStore` (new, separate Zustand store)

Tracks session metadata and pre-mount output buffers. Does NOT store xterm.js objects.

```typescript
type SessionKind = "ai-cli" | "shell";

interface TerminalSession {
  id: string;
  workflowId: string;
  stepName: string;
  kind: SessionKind;
  status: "running" | "completed" | "failed";
  pendingOutput: string[]; // chunks buffered before TerminalInstance mounts
}

interface TerminalStore {
  sessions: Record<string, TerminalSession[]>; // workflowId → sessions
  activeSessionIds: Record<string, string | null>; // workflowId → active sessionId

  addSession: (session: TerminalSession) => void;
  endSession: (workflowId: string, sessionId: string, exitCode: number) => void;
  setActiveSession: (workflowId: string, sessionId: string) => void;
  removeSession: (workflowId: string, sessionId: string) => void; // explicit close

  pushPendingOutput: (
    workflowId: string,
    sessionId: string,
    chunk: string
  ) => void;
  clearPendingOutput: (workflowId: string, sessionId: string) => void;

  // Clears only ai-cli sessions; shell sessions survive run boundaries
  clearAiCliSessions: (workflowId: string) => void;
}
```

**Output routing in `useMessageHandler`:**

- `TERMINAL_OUTPUT`: if `terminalRegistry.get(workflowId, sessionId)` exists →
  `entry.term.write(chunk)` directly (no Zustand, no re-renders).
  If not yet created → `terminalStore.pushPendingOutput()`.
- `TerminalInstance` on mount: `create()` → `attach()` → flush `pendingOutput` →
  `clearPendingOutput()`.

---

## New React Components

### `TerminalInstance.tsx` (`src/ui/webview-react/components/output/`)

Mount-point manager. Delegates all xterm lifecycle to `terminalRegistry`.

```tsx
// Props:
//   workflowId: string
//   sessionId: string
//   kind: SessionKind
//   isVisible: boolean      // false = display:none (rail switching within workflow)
//
// Mount effect:
//   1. entry = terminalRegistry.create(workflowId, sessionId, theme)  [if not exists]
//   2. terminalRegistry.attach(workflowId, sessionId, containerRef.current)
//   3. Flush terminalStore pendingOutput → entry.term.write(chunk) for each chunk
//   4. terminalStore.clearPendingOutput(workflowId, sessionId)
//   5. If !entry.frozen:
//        entry.term.onData(input => {
//          postMessage(TERMINAL_INPUT, { workflowId, sessionId, data: input })
//          entry.inputCapture.accumulate(input)   // ad-hoc prompt capture (ai-cli only)
//        })
//   6. ResizeObserver on container → fitAddon.fit() + postMessage(TERMINAL_RESIZE, { cols, rows })
//      (fires immediately on mount, correcting PTY from 220×50 to real dimensions)
//
// Unmount effect:
//   terminalRegistry.detach(workflowId, sessionId)
//
// Renders:
//   - Container div: width:100% height:100%, display controlled by isVisible prop
//   - "Process exited" dim overlay when entry.frozen === true
```

### `TerminalView.tsx` (`src/ui/webview-react/components/output/`)

Per-workflow container. Always shows the session rail.

```tsx
// Props: workflowId: string
//
// Reads:
//   sessions = terminalStore.sessions[workflowId] ?? []
//   activeSessionId = terminalStore.activeSessionIds[workflowId]
//
// Layout: flex row, width:100% height:100%
//   - Left: terminal canvas area (flex-1, min-w-0)
//       One <TerminalInstance> per session (all mounted)
//       isVisible={session.id === activeSessionId}
//       Empty state shown when sessions.length === 0
//   - Right: session rail (fixed ~140px width, always visible)
//       Section: ai-cli sessions (if any)
//       Divider (if both ai-cli and shell sessions exist)
//       Section: shell sessions (if any)
//       [+] New Terminal button at bottom
//
// Rail entry for ai-cli session:
//   status indicator + step name
//   Frozen entries: dimmed, no indicator animation
//
// Rail entry for shell session (running):
//   shell name (e.g. "zsh") + click to activate
//
// Rail entry for shell session (ended):
//   dim shell name + "↺" restart button (postMessage TERMINAL_RESTART_SHELL)
//   + "×" close button (postMessage TERMINAL_CLOSE_SHELL)
//
// [+] button: postMessage(TERMINAL_SPAWN_SHELL, { workflowId, cwd: workspaceRoot })
```

### `OutputSection.tsx` header changes

```tsx
{
  /* Collapse trigger — chevron + icon only */
}
<div
  className="flex items-center gap-1 cursor-pointer select-none text-description-fg hover:text-foreground"
  onClick={toggleOutputCollapse}
  role="button"
  aria-label="Collapse output"
  tabIndex={0}
  onKeyDown={(e) => e.key === "Enter" && toggleOutputCollapse()}
>
  <i className="codicon codicon-chevron-right text-[12px] rotate-90" />
  <i className="codicon codicon-terminal text-[14px]" />
</div>;

{
  /* Tab buttons — shown when any terminal session exists for this workflow */
}
{
  showTerminalTab ? (
    <div className="flex items-center">
      <button
        className={`text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5
        ${
          activeOutputTab === "output"
            ? "text-foreground border-b border-foreground"
            : "text-description-fg hover:text-foreground"
        }`}
        onClick={() => setActiveOutputTab(workflowId, "output")}
      >
        Output
      </button>
      <button
        className={`text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5
        flex items-center gap-1
        ${
          activeOutputTab === "terminal"
            ? "text-foreground border-b border-foreground"
            : "text-description-fg hover:text-foreground"
        }`}
        onClick={() => setActiveOutputTab(workflowId, "terminal")}
      >
        Terminal
        {terminalSessionActive && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
        )}
      </button>
    </div>
  ) : (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-description-fg">
      Output
    </span>
  );
}

{
  /* Font size stepper — Output tab only */
}
{
  activeOutputTab === "output" && (
    <div className="flex items-center ml-3">
      {/* ... existing font size buttons unchanged ... */}
    </div>
  );
}
```

The output body renders either the existing output list (Output tab) or
`<TerminalView workflowId={workflowId} />` (Terminal tab). Both use `flex-1 min-h-0`
so the content fills the Output panel height. Minimap rail and right-side controls
(diff toggle, export, run selector) are hidden when Terminal tab is active.

---

## Files Changed

| File                                                          | Change                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/DashboardConstants.ts`                             | Add 8 new `MESSAGE_TYPES` constants                                                                                              |
| `src/ui/webview-react/stores/uiStore.ts`                      | Add `activeOutputTabs` (Record, default `'output'`), `terminalActiveWorkflows`                                                   |
| `src/ui/webview-react/stores/terminalStore.ts`                | New store: session metadata + `pendingOutput` + `clearAiCliSessions`                                                             |
| `src/ui/webview-react/terminalRegistry.ts`                    | New module: xterm instances, DOM elements, `freeze()`, `clearAiCliSessions()`, `clearSession()`                                  |
| `src/ui/webview-react/components/output/TerminalInstance.tsx` | New component: mount-point manager, frozen overlay                                                                               |
| `src/ui/webview-react/components/output/TerminalView.tsx`     | New component: always-visible rail, ai-cli + shell sections, "+" button                                                          |
| `src/ui/webview-react/components/layout/OutputSection.tsx`    | Split collapse target, tab buttons, conditional body, `min-h-0` on body                                                          |
| `src/flightpath/harness/CliIntegration.ts`                    | Replace `vscode.Terminal` with `CliProcessManager.spawnPty()`; remove `terminal.show()`                                          |
| `src/flightpath/harness/CliProcessManager.ts`                 | node-pty backend: `spawnPty`, `spawnShell`, `writeToSession`, `resizeSession`, `killSession`, `restartShellSession`, `dispose()` |
| `src/ui/WebviewMessageRouter.ts`                              | Handle `TERMINAL_INPUT`, `TERMINAL_RESIZE`, `TERMINAL_SPAWN_SHELL`, `TERMINAL_RESTART_SHELL`, `TERMINAL_CLOSE_SHELL`             |
| `src/ui/FlightPathWebviewProvider.ts`                         | Forward `TERMINAL_OUTPUT/STARTED/ENDED`; on `READY` resend active sessions + reconnect buffer                                    |
| `src/extension.ts`                                            | Register `CliProcessManager` with `context.subscriptions`                                                                        |
| `package.json`                                                | Add `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`                                                                               |

**Not changed:** All log-processing code, `CliOutput`, `OutputMinimap`, `UndoChangesDialog`,
`workflowStore` — entirely unaffected.

---

## Implementation Order

### Step 1 — Types and store scaffolding

1. Add 8 `MESSAGE_TYPES` constants to `DashboardConstants.ts`
2. Add `activeOutputTabs` (Record with `'output'` default via `getActiveOutputTab`) +
   `terminalActiveWorkflows` to `uiStore`
3. Create `terminalStore.ts`:
   - Per-workflow session metadata with `kind: SessionKind`
   - `pendingOutput` per session
   - `clearAiCliSessions` (preserves shell sessions)

### Step 2 — Backend: node-pty process management

4. Add `node-pty` to `package.json`; vendor prebuilts for `win32-x64`, `linux-x64`,
   `darwin-arm64`
5. Implement `CliProcessManager`:
   - `spawnPty({ workflowId, stepName, kind, command, args, cwd, env })` at 220×50
   - `spawnShell({ workflowId, cwd })` → spawns `$SHELL` / `cmd.exe`
   - `writeToSession`, `resizeSession`, `killSession`, `restartShellSession`
   - Per-session reconnect ring buffer (50KB cap)
   - `dispose()` kills all sessions; implements `vscode.Disposable`
6. Update `CliIntegration.executeInTerminal()`:
   - `CliProcessManager.spawnPty(..., kind: 'ai-cli')` instead of `vscode.Terminal`
   - Remove `terminal.show()`
   - `pty.onData()` → `session.bufferChunk(chunk)` + `postMessage(TERMINAL_OUTPUT)`
   - `pty.onExit()` → `postMessage(TERMINAL_ENDED, { kind, exitCode })`
   - `postMessage(TERMINAL_STARTED, { kind: 'ai-cli' })` on spawn
7. Register `CliProcessManager` with `context.subscriptions` in `extension.ts`
8. Update `WebviewMessageRouter`:
   - `TERMINAL_INPUT` → `writeToSession`
   - `TERMINAL_RESIZE` → `resizeSession`
   - `TERMINAL_SPAWN_SHELL` → `spawnShell` → post `TERMINAL_STARTED` with `kind: 'shell'`
   - `TERMINAL_RESTART_SHELL` → `restartShellSession` → post new `TERMINAL_STARTED`
   - `TERMINAL_CLOSE_SHELL` → `killSession` + registry/store cleanup
9. Update `FlightPathWebviewProvider` `READY` handler:
   - Send `TERMINAL_STARTED` for all active sessions (both kinds)
   - Flush reconnect buffer per session as `TERMINAL_OUTPUT` messages
   - Clear reconnect buffer after flush

### Step 3 — Terminal Registry

10. Create `terminalRegistry.ts`:
    - `create`, `attach`, `detach`, `get`
    - `freeze` — sets `entry.frozen = true`; `TerminalInstance` skips `onData` registration
    - `clearAiCliSessions(workflowId, sessions)` — disposes and removes ai-cli entries only
    - `clearSession(workflowId, sessionId)` — for explicit shell close

### Step 4 — Frontend: xterm.js components

11. Add `@xterm/xterm` + `@xterm/addon-fit` to `package.json`
12. Create `TerminalInstance.tsx`:
    - Mount: `create` → `attach` → flush `pendingOutput` → `clearPendingOutput`
    - If `!entry.frozen`: register `term.onData` for `TERMINAL_INPUT` + `InputCapture`
    - `ResizeObserver` → `fitAddon.fit()` + `TERMINAL_RESIZE` (fires immediately on mount)
    - Unmount: `detach`
    - "Process exited" dim overlay when `entry.frozen`
13. Create `TerminalView.tsx`:
    - Always-visible rail (~140px)
    - ai-cli section + shell section + divider between them
    - Frozen ai-cli entries dimmed; ended shell entries show ↺ + × buttons
    - "+" button → `postMessage(TERMINAL_SPAWN_SHELL)`
    - All `TerminalInstance`s mounted simultaneously; `isVisible` drives `display`
    - `height: 100%` throughout so xterm fills the Output panel

### Step 5 — OutputSection integration

14. Update `OutputSection.tsx`:
    - Split collapse target (chevron+icon only)
    - Tab buttons conditional on `showTerminalTab`
    - Body: Terminal tab → `<TerminalView workflowId={...} />` with `flex-1 min-h-0`
    - Hide minimap + Output-only controls when Terminal tab active

### Step 6 — Message handling and lifecycle wiring

15. Update `useMessageHandler`:
    - `TERMINAL_OUTPUT`: registry entry exists → `term.write(chunk)`; else → `pushPendingOutput`
    - `TERMINAL_STARTED`: `terminalStore.addSession()` (with `kind`),
      `uiStore.setTerminalSessionActive(workflowId, true)`,
      if `kind === 'ai-cli'` → auto-switch to Terminal tab
    - `TERMINAL_ENDED`:
      - `terminalStore.endSession()`
      - `terminalRegistry.freeze(workflowId, sessionId)` (ai-cli) or mark ended (shell)
      - If all **running** sessions for workflow ended → `setTerminalSessionActive(false)`,
        if all ended sessions are `ai-cli` → auto-switch back to Output tab
        (keep Terminal tab if user has shell sessions open)
16. On new run start: `terminalStore.clearAiCliSessions(workflowId)` +
    `terminalRegistry.clearAiCliSessions(workflowId, sessions)` — shell sessions untouched

### Step 7 — Test

17. Single AI CLI session: renders in sidebar, fills panel, resizes with panel drag,
    Ctrl+C works, auto-tab-switch on start and completion
18. Session frozen on exit: typing after AI CLI exits produces no output, "Process exited"
    overlay shown, scrollback still readable and copyable
19. Shell session: "+" spawns shell, can run `npm test`, `exit` shows ↺ button,
    ↺ restarts shell, × closes and removes rail entry
20. Collapse/expand Output section: PTY keeps running, terminal restores on expand
21. Switch between two running workflows: both terminals preserve scrollback, input routes
    correctly on return
22. Webview reconnection: close and reopen FlightPath panel mid-session, terminal
    reconnects with recent output from reconnect buffer, PTY still accepts input
23. Parallel group: multiple PTYs spawn, all entries appear in rail, switching sessions
    works, all scrollbacks preserved
24. Extension deactivation: all PTY processes killed cleanly, no orphan processes

---

## Dependencies to Add

| Package            | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `@xterm/xterm`     | Terminal emulator (webview)                                             |
| `@xterm/addon-fit` | Auto-resize terminal canvas to container dimensions                     |
| `node-pty`         | Real PTY for spawning AI CLI processes and user shells (extension host) |

`@xterm/addon-attach` is NOT needed — FlightPath has a structured message protocol;
raw PTY chunks are carried inside `TERMINAL_OUTPUT` payloads and written via `term.write()`.

`react-xtermjs` is NOT needed — thin enough to inline in `TerminalInstance.tsx`.

**node-pty as a native module:**
VS Code extensions run in a separate Node.js extension host process (not Electron's
renderer), so `node-pty` is built against the standard Node.js ABI. For the VSIX,
prebuilt binaries for `win32-x64`, `linux-x64`, `darwin-arm64`, etc. are vendored
directly — the same approach VS Code uses for its own `node-pty` dependency. For remote
scenarios (WSL, SSH, Dev Containers), the extension host runs on the remote machine and
the correct binary for that platform is used automatically.

---

## Ad-Hoc Prompt Capture

### The Problem

Users in interactive mode sometimes type their next prompt directly into the terminal
instead of using the FlightPath prompt editor. FlightPath has no record of that prompt —
no structured output entry, no undo/redo data, no history snapshot.

### Detection Logic

Every keystroke passes through `term.onData()` before reaching the PTY. `InputCapture`
(stored in the registry entry, surviving workflow tab switches) accumulates a shadow buffer.
Only registered for `ai-cli` sessions — shell sessions are unmonitored.

```
term.onData(data)  [ai-cli sessions only, while not frozen]
    ↓
entry.inputCapture.accumulate(data)
    ├── Printable chars → append to shadow buffer
    ├── Backspace       → trim shadow buffer
    ├── Enter (\r)      → classify candidate
    │       short (≤ threshold, default 10 chars) → discard (approval: y/n/1/2/exit)
    │       long (> threshold)                    → emit INPUT_CAPTURED event
    └── Ctrl+C / Ctrl+D → discard buffer
```

### On Capture

1. Create a retroactive `PromptItem` marked `source: "ad-hoc"` with the captured text.
2. Output records arriving after the capture timestamp are attributed to this ad-hoc item.
3. Insert into run history — appears in the Output tab alongside FlightPath-submitted prompts.
4. Surface a "Save to workflow?" button on the ad-hoc entry in the Output tab.

`InputCapture` stored in `terminalRegistry` (not the React component) so it survives
workflow tab switches without losing a partially-typed prompt. Threshold configurable
via `terminalInputCaptureThreshold` setting (default `10` chars), or disable entirely.

---

## Open Questions

1. **xterm.js theme:** `terminalRegistry.create()` reads `--vscode-terminal-*` CSS variables
   at creation time and passes them as `ITheme`. If the VS Code theme changes mid-session,
   post a `THEME_CHANGED` message from the extension (subscribe to
   `onDidChangeActiveColorTheme`) and update `entry.term.options.theme` on all live
   registry entries in `useMessageHandler`.

2. **Parallel steps + interactive mode restriction:** `PARALLEL_STEPS_PLAN.md` restricts
   parallel groups to headless-only in Phase 1. With this terminal plan implemented,
   interactive parallel steps become possible — each step spawns its own node-pty instance
   and appears in the terminal rail. Remove the restriction once this plan is shipped.

3. **Memory ceiling:** The registry holds one xterm.js Terminal per active PTY session.
   Shell sessions persist across runs, so they accumulate over time. The × close button
   is the user's mechanism to reclaim memory. If this becomes a concern in practice, add
   an idle timeout that prompts the user to close long-inactive shell sessions.

4. **Auto-switch back to Output tab on completion:** The plan auto-switches back to Output
   tab when all `ai-cli` sessions for a workflow end — but only if the user has no shell
   sessions open. If the user has a shell open, they are left on the Terminal tab (they
   may be running commands in the shell). This seems correct but should be validated
   against user behavior in testing.
