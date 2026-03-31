# FlightPath Keyboard Shortcuts Reference

## Architecture Overview

FlightPath has two distinct layers where keyboard shortcuts live, and they operate independently:

```
┌─────────────────────────────────────────────────────┐
│  VS Code Shell Layer                                 │
│  package.json keybindings → vscode.commands          │
│  Works when: view is focused, webview NOT consuming  │
└────────────────┬────────────────────────────────────┘
                 │  (separate iframe boundary)
┌────────────────▼────────────────────────────────────┐
│  Webview Layer (React + CodeMirror)                  │
│  document.addEventListener / onKeyDown / CM keymap   │
│  Works when: focus is inside the webview iframe      │
└─────────────────────────────────────────────────────┘
```

**Critical rule:** VS Code `package.json` keybindings **do not fire** when focus is inside the webview iframe. Keyboard events inside the webview must be handled in webview code via `postMessage` to the extension host.

**Visibility rule:** Only `package.json` keybindings appear in VS Code's Keyboard Shortcuts editor (`Ctrl+K Ctrl+S`). CodeMirror `keymap.of()` bindings are invisible to VS Code — users cannot see or rebind them. For any shortcut users should be aware of, register it in `package.json` too.

---

## Conflict Avoidance

### The `when` clause is the primary tool

VS Code resolves conflicts by **specificity** — a more specific `when` clause wins over a more general one. All FlightPath bindings use `focusedView == 'flightpath.dashboard'`, so they only activate in context and override any global binding for the same key combination.

```json
// Our Ctrl+Shift+N overrides VS Code's "new window" only when FlightPath is focused
"when": "focusedView == 'flightpath.dashboard'"
```

### Checking for conflicts before adding a new binding

1. Open VS Code Keyboard Shortcuts editor: `Ctrl+K Ctrl+S`
2. Search for the intended key combo to see all commands currently bound to it
3. Inspect `when` clauses — if another binding uses the same key with an overlapping `when`, it's a real conflict

### Useful context keys for scoping

```json
// Only when NOT typing in any input (prevents stealing text-entry shortcuts)
"when": "focusedView == 'flightpath.dashboard' && !inputFocus"

// Only when the webview input has focus
"when": "focusedView == 'flightpath.dashboard' && inputFocus"
```

### Known VS Code built-in conflicts to watch

| Key            | Built-in use                      | Our `when` clause avoids it?                   |
| -------------- | --------------------------------- | ---------------------------------------------- |
| `Ctrl+Shift+N` | New window (global)               | Yes — our `focusedView` clause wins in context |
| `Ctrl+Enter`   | Copilot Chat send (`inChatInput`) | Yes — non-overlapping `when` clauses           |
| `Ctrl+Shift+T` | Reopen closed tab (global)        | Yes — our `focusedView` clause wins in context |

### Key combos with low VS Code occupancy (safe to use)

- `Ctrl+Shift+*` — most combinations are unbound globally
- `Ctrl+Alt+*` — mostly free outside specific editor contexts
- Avoid plain `Ctrl+*` without a scoped `when` clause

---

## Layer 1: VS Code Shell Keybindings (package.json)

### When to use this layer

Use for shortcuts that should work when the FlightPath panel is focused **but focus is not inside the webview content** (e.g., keyboard navigation to the panel, command palette equivalents). Also register here any shortcut you want visible in VS Code's Keyboard Shortcuts editor, even if the primary handler is in the webview.

### How to add a VS Code keybinding

**1. Register the keybinding in `package.json`:**

```json
{
  "keybindings": [
    {
      "command": "flightpath.myCommand",
      "key": "ctrl+shift+x",
      "mac": "cmd+shift+x",
      "when": "focusedView == 'flightpath.dashboard'"
    }
  ]
}
```

**2. Register the command handler in `src/extension.ts`:**

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("flightpath.myCommand", () => {
    flightPathManager.doSomething();
  })
);
```

**3. Declare the command in `package.json` contributes.commands:**

```json
{
  "command": "flightpath.myCommand",
  "title": "My Command",
  "category": "FlightPath"
}
```

### `when` clause options for the FlightPath dashboard

| `when` clause                                    | Fires when                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `focusedView == 'flightpath.dashboard'`          | FlightPath sidebar panel has keyboard focus (regardless of whether webview content has focus) |
| `activeWebviewPanelId == 'flightpath.dashboard'` | A FlightPath webview panel is the active editor (not sidebar)                                 |

**Note:** Both clauses require VS Code to have the focus — neither fires while focus is inside the webview iframe.

### Existing VS Code keybindings

| Key (Win/Linux) | Key (Mac)     | Command                          | Action                |
| --------------- | ------------- | -------------------------------- | --------------------- |
| `Ctrl+Shift+N`  | `Cmd+Shift+N` | `flightpath.clearWorkflow`       | Clear workflow state  |
| `Ctrl+Shift+T`  | `Cmd+Shift+T` | `flightpath.newWorkflow`         | New workflow          |
| `Ctrl+Shift+L`  | `Cmd+Shift+L` | `flightpath.selectPromptFile`    | Select prompt file    |
| `Ctrl+Shift+Q`  | `Cmd+Shift+Q` | `flightpath.appendFromDashboard` | Append from dashboard |

---

## Layer 2: Webview Keyboard Shortcuts (React)

### When to use this layer

Use for any shortcut that must work **while the user is typing or interacting inside the webview** — especially inside the CodeMirror editor. This is the correct layer for `Ctrl+Enter` to send a prompt.

### Sub-layer A: Global webview shortcuts (document-level)

Best for shortcuts that should work regardless of which element has focus inside the webview.

```typescript
// Pattern used in PromptEditor.tsx and Modal.tsx
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && someCondition) {
      doAction();
    }
  };
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
}, [someCondition, doAction]);
```

### Sub-layer B: Component-level shortcuts (onKeyDown prop)

Best for shortcuts scoped to a specific interactive element (buttons, inputs, list items).

```tsx
// Pattern used throughout the codebase
<div
  role="button"
  tabIndex={0}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      handleClick();
    }
  }}
>
```

### Sub-layer C: CodeMirror keymap bindings (preferred for editor shortcuts)

**This is the correct approach for `Ctrl+Enter` in the prompt editor.** CodeMirror's `keymap` extension intercepts keyboard events before the browser's default handling and before document-level listeners.

```typescript
// In CodeMirrorEditor.tsx — add to the keymap.of([...]) array in the extensions list
import { keymap } from "@codemirror/view";

keymap.of([
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap,
  {
    key: "Ctrl-Enter", // CodeMirror uses hyphen, not plus
    mac: "Cmd-Enter",
    run: (view) => {
      onSubmit(); // Callback prop from parent
      return true; // true = event consumed, don't propagate
    },
  },
]);
```

**CodeMirror key format:** Uses hyphens (`Ctrl-Enter`), not plus signs (`Ctrl+Enter`). Modifier order: `Ctrl-Alt-Shift-Meta-Key`.

### Triggering extension host actions from the webview

When a webview shortcut needs to trigger extension host logic (e.g., running a workflow), use `postMessage`:

```typescript
// Webview side — post message to extension host
const vscode = getVsCodeApi();

vscode.postMessage({
  type: MESSAGE_TYPES.RUN_PROMPT,  // Use constants from src/types/messages.ts
  // ...payload
});

// Extension host side — handle in FlightPathWebviewProvider.ts
case MESSAGE_TYPES.RUN_PROMPT:
  flightPathManager.runPrompt(message.payload);
  break;
```

---

## Implementation Pattern: Ctrl+Enter to Send Prompt

This is the planned implementation. Here is the correct approach end-to-end:

### Step 1: Add `onSubmit` prop to `CodeMirrorEditor`

```typescript
// CodeMirrorEditor.tsx
interface CodeMirrorEditorProps {
  // ... existing props
  onSubmit?: () => void; // Called when Ctrl+Enter is pressed
}
```

### Step 2: Add CodeMirror keymap binding

```typescript
// In the extensions array inside the useEffect that initializes the editor
keymap.of([
  ...historyKeymap,
  ...searchKeymap,
  ...completionKeymap,
  {
    key: "Ctrl-Enter",
    mac: "Cmd-Enter",
    run: () => {
      onSubmitRef.current?.();
      return true;
    },
  },
]);
```

Use a ref for `onSubmit` (like `onChangeRef`) to avoid recreating the editor on prop changes.

### Step 3: Wire up in `PromptEditor.tsx`

`PromptEditor` already has access to `onRun` and `onQueue` from `EditorSection`. Pass the appropriate callback down to `CodeMirrorEditor`.

### Step 4: Respect disabled states

Check `isCLIManaged` and `hasContent` before firing:

```typescript
run: () => {
  if (!isCLIManaged && hasContent) {
    onSubmitRef.current?.();
  }
  return true;  // Always consume the event even if we don't act
},
```

---

## Existing Keyboard Shortcut Inventory (Webview)

| Key                     | Location                | Effect                        |
| ----------------------- | ----------------------- | ----------------------------- |
| `Escape`                | PromptEditor (document) | Close properties drawer       |
| `Escape`                | Modal (document)        | Close modal                   |
| `Escape`                | RunSelector             | Close dropdown                |
| `Escape`                | SplitButton             | Close dropdown, restore focus |
| `Enter`                 | SplitButton             | Select focused menu item      |
| `Enter` / `Space`       | SplitButton             | Open dropdown or navigate     |
| `ArrowDown` / `ArrowUp` | SplitButton             | Navigate menu items           |
| `Tab`                   | SplitButton             | Close dropdown                |
| `Enter`                 | SaveWorkflowDialog      | Save workflow                 |
| `Enter`                 | WorkflowStatus          | Confirm workflow name edit    |
| `Escape`                | WorkflowStatus          | Cancel workflow name edit     |
| `Enter`                 | TemplateModal           | Confirm template selection    |
| `Enter` / `Space`       | FinalPromptFooter       | Select final prompt item      |
| `Enter` / `Space`       | PromptItem              | Select prompt                 |
| `Enter`                 | RecentWorkflows         | Select workflow               |
| `Enter`                 | RunningWorkflowItem     | Click action                  |
| `Enter`                 | OutputSection           | Toggle collapse               |
| `Enter`                 | EditorSection           | Toggle collapse               |
| `Enter`                 | PromptsPanel            | Toggle collapse               |
| `Enter`                 | SettingsDrawer          | Close / toggle collapse       |
| `Enter`                 | PanelBar                | Activate button               |

---

## Accessibility Conventions

When making a non-button element keyboard-interactive:

```tsx
<div
  role="button"         // Required for screen readers
  tabIndex={0}          // Required to receive focus
  onClick={handleClick}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // Prevent page scroll on Space
      handleClick();
    }
  }}
>
```

Always handle both `Enter` and `Space` for `role="button"` elements per ARIA spec.

---

## Key Formatting Cheat Sheet

| Context                    | Format                            | Example                                   |
| -------------------------- | --------------------------------- | ----------------------------------------- |
| `package.json` keybindings | `ctrl+key` lowercase              | `"ctrl+shift+enter"`                      |
| `package.json` mac variant | `cmd+key` lowercase               | `"cmd+shift+enter"`                       |
| CodeMirror `keymap.of`     | `Ctrl-Key` PascalCase with hyphen | `"Ctrl-Enter"`                            |
| CodeMirror mac variant     | `Cmd-Key`                         | `"Cmd-Enter"`                             |
| React `onKeyDown`          | `e.key` values                    | `"Enter"`, `"Escape"`, `"ArrowDown"`      |
| VS Code `when` clause      | exact view ID string              | `"focusedView == 'flightpath.dashboard'"` |
