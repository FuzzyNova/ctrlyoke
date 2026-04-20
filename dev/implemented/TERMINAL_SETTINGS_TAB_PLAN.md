# Terminal Settings Tab

Add a **Terminal** tab to `GlobalSettingsDrawer` exposing xterm.js and node-pty settings that are currently hardcoded.

---

## New Settings Tab

**File**: `src/ui/webview-react/components/settings/TerminalSection.tsx`

Register in `GlobalSettingsDrawer.tsx` `ALL_TABS`:

```typescript
{ id: "terminal", label: "Terminal", icon: "codicon-terminal" }
```

---

## Settings Layout

```
Terminal Appearance
  Font size                    [stepper — mirrors the one in OutputSection header]
  Line height                  [number input, 1.0–2.0, step 0.1, default 1.2]
  Scrollback lines             [number input, 1000–50000, default 5000]
  Cursor style                 [select: block | underline | bar, default block]
  Cursor blink                 [toggle, default on]

Terminal Behavior
  macOS: Option key as Meta    [toggle, default off]
  Double-click word separators [text input, default xterm default]
  Replay buffer size           [number input in KB, default 50]

Shell
  Shell executable             [text input, placeholder = auto-detected path]

Mobile Control Bar
  Control bar visibility       [select: auto | always | never, default auto]
  Custom shortcuts             [list editor: label + key sequence pairs]
```

---

## VS Code Settings (package.json)

All under `flightpath.terminal.*`:

| Setting key | Type | Default | Description |
|---|---|---|---|
| `terminal.fontSize` | `number` | `14` | Terminal font size in pixels |
| `terminal.lineHeight` | `number` | `1.2` | Terminal line height multiplier |
| `terminal.scrollback` | `number` | `5000` | Max scrollback lines retained in memory |
| `terminal.cursorStyle` | `"block"` \| `"underline"` \| `"bar"` | `"block"` | Terminal cursor shape |
| `terminal.cursorBlink` | `boolean` | `true` | Blink the terminal cursor |
| `terminal.macOptionIsMeta` | `boolean` | `false` | Treat the macOS Option key as Meta (for Emacs/Vim alt-key shortcuts) |
| `terminal.wordSeparators` | `string` | `" ()[]{}',\"\`"` | Characters treated as word boundaries on double-click selection |
| `terminal.replayBufferKb` | `number` | `50` | Output replayed on webview reconnect (KB). Higher values recover more context after a panel reload. |
| `terminal.shellExecutable` | `string` | `""` | Override the shell spawned for interactive terminal sessions. Empty = auto-detect ($SHELL on Unix, pwsh/powershell on Windows). |
| `terminal.mobileControlBar` | `"auto"` \| `"always"` \| `"never"` | `"auto"` | When to show the mobile terminal control bar |
| `terminal.mobileCustomShortcuts` | `array` | `[]` | Custom shortcuts in the mobile control bar More menu. Each entry: `{ label: string, sequence: string }` |

---

## Type Changes

### `WebviewMessageTypes.ts` — add to `FlightPathGlobalSettings`

```typescript
interface TerminalSettings {
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  macOptionIsMeta: boolean;
  wordSeparators: string;
  replayBufferKb: number;
  shellExecutable: string;
  mobileControlBar: "auto" | "always" | "never";
  mobileCustomShortcuts: Array<{ label: string; sequence: string }>;
}

// Add to FlightPathGlobalSettings:
terminal: TerminalSettings;
```

---

## Code Changes

### `terminalRegistry.ts`

`create()` currently hardcodes xterm options. Switch to reading from a settings getter:

```typescript
// Before (hardcoded):
const term = new Terminal({
  scrollback: 5000,
  lineHeight: 1.2,
  letterSpacing: 0,
  allowTransparency: false,
  cursorBlink: true,
  ...
});

// After (from settings):
const settings = getTerminalSettings(); // reads ConfigurationUtils
const term = new Terminal({
  scrollback: settings.scrollback,
  lineHeight: settings.lineHeight,
  cursorStyle: settings.cursorStyle,
  cursorBlink: settings.cursorBlink,
  macOptionIsMeta: settings.macOptionIsMeta,
  wordSeparators: settings.wordSeparators,
  letterSpacing: 0,        // not exposed — correct for monospace
  allowTransparency: false, // not exposed — VS Code theme controls this
  ...
});
```

Add `updateTerminalOptions(settings: TerminalSettings)` to apply changes to all live registry entries (mirrors the existing `updateTheme` and `updateFontSize` pattern):

```typescript
updateTerminalOptions(settings: TerminalSettings): void {
  currentFontSize = settings.fontSize;
  for (const entry of registry.values()) {
    entry.term.options.scrollback = settings.scrollback;
    entry.term.options.lineHeight = settings.lineHeight;
    entry.term.options.cursorStyle = settings.cursorStyle;
    entry.term.options.cursorBlink = settings.cursorBlink;
    entry.term.options.macOptionIsMeta = settings.macOptionIsMeta;
    entry.term.options.wordSeparators = settings.wordSeparators;
    entry.term.options.fontSize = settings.fontSize;
    try { entry.fitAddon.fit(); } catch { /* not attached */ }
  }
}
```

### `PtyProcessManager.ts`

- `RECONNECT_BUFFER_MAX`: change from module constant to a value read via `ConfigurationUtils` at spawn time (`settings.replayBufferKb * 1024`)
- `spawnShell()`: if `settings.shellExecutable` is non-empty, use it instead of `resolveWindowsShell()` / `resolveUnixShell()`; still call `resolveShellKind()` on the override path to pick the right icon

**Shell override only affects `spawnShell()`** (the "+" interactive terminal sessions). It does NOT affect how AI CLI harness sessions are spawned — those always go through `CliTransportCoordinator.startInteractiveProcess()`, which calls `resolveWindowsShell()`/`resolveUnixShell()` directly and is separate from this setting.

**Shell override is not needed for AI CLI availability checks.** `checkAvailability()` in all six harness providers was updated (as part of this cleanup) to use `execFileAsync(resolveWindowsShell()/resolveUnixShell(), shellArgs)` instead of `execAsync` (which defaulted to `cmd.exe` on Windows, `/bin/sh` on Unix). This ensures availability checks use the same execution path as actual harness sessions. The shell resolvers are cached after first call — no performance cost.

### `ConfigurationUtils.ts`

Add `getTerminalSettings(): TerminalSettings` helper that reads all `flightpath.terminal.*` values with defaults matching the table above. Used by both `terminalRegistry.ts` and `PtyProcessManager.ts`.

### `useMessageHandler.ts`

On `GLOBAL_SETTING_UPDATED` where the path starts with `terminal.`, call `terminalRegistry.updateTerminalOptions(getTerminalSettings())` so live sessions reflect the change without requiring a reload.

### `OutputSection.tsx` / header font size stepper

The stepper currently calls `terminalRegistry.updateFontSize(size)` directly. After this change it should also persist to settings via `UPDATE_GLOBAL_SETTING` (path `terminal.fontSize`) so the value survives panel reloads. `updateTerminalOptions` subsumes `updateFontSize` — the stepper can call `updateTerminalOptions` or continue calling `updateFontSize` as a thin wrapper; either works.

---

## `TerminalSection.tsx` Component Patterns

Follow the existing settings section pattern (`GeneralSection.tsx` etc.):

```typescript
interface Props {
  settings: FullGlobalSettings;
  onUpdate: (path: string, value: unknown, scope: "workspace" | "user") => void;
}
```

**Font size stepper**: reuse the same `±` stepper pattern from `OutputSection` header — same UX, new home. Range 8–24.

**Line height**: `<input type="number" min="1.0" max="2.0" step="0.1">` with inline validation.

**Scrollback**: `<input type="number" min="1000" max="50000" step="1000">`. Show a note: *"Higher values use more memory. Changes apply to new sessions."*

**Cursor style**: `<CustomSelect>` with three options.

**Cursor blink, macOptionIsMeta**: `ToggleRow` (same helper used in `GeneralSection`).

**Word separators**: plain text input with the default value shown in placeholder.

**Replay buffer**: number input (KB), range 10–500.

**Shell executable**: platform-aware UI:
- **Windows**: dropdown of detected shells (pwsh, powershell, Git Bash if found at `C:\Program Files\Git\bin\bash.exe`, WSL if `wsl.exe` found in System32) + "Custom path…" option that reveals a text input. cmd.exe is deliberately omitted; if entered in the custom field, show a warning. Include an info note: *"AI harness sessions (Claude, Copilot, etc.) always run natively on Windows regardless of this setting."*
- **macOS / Linux**: optional text input. Show the auto-detected value as placeholder (`$SHELL` or zsh/bash fallback). On macOS, validate at save time: if the user enters `/bin/bash`, show *"The system bash on macOS may fail with 'Permission denied' under SIP. Use Homebrew bash (/usr/local/bin/bash) instead."*
- Unix users rarely need this — `$SHELL` is already respected automatically. Label it as an override and explain when it's needed (VS Code launched from GUI without inheriting login shell environment).

**Custom shortcuts list editor**: rows of `[label input] [sequence input] [× remove]` with an `+ Add shortcut` button at the bottom. Sequence inputs accept literal escape sequences (e.g. `\x1b[A`); show a small tooltip explaining the format.

---

## Implementation Order

1. `package.json` — add all `flightpath.terminal.*` settings
2. `WebviewMessageTypes.ts` — add `TerminalSettings` interface to `FlightPathGlobalSettings`
3. `ConfigurationUtils.ts` — add `getTerminalSettings()`
4. `terminalRegistry.ts` — read settings in `create()`, add `updateTerminalOptions()`
5. `PtyProcessManager.ts` — read buffer size + shell override from settings
6. `TerminalSection.tsx` — settings UI component
7. `GlobalSettingsDrawer.tsx` — register Terminal tab
8. `useMessageHandler.ts` — wire `GLOBAL_SETTING_UPDATED` → `updateTerminalOptions`
9. Font size stepper in `OutputSection` — persist to settings
