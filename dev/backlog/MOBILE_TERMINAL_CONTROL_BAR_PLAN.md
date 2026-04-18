# Mobile Terminal Control Bar

## Keystroke Passthrough Confirmation

**Current behavior is correct.** In `terminalRegistry.ts`, the xterm `onData` handler (registered in `TerminalInstance.tsx`) directly forwards every raw keystroke to the PTY via `MESSAGE_TYPES.TERMINAL_INPUT`. There is zero filtering — Ctrl+C sends `\x03` (SIGINT), not a copy command. This is the standard terminal emulator contract and exactly what we want for shell and AI CLI sessions. No changes needed to `PtyProcessManager.ts` or `terminalRegistry.ts` for this feature.

---

## Feature: Mobile Control Key Bar

### Problem

When viewing the terminal through `FlightPathHostedServer` on a mobile browser, users cannot send control sequences (Escape, Tab, arrow keys, Ctrl chords) because software keyboards don't emit them. The control bar provides tap targets for these keys, making the terminal usable on mobile.

### Detection Strategy

Use **two independent signals** combined with a user override:

1. **Touch device** — `navigator.maxTouchPoints > 0` (works in all browsers, synchronous, no media query needed)
2. **Coarse pointer** — `useMediaQuery("(pointer: coarse)")` returns `true` when the primary input is touch with no fine-pointing device
3. **`window.__flightpathStandalone`** — already set by `standalone-shim.js`; the bar is only meaningful in browser mode (VS Code's webview already has a physical keyboard)

**Visibility rule**: Show when `isStandalone && hasTouchCapability && noFinePointer`.

- `isStandalone` comes from the existing `isStandalone` export in `useVsCodeApi.ts`
- `hasTouchCapability = navigator.maxTouchPoints > 0` (static check, no reactivity needed)
- `noFinePointer = useMediaQuery("(pointer: coarse)")` (reactive — detects Bluetooth keyboard connect/disconnect on iPads)

When a Bluetooth keyboard is connected to an iPad, `(pointer: coarse)` changes to `(pointer: fine)` if a mouse is also attached, or stays `coarse` if only a keyboard is connected. For the typical mobile-browser case (phone or tablet with no mouse), this works well. A user setting (see §Settings) can override auto-detection to always show or always hide.

### Virtual Keyboard Avoidance

On mobile, the software keyboard shrinks the viewport, which would push the control bar off screen. Use the **Virtual Keyboard API** (`navigator.virtualKeyboard`, Chromium 94+) with a `window.visualViewport` resize fallback:

```
if ("virtualKeyboard" in navigator) {
  navigator.virtualKeyboard.overlaysContent = true;
  // env(keyboard-inset-height) is then available as a CSS custom property
}
```

The control bar is positioned `sticky` at the bottom of the terminal canvas. When the virtual keyboard is visible, pad the bar's bottom by `env(keyboard-inset-height, 0px)`. For browsers without the VK API, `visualViewport.height` shrinks when the keyboard opens — detect this and adjust the terminal container height so the bar stays visible.

---

## Architecture

### New Component: `TerminalControlBar`

**File**: `src/ui/webview-react/components/output/TerminalControlBar.tsx`

Placed inside `TerminalView.tsx`'s terminal canvas panel, below the `TerminalInstance` map. Rendered only when the active session is controlled by this client (`isController !== false`) and mobile detection criteria are met.

```
TerminalView
  └─ Panel#terminal-canvas
       └─ div.h-full (existing container)
            ├─ TerminalInstance × N  (existing)
            └─ TerminalControlBar   (new, sticky bottom)
```

### Component Props

```typescript
interface TerminalControlBarProps {
  workflowId: string;
  sessionId: string;
}
```

### Key Layout

The bar is a single horizontal row of buttons:

```
[ Ctrl ]  [ Esc ]  [ Tab ]  [ ↑ ]  [ ↓ ]  [ ← ]  [ → ]  [ ⏎ ]  [ ··· ]
```

- **Ctrl** — toggles on/off. While active, a tinted highlight ring shows state. The next key tap (including keys on the software keyboard) sends the Ctrl-modified sequence. Auto-clears after one keypress.
- **Esc** — sends `\x1b`
- **Tab** — sends `\t` (`\x09`)
- **↑ ↓ ← →** — sends ANSI arrow sequences (`\x1b[A`, `\x1b[B`, `\x1b[D`, `\x1b[C`)
- **⏎ (Enter)** — sends `\r`
- **··· (More)** — opens a dropdown menu (see §More Menu)

### Ctrl Toggle Logic

When Ctrl is active:
- The **bar buttons** send their Ctrl-modified sequence directly (Esc → `\x1b` unchanged, Tab → `\x09` unchanged, Arrow → unchanged, Enter → `\r` unchanged; Ctrl only meaningfully modifies letter keys which come from the software keyboard)
- A `keydown` listener on `document` intercepts the **next key from the software keyboard** and sends `Ctrl+key` as a raw byte (`String.fromCharCode(char.toUpperCase().charCodeAt(0) - 64)`), then deactivates Ctrl and calls `event.preventDefault()`
- After one intercepted keystroke (bar button or keyboard), Ctrl auto-deactivates

This one-shot model avoids the complexity of a sticky Ctrl key that could trap legitimate input.

### Key Sequences

| Key | Sequence | Notes |
|---|---|---|
| Escape | `\x1b` | |
| Tab | `\x09` | |
| Enter | `\r` | PTY expects CR |
| Arrow Up | `\x1b[A` | |
| Arrow Down | `\x1b[B` | |
| Arrow Left | `\x1b[D` | |
| Arrow Right | `\x1b[C` | |
| Ctrl+C | `\x03` | SIGINT |
| Ctrl+D | `\x04` | EOF / detach |
| Ctrl+Z | `\x1a` | SIGTSTP |
| Ctrl+L | `\x0c` | Clear screen |
| Ctrl+A | `\x01` | Line start |
| Ctrl+E | `\x05` | Line end |
| Ctrl+U | `\x15` | Clear line |
| Ctrl+W | `\x17` | Delete word |
| Ctrl+R | `\x12` | Reverse search |
| Shift+Tab | `\x1b[Z` | |

All sequences sent via `sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, { workflowId, sessionId, data })`.

### More Menu

A small popup panel anchored to the `···` button. Contains:

**Built-in shortcuts** (always present):
- Shift+Tab → `\x1b[Z`
- Ctrl+C → `\x03`
- Ctrl+Z → `\x1a`
- Ctrl+L → `\x0c`
- Ctrl+R → `\x12`
- Ctrl+A → `\x01` (beginning of line)

**User custom shortcuts** (from settings, see §Settings):
- Each rendered as a tappable button with the user's label
- An **"Add shortcuts…"** footer link opens GlobalSettingsDrawer on the Terminal tab

### Input Routing

No changes to the PTY layer. The bar calls `sendMessage(MESSAGE_TYPES.TERMINAL_INPUT, ...)` exactly as xterm's `onData` handler does. This works equally for VS Code webview and browser WebSocket paths.

---

## Settings

### New Settings Tab: Terminal

Add a **Terminal** tab to `GlobalSettingsDrawer`:

```typescript
{ id: "terminal", label: "Terminal", icon: "codicon-terminal" }
```

New file: `src/ui/webview-react/components/settings/TerminalSection.tsx`

#### Settings UI

1. **Control Bar Visibility** — dropdown: `Auto` (default) | `Always show` | `Never show`
   - `auto` = show on coarse-pointer devices in standalone mode
   - `always` = always render the bar (useful for debugging)
   - `never` = disable completely

2. **Custom Shortcuts** — a list editor where the user can add label + key sequence pairs
   - Each entry: text input for label, text input for raw sequence (escape sequences like `\x1b[1;5A` accepted)
   - Add/remove buttons per row
   - These appear in the More dropdown in order defined

#### Package.json / ConfigurationUtils

New VS Code settings (added to `package.json` contributes.configuration and read via `ConfigurationUtils`):

```json
"flightpath.terminal.mobileControlBar": {
  "type": "string",
  "enum": ["auto", "always", "never"],
  "default": "auto",
  "description": "When to show the mobile terminal control bar."
},
"flightpath.terminal.mobileCustomShortcuts": {
  "type": "array",
  "default": [],
  "items": {
    "type": "object",
    "properties": {
      "label": { "type": "string" },
      "sequence": { "type": "string" }
    }
  },
  "description": "Custom shortcuts shown in the terminal control bar More menu."
}
```

These settings need to be plumbed through `FlightPathGlobalSettings` → `FullGlobalSettings` → `GlobalSettingsLoadedMessage` like all other settings. Add to `WebviewMessageTypes.ts` under the appropriate settings interface.

---

## Implementation Steps

### Step 1 — Detection hook
- Add `useMobileTerminalBar()` hook in `src/ui/webview-react/hooks/`
- Returns `{ shouldShow: boolean, isCoarsePointer: boolean }` based on detection logic + setting override
- Reads `fullGlobalSettings.settings.terminal.mobileControlBar` from `settingsStore`

### Step 2 — TerminalControlBar component
- Create `src/ui/webview-react/components/output/TerminalControlBar.tsx`
- Internal state: `ctrlActive: boolean`, `moreOpen: boolean`
- `sendKey(seq: string)` helper: calls `sendMessage(TERMINAL_INPUT, ...)` and resets ctrl state
- Ctrl intercept: registers/removes a `keydown` listener on `document` whenever `ctrlActive` is true
- Style: `sticky bottom-0 z-20`, semi-transparent background matching `--vscode-terminal-background`, minimal height (~36px), full width

### Step 3 — Integrate into TerminalView
- In `TerminalView.tsx`, import `TerminalControlBar` and `useMobileTerminalBar`
- Render `<TerminalControlBar>` inside the terminal canvas panel, visible only when `shouldShow && activeSessionId && isController`
- The bar always renders at the bottom of the canvas; no layout changes needed for non-mobile

### Step 4 — Settings wiring
- Add `mobileControlBar` and `mobileCustomShortcuts` to `FlightPathGlobalSettings` in `WebviewMessageTypes.ts`
- Add to `package.json` and `ConfigurationUtils.ts`
- Create `TerminalSection.tsx` settings component
- Register tab in `GlobalSettingsDrawer.tsx`

### Step 5 — Virtual keyboard avoidance
- Detect VK API availability; if present, set `overlaysContent = true` and use `env(keyboard-inset-height)` in the bar's CSS
- Fallback: listen to `window.visualViewport.resize`, compute keyboard height as `window.innerHeight - visualViewport.height`, apply as inline `paddingBottom` on the bar

---

## Non-Goals / Out of Scope

- No changes to PTY routing, `PtyProcessManager`, or `terminalRegistry` for this feature
- No mobile keyboard detection for the VS Code webview (it already has a hardware keyboard; VS Code on iPad is unsupported)
- The bar is not shown for viewers (non-controller clients) — they can't send input anyway
- No haptic feedback (no native API available in webview context)
