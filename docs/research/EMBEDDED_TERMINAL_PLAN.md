# Embedded Terminal Plan (xterm.js + node-pty)

## Overview

Replace the VS Code terminal tab context-switch with an embedded xterm.js terminal inside the
FlightPath webview. The interactive AI CLI session renders in the sidebar panel directly —
no tab switching, no focus loss. The existing log-processing pipeline (structured output,
undo/redo, diff views) runs untouched in parallel; the terminal is an additive view, not
a replacement.

This plan also unblocks the standalone server: the same xterm.js frontend works against
either a VS Code `postMessage` bridge or a plain WebSocket — the only thing that changes
is the transport.

---

## Interactive Input: Yes, Fully Bidirectional

A real PTY (via `node-pty`) or VS Code's shell integration both support full bidirectional
I/O. The xterm.js `Terminal` instance:

- **Renders output** — every byte the AI CLI writes (ANSI colors, cursor movement, TUI
  redraws) is passed to `term.write(chunk)` and rendered correctly in the browser canvas.
- **Accepts input** — `term.onData(handler)` fires on every keypress, including control
  sequences (Ctrl+C, Ctrl+D, arrow keys). The handler sends those bytes back to the PTY
  stdin (or `terminal.sendText()` in VS Code mode). The AI CLI receives them as if the
  user typed in a real terminal.

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

| View | What it shows | When it is useful |
|------|--------------|-------------------|
| **Terminal tab** | Raw TUI output, ANSI-accurate, bidirectional input | Watching the AI work, typing responses |
| **Output tab** | Structured output: diffs, tool calls, undo buttons | Reviewing what changed, navigating steps |

Making them tabs in the output section header is the right call: they are mutually exclusive
views of the same data area, and switching between them mid-session is natural (watch the
TUI then switch to Output to review the diff).

---

## UI Design: Output Section Tab Bar

### Current header (single bar)

```
[ v  terminal  OUTPUT ]  [font-/+]  [diff toggle]  [export]  [run selector]
```

### Proposed header (tab bar + controls)

```
[ v  terminal  OUTPUT | TERMINAL* ]  [font-/+]  [diff toggle]  [export]  [run selector]
                           ^-- active tab indicator, * = live badge during interactive
```

Two inline tabs replace the plain "Output" title label in the existing header row.
The rest of the controls (font size, diff toggle, export, run selector) stay on the right
and apply only when the Output tab is active (or are hidden when Terminal tab is active,
since they don't apply to raw terminal output).

**Tab visibility rules:**

| State | Output tab | Terminal tab |
|-------|-----------|-------------|
| Idle, no session | Shown, active | Hidden |
| Interactive mode running | Shown | Shown + live badge |
| Interactive mode complete | Shown | Shown (scrollback preserved until next run) |
| Headless mode (any state) | Shown, active | Hidden |

**Auto-switch behavior:**
- When interactive mode begins → automatically switch to Terminal tab
- When interactive mode completes → automatically switch back to Output tab
- User can manually switch between tabs at any time during execution

**Terminal tab empty state:**
When the Terminal tab is shown but no session is running yet, display:
```
Waiting for interactive session...
```

---

## Architecture: Two Phases

### Phase 1 — VS Code Webview (Short Term, No New Native Deps)

Leverage the `TerminalShellExecution.read()` stream that `CliIntegration` already iterates
for log monitoring. Add a second consumer that forwards raw output chunks to the webview.

```
CliIntegration.executeInTerminal()
    ↓
vscode.Terminal (existing PTY infrastructure)
    ↓
TerminalShellExecution.read()  ← already iterated today for log discovery
    |
    ├── (existing) → log file monitor → structured output pipeline → Output tab
    └── (new)      → webview.postMessage({ type: TERMINAL_OUTPUT, data: chunk })
                                                    ↓
                                           xterm.write(chunk)  →  Terminal tab renders

User types in Terminal tab:
xterm.onData(input) → postMessage({ type: TERMINAL_INPUT, data: input })
    ↓
extension: terminal.sendText(input, false)  ← no newline appended, raw passthrough
```

**What changes:**
- `CliIntegration.startCliProcess()`: after `shellIntegration.executeCommand()`, start a
  parallel `execution.read()` loop that posts `TERMINAL_OUTPUT` chunks to the webview.
  The existing log-monitoring read loop is unchanged.
- `WebviewMessageRouter` (or equivalent): handle `TERMINAL_INPUT` → call
  `CliIntegration.sendTerminalInput(data)` which calls `terminal.sendText(data, false)`.
- Remove `terminal.show()` call — the VS Code terminal tab stays hidden. The user sees
  the output in the webview terminal instead.
- Add `TerminalView` React component (see below).
- Add two new `MESSAGE_TYPES` constants.
- Add `terminalActive: boolean` and `activeOutputTab: 'output' | 'terminal'` to `uiStore`.

**Caveats:**
- `TerminalShellExecution.read()` delivers output that VS Code has already processed
  through its PTY layer. This should be ANSI-accurate for display in xterm.js.
- `terminal.sendText(data, false)` passes raw bytes but is documented as sending text,
  not arbitrary binary. Arrow keys and control sequences (Ctrl+C as `\x03`) need
  testing — VS Code may or may not pass them through correctly.
- The hidden VS Code terminal still exists and runs the PTY; this is not a full removal
  of `vscode.Terminal`, just hiding it and mirroring its I/O.

### Phase 2 — node-pty (Medium Term, Standalone Server Enabler)

Replace the hidden `vscode.Terminal` with a real PTY spawned by `node-pty`. The AI CLI
runs directly under FlightPath's control with full byte-accurate I/O. This is the clean
architecture and the prerequisite for the standalone server.

```
CliIntegration.executeInTerminal()
    ↓
node-pty.spawn(cliCommand, args, { cwd, env, cols, rows })
    ↓
pty.onData(chunk) ────────────────────────────────────────────────────────────────────┐
    |                                                                                  │
    ├── (existing log pipeline) → log file / hook output → structured output           │
    └── (new) → VS Code: webview.postMessage({ type: TERMINAL_OUTPUT, data: chunk })  │
              → Server:  ws.send(JSON.stringify({ type: TERMINAL_OUTPUT, data: chunk }))

User input:
xterm.onData(input)
    → VS Code: postMessage({ type: TERMINAL_INPUT, data: input }) → pty.write(input)
    → Server:  ws.send({ type: TERMINAL_INPUT, data: input })     → pty.write(input)

Terminal resize:
xterm ResizeObserver → postMessage({ type: TERMINAL_RESIZE, cols, rows })
    → pty.resize(cols, rows)
```

**What changes in `CliProcessManager`:**
`CliProcessManager` already abstracts process/terminal management. In Phase 2 it gains a
`node-pty` backend alongside the existing `vscode.Terminal` backend. The selection is
driven by `isVsCodeContext()` (already used in `CliIntegration`):

```typescript
// CliProcessManager (conceptual)
if (isVsCodeContext()) {
  // Phase 1: vscode.Terminal (hidden) + postMessage mirror
} else {
  // Phase 2: node-pty.spawn() + WebSocket / postMessage
}
```

For the standalone server, `isVsCodeContext()` returns false → `node-pty` is always used.

**node-pty as a native module:**
`node-pty` is a C++ native module (Microsoft-maintained, used in VS Code itself). It ships
prebuilt binaries via `node-gyp-build`, so `npm install` downloads the right `.node` file
without local compilation in most cases. For the VS Code extension VSIX, prebuilt binaries
for `win32-x64`, `linux-x64`, `darwin-arm64`, etc. are vendored directly. This is the same
approach VS Code uses for its own `node-pty` dependency.

---

## New Message Types

Add to `src/types/DashboardConstants.ts`:

```typescript
// Terminal I/O — bidirectional between extension/server and webview
TERMINAL_OUTPUT:   "terminalOutput",   // extension/server → webview: raw PTY chunk
TERMINAL_INPUT:    "terminalInput",    // webview → extension/server: keypress data
TERMINAL_RESIZE:   "terminalResize",   // webview → extension/server: {cols, rows}
TERMINAL_STARTED:  "terminalStarted",  // extension/server → webview: session began
TERMINAL_ENDED:    "terminalEnded",    // extension/server → webview: session ended
```

---

## New Store State

### `uiStore` additions

```typescript
// Output section tab state
activeOutputTab: 'output' | 'terminal'       // which tab is showing
setActiveOutputTab: (tab) => void
terminalSessionActive: boolean               // true while interactive session running
setTerminalSessionActive: (active) => void
```

### `terminalStore` (new, separate store)

Keep terminal data out of `workflowStore` and `uiStore` since it is transient, high-frequency
(every PTY byte triggers an update), and should not participate in workflow state resets.

```typescript
interface TerminalStore {
  // Nothing stored — xterm.js Terminal instance owns its own scrollback buffer.
  // The store just tracks imperative signals for the TerminalView component.
  pendingOutput: string[]        // chunks queued before xterm mounts
  clearPendingOutput: () => void
  pushOutput: (chunk: string) => void
}
```

The `TerminalView` component holds the `Terminal` instance in a `useRef`. Incoming
`TERMINAL_OUTPUT` messages are written directly via `term.write(chunk)` — they do not
flow through Zustand at all during active streaming. `pendingOutput` only exists to
buffer chunks that arrive before the component mounts.

---

## New React Components

### `TerminalView.tsx` (`src/ui/webview-react/components/output/`)

```tsx
// Responsibilities:
// - Mount @xterm/xterm Terminal into a div ref
// - Load @xterm/addon-fit (auto-resize to container)
// - Listen for TERMINAL_OUTPUT messages → term.write(chunk)
// - term.onData(input) → postMessage(TERMINAL_INPUT)
// - ResizeObserver → postMessage(TERMINAL_RESIZE) + fit.fit()
// - Show "Waiting for interactive session..." when !terminalSessionActive
```

### OutputSection header changes

Replace the plain "Output" title label with two tab buttons:

```tsx
<div className="flex items-center gap-0">
  <button
    className={`tab-btn ${activeOutputTab === 'output' ? 'tab-active' : ''}`}
    onClick={() => setActiveOutputTab('output')}
  >
    <i className="codicon codicon-terminal" />
    Output
  </button>
  {showTerminalTab && (
    <button
      className={`tab-btn ${activeOutputTab === 'terminal' ? 'tab-active' : ''}`}
      onClick={() => setActiveOutputTab('terminal')}
    >
      <i className="codicon codicon-console" />
      Terminal
      {terminalSessionActive && (
        <span className="live-badge" />  // pulsing dot
      )}
    </button>
  )}
</div>
```

The output body area renders either the existing output list (Output tab) or `<TerminalView />`
(Terminal tab) based on `activeOutputTab`. The minimap rail and all controls are hidden when
Terminal tab is active.

---

## Files Changed

| File | Change |
|------|--------|
| `src/types/DashboardConstants.ts` | Add 5 new `MESSAGE_TYPES` constants |
| `src/ui/webview-react/stores/uiStore.ts` | Add `activeOutputTab`, `terminalSessionActive` |
| `src/ui/webview-react/stores/terminalStore.ts` | New store (pending output buffer) |
| `src/ui/webview-react/components/output/TerminalView.tsx` | New component |
| `src/ui/webview-react/components/layout/OutputSection.tsx` | Tab bar in header, conditional body render |
| `src/flightpath/harness/CliIntegration.ts` | Phase 1: mirror output to webview, remove `terminal.show()`; Phase 2: node-pty backend |
| `src/flightpath/harness/CliProcessManager.ts` | Phase 2: node-pty spawn path |
| `src/ui/WebviewMessageRouter.ts` | Handle `TERMINAL_INPUT` and `TERMINAL_RESIZE` |
| `src/ui/FlightPathWebviewProvider.ts` | Forward `TERMINAL_OUTPUT` / `TERMINAL_STARTED` / `TERMINAL_ENDED` to webview |
| `package.json` | Phase 2: add `node-pty` dependency |

**Not changed:** All log-processing code, `CliOutput`, `OutputMinimap`, `UndoChangesDialog`,
`workflowStore` — these are entirely unaffected since the structured output pipeline is
independent of the terminal view.

---

## Implementation Order

### Phase 1 (VS Code UX fix — no new native deps)

1. Add 5 `MESSAGE_TYPES` constants
2. Add `activeOutputTab` + `terminalSessionActive` to `uiStore`
3. Create `TerminalView.tsx` (xterm.js, no PTY — just display + input passthrough)
4. Create `terminalStore.ts`
5. Update `OutputSection.tsx` — tab bar + conditional body
6. Update `CliIntegration.startCliProcess()` — mirror `execution.read()` to webview, remove `terminal.show()`
7. Update `WebviewMessageRouter` — handle `TERMINAL_INPUT` → `terminal.sendText(data, false)`
8. Test: interactive Copilot CLI session renders in sidebar, Ctrl+C works, auto-switches tabs

### Phase 2 (standalone server + clean architecture)

1. Add `node-pty` dependency, vendor prebuilts for target platforms
2. Refactor `CliProcessManager` — add node-pty backend behind `isVsCodeContext()` guard
3. Update `CliIntegration.executeInTerminal()` — use `CliProcessManager`'s PTY directly
   for I/O instead of reading from `TerminalShellExecution`
4. Update `StandaloneServerAdapter` (from `STANDALONE_SERVER_PLAN.md`) — wire
   `TERMINAL_INPUT` / `TERMINAL_RESIZE` WebSocket messages to PTY
5. Test: interactive session in standalone server browser tab, full bidirectional I/O

---

## Dependencies to Add

| Package | Purpose | Phase |
|---------|---------|-------|
| `@xterm/xterm` | Terminal emulator (webview) | 1 |
| `@xterm/addon-fit` | Auto-resize to container | 1 |
| `react-xtermjs` | React hook + component wrapper | 1 (optional — thin enough to inline) |
| `node-pty` | Real PTY for non-VS Code paths | 2 |

`@xterm/addon-attach` is NOT needed — the attach addon assumes a raw WebSocket carrying
PTY bytes, but FlightPath already has a structured message protocol. Raw PTY chunks are
carried inside `TERMINAL_OUTPUT` message payloads and written to xterm via `term.write()`.

---

## Ad-Hoc Prompt Capture

### The Problem

A long-standing issue: users in interactive mode sometimes type their next prompt directly
into the terminal instead of going back to the FlightPath prompt editor to submit it. When
this happens, FlightPath has no record of that prompt — it was never queued through
`PromptQueue`, so there is no structured output entry, no undo/redo data, and no history
snapshot for that interaction.

### How Owning the I/O Pipe Fixes This

With the embedded terminal, every keystroke the user types passes through `term.onData()`
before reaching the PTY. FlightPath is now in the middle of the I/O. A lightweight
**shadow input buffer** layer can be added with no changes to the AI CLI harnesses.

### Detection Logic

```
term.onData(data) fires on every keypress
    ↓
InputCapture.accumulate(data)
    ├── Printable chars → append to shadow buffer
    ├── Backspace       → trim shadow buffer
    ├── Enter (\r)      → flush: candidate input ready
    │       ↓
    │   classify(candidate):
    │       short (≤ threshold, e.g. 5 chars)  → approval response (y/n/1/2/exit)
    │                                             discard silently
    │       long (> threshold)                  → probable prompt or instruction
    │                                             → emit INPUT_CAPTURED event
    └── Ctrl+C / Ctrl+D → discard buffer, emit nothing
```

### What Happens with a Captured Input

The `INPUT_CAPTURED` event carries the text the user typed. The extension already has the
structured output pipeline running in parallel. FlightPath can:

1. **Create a retroactive `PromptItem`** marked as `source: "ad-hoc"` with the captured
   text as the `prompt` field.
2. **Link it to the output that follows** — the log pipeline is already capturing the AI
   CLI's response. The output records that arrive after the capture timestamp are
   attributed to this ad-hoc item.
3. **Insert it into the run history** as a completed step so it appears in the Output tab
   alongside FlightPath-submitted prompts.
4. **Surface a non-intrusive action** in the Terminal tab (or Output tab): a small
   "Save to workflow?" button/toast on the ad-hoc item that lets the user promote it into
   the actual prompt queue YAML for next time.

### Output Tab Rendering

Ad-hoc captured prompts appear in the Output tab with a distinct visual treatment:

```
┌─────────────────────────────────────────────────────────┐
│  [ad-hoc]  Prompt 3 (typed in terminal)          [+ Add to workflow]  │
│  "can you also add error handling to the parser"                       │
└─────────────────────────────────────────────────────────┘
[... structured output from the AI response ...]
```

The undo/redo infrastructure works the same way — since the output is captured through the
existing log pipeline, workspace snapshots and file edit events are already recorded.

### What Is Not Automatically Detected

The boundary between "responding to an AI clarifying question" and "submitting a new prompt"
is ambiguous. Examples:

| User types | Classification | Right call |
|-----------|---------------|-----------|
| `y` | approval — discarded | correct |
| `src/utils/foo.ts` | short path — discarded | may miss intentional prompt |
| `yes, use TypeScript` | long — captured | correct |
| `I meant the v2 API` | long — captured | correct |
| `no, do it differently` | long — captured | correct |

The threshold approach handles the obvious cases. For the ambiguous ones, the user can
dismiss the "Save to workflow?" suggestion or manually delete the ad-hoc entry. This is
strictly additive — no existing behavior changes, and nothing is lost compared to today
where the prompt is silently swallowed.

### Implementation Notes

- `InputCapture` is a small pure class owned by `TerminalView` (or a hook alongside it).
  It has zero knowledge of FlightPath internals — it just buffers and emits events.
- The threshold and classification rules can be made configurable via a FlightPath setting
  (`terminalInputCaptureThreshold`, default `10` characters) or disabled entirely.
- This feature is Phase 1-compatible — it requires only `term.onData()` access, which
  exists in both the VS Code postMessage path and the node-pty path.

---

## Open Questions

1. **Phase 1 input fidelity:** Does `terminal.sendText(data, false)` pass Ctrl+C (`\x03`),
   arrow keys, etc. through correctly? May need testing across all three OS platforms. If
   not, Phase 2 (node-pty) becomes higher priority.

2. **xterm.js theme:** The terminal should use VS Code's colors (`--vscode-terminal-*` CSS
   variables) when in the extension, and the standalone server's theme CSS when in the
   browser. `TerminalView` should read these on mount and pass them to the xterm `ITheme`
   option.

3. **Terminal tab persistence:** Should the terminal scrollback survive switching to the
   Output tab and back? Yes — xterm.js holds its own buffer; switching tabs just
   unmounts/remounts the DOM container. Use a CSS `display: none` approach (keep the
   xterm canvas mounted, just hide the container) rather than unmounting the component,
   to preserve scrollback without a re-attach.

4. **Multiple parallel workflows:** The dashboard supports parallel workflow execution.
   Each workflow has its own `OutputSection`. The terminal tab should be scoped to the
   active workflow's interactive session, not shared. Since each `OutputSection` is already
   per-workflow, this should fall out naturally — `TerminalView` subscribes to messages
   tagged with the workflow ID.
