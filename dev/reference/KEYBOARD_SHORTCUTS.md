# ctrlyoke Keyboard Shortcuts Reference

## Architecture Overview

ctrlyoke has two distinct layers where keyboard shortcuts live, and they operate independently:

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

**Visibility rule:** Only `package.json` keybindings appear in VS Code's Keyboard Shortcuts editor (`Ctrl+K Ctrl+S`). CodeMirror `keymap.of()` bindings and React `onKeyDown`/`document.addEventListener` handlers are invisible to VS Code — users cannot see or rebind them there. This doc is the source of truth for those.

---

## Conflict Avoidance

### The `when` clause is the primary tool

VS Code resolves conflicts by **specificity** — a more specific `when` clause wins over a more general one. All ctrlyoke `package.json` bindings use `focusedView == 'ctrlyoke.dashboard'`, so they only activate in context and override any global binding for the same key combination.

```json
// Our Ctrl+Shift+N overrides VS Code's "new window" only when ctrlyoke is focused
"when": "focusedView == 'ctrlyoke.dashboard'"
```

### Checking for conflicts before adding a new binding

1. Open VS Code Keyboard Shortcuts editor: `Ctrl+K Ctrl+S`
2. Search for the intended key combo to see all commands currently bound to it
3. Inspect `when` clauses — if another binding uses the same key with an overlapping `when`, it's a real conflict

### `Ctrl+Enter` in the webview is not a VS Code-layer conflict

The Prompt Editor's `Ctrl+Enter` (Run) and `Ctrl+Shift+Enter` (Queue) are wired entirely inside the CodeMirror instance in the webview iframe — they are **not** registered in `package.json`, so they never go through VS Code's command/keybinding resolution at all. There is no `when`-clause conflict to manage for them; the only thing that matters is precedence _inside_ CodeMirror's own keymap facet (see below).

### Known VS Code built-in conflicts to watch (for future `package.json` bindings)

| Key            | Built-in use                      | Our `when` clause avoids it?                                                                                                                                                                                                                                                                                      |
| -------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+Shift+N` | New window (global)               | Declared with a `focusedView` clause in `package.json`, but confirmed non-functional in practice — see the caveat below the "Existing VS Code keybindings" table. The working `Ctrl+Shift+N` (new workflow from template) is implemented webview-only via `useNewWorkflowKeyHandler`, same as `Ctrl+Enter` below. |
| `Ctrl+N`       | New file (global)                 | N/A — ctrlyoke's `Ctrl+N` (new blank workflow) is webview-only via `useNewWorkflowKeyHandler`, never reaches VS Code's command layer                                                                                                                                                                              |
| `Ctrl+Enter`   | Copilot Chat send (`inChatInput`) | N/A — ctrlyoke's `Ctrl+Enter` is webview-only, never reaches VS Code's command layer                                                                                                                                                                                                                              |
| `Ctrl+Shift+T` | Reopen closed tab (global)        | Declared with a `focusedView` clause in `package.json`, but confirmed non-functional in practice — same caveat as `Ctrl+Shift+N` above.                                                                                                                                                                           |

### Key combos with low VS Code occupancy (safe to use for new `package.json` bindings)

- `Ctrl+Shift+*` — most combinations are unbound globally
- `Ctrl+Alt+*` — mostly free outside specific editor contexts
- Avoid plain `Ctrl+*` without a scoped `when` clause

---

## Layer 1: VS Code Shell Keybindings (package.json)

### When to use this layer

Use for shortcuts that should work when the ctrlyoke panel is focused **but focus is not inside the webview content** (e.g., keyboard navigation to the panel, command palette equivalents). Also register here any shortcut you want visible in VS Code's Keyboard Shortcuts editor, even if the primary handler lives in the webview.

### How to add a VS Code keybinding

**1. Register the keybinding in `package.json` (`contributes.keybindings`):**

```json
{
  "command": "ctrlyoke.myCommand",
  "key": "ctrl+shift+x",
  "mac": "cmd+shift+x",
  "when": "focusedView == 'ctrlyoke.dashboard'"
}
```

**2. Register the command handler in `src/extension.ts`.**

**3. Declare the command in `package.json` `contributes.commands`.**

### `when` clause options for the ctrlyoke dashboard

| `when` clause                                  | Fires when                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `focusedView == 'ctrlyoke.dashboard'`          | ctrlyoke sidebar panel has keyboard focus (regardless of whether webview content has focus) |
| `activeWebviewPanelId == 'ctrlyoke.dashboard'` | A ctrlyoke webview panel is the active editor (not sidebar)                                 |

**Note:** Both clauses require VS Code itself to have the focus — neither fires while focus is inside the webview iframe.

### Existing VS Code keybindings

| Key (Win/Linux) | Key (Mac)     | Command                        | Action                |
| --------------- | ------------- | ------------------------------ | --------------------- |
| `Ctrl+Shift+N`  | `Cmd+Shift+N` | `ctrlyoke.clearWorkflow`       | Clear workflow state  |
| `Ctrl+Shift+T`  | `Cmd+Shift+T` | `ctrlyoke.newWorkflow`         | New workflow          |
| `Ctrl+Shift+L`  | `Cmd+Shift+L` | `ctrlyoke.selectPromptFile`    | Select prompt file    |
| `Ctrl+Shift+Q`  | `Cmd+Shift+Q` | `ctrlyoke.appendFromDashboard` | Append from dashboard |

All scoped to `when: focusedView == 'ctrlyoke.dashboard'`. Source: `package.json` `contributes.keybindings`.

**Confirmed non-functional in practice (2026-08):** none of the four fire, because the ctrlyoke dashboard is always a webview and, per the note above, `focusedView`/`activeWebviewPanelId` keybindings never fire while focus is inside the webview iframe — which is effectively always, since there's no non-webview part of the panel to focus. Treat this table as a record of what's declared in `package.json`, not as a description of working shortcuts. New shortcuts (e.g. `Ctrl+N` / `Ctrl+Shift+N`, added below) are implemented as Layer 2 webview-level handlers instead — see the pattern already proven out by `Ctrl+Z`/`Ctrl+F`/etc. in the inventory further down.

---

## Layer 2: Webview Keyboard Shortcuts (React + CodeMirror)

### Sub-layer A: Global webview shortcuts (document/window-level)

Best for shortcuts that should work regardless of which element has focus inside the webview.

```typescript
// Pattern used in PromptEditor.tsx, Modal.tsx, useUndoRedoKeyHandler.ts, OutputSection.tsx
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && someCondition) {
      doAction();
    }
  };
  window.addEventListener("keydown", handleKeyDown, { capture: true });
  return () =>
    window.removeEventListener("keydown", handleKeyDown, { capture: true });
}, [someCondition, doAction]);
```

Use `capture: true` when the shortcut needs to win over element-level handlers or VS Code's own webview keydown forwarding (see `Ctrl+F` in `OutputSection.tsx` and undo/redo in `useUndoRedoKeyHandler.ts`).

### Sub-layer B: Component-level shortcuts (onKeyDown prop)

Best for shortcuts scoped to a specific interactive element (buttons, inputs, list items). The dominant pattern in the codebase is `Enter`/`Space` activating a `role="button"` `div` — see Accessibility Conventions below.

### Sub-layer C: CodeMirror keymap bindings (used for editor-scoped shortcuts)

CodeMirror's `keymap` extension intercepts keyboard events before the browser's default handling and before document-level listeners, as long as the CodeMirror view has focus.

```typescript
// CodeMirrorEditor.tsx — Ctrl-Enter / Ctrl-Shift-Enter live in a *separate*,
// Prec.highest-wrapped keymap.of([...]) extension — see the gotcha below.
Prec.highest(
  keymap.of([
    {
      key: "Ctrl-Shift-Enter",
      run: () => {
        onQueueRef.current?.();
        return true;
      },
    },
    {
      key: "Ctrl-Enter",
      run: () => {
        onRunRef.current?.();
        return true;
      },
    },
  ])
);
```

**CodeMirror key format:** Uses hyphens (`Ctrl-Enter`), not plus signs (`Ctrl+Enter`). Modifier order: `Ctrl-Alt-Shift-Meta-Key`.

**Gotcha — `minimalSetup` already claims `Mod-Enter`:** `minimalSetup` (from the `codemirror` package) bundles CodeMirror's `defaultKeymap`, which binds `Mod-Enter` (`Ctrl-Enter` on Windows/Linux, `Cmd-Enter` on macOS) to `insertBlankLine`. Because `minimalSetup` is listed _before_ the app's own `keymap.of([...])` in the `extensions` array passed to `EditorView`, its binding is flattened into CodeMirror's internal keymap first — so on Windows/Linux, an unboosted `Ctrl-Enter` binding added later would lose to `insertBlankLine` and just insert a newline instead of firing `onRun`. The fix is wrapping the run/queue keymap in `Prec.highest(...)`, kept as its own extension separate from the main `keymap.of([...historyKeymap, ...searchKeymap, ...completionKeymap, ...lintKeymap, ...])` array. `Tab` deliberately stays in the _unboosted_ array, positioned after `...completionKeymap`, so completion-accept still wins when a dropdown is open — don't move it into the boosted keymap.

`insertBlankLine` (the command we're overriding) is not the same thing as plain `Enter`: plain `Enter` (`insertNewlineAndIndent`, from `standardKeymap`, still active and unaffected) splits the line at the cursor. `insertBlankLine` ignores cursor position and inserts a fresh indented line below the current one — CodeMirror's "insert line below" convenience, not core newline behavior. That's the only functionality traded away by claiming `Ctrl-Enter`.

`Ctrl-Shift-Enter` (queue) has no such conflict — checked across `defaultKeymap`, `historyKeymap`, `searchKeymap`, `completionKeymap`, and `lintKeymap`, none bind it — but it still lives in the boosted keymap for consistency with Run.

**Why literal `Ctrl-Enter`, not `Mod-Enter`:** The Run shortcut intentionally uses literal `Ctrl` on every platform, including macOS (rather than `Mod-Enter`, which would map to `Cmd-Enter` there). This is a deliberate branding choice — leaning into the "ctrlyoke" name — not an oversight.

### Triggering extension host actions from the webview

When a webview shortcut needs to trigger extension host logic, use `postMessage` with constants from `src/types/messages.ts`, handled in `WebviewMessageRouter.ts`.

---

## Existing Keyboard Shortcut Inventory (Webview)

### Prompt Editor (CodeMirror keymap — `CodeMirrorEditor.tsx`)

| Key                | Effect                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ |
| `Ctrl+Enter`       | Run — queue (if needed) and run/send the prompt                                      |
| `Ctrl+Shift+Enter` | Queue — add the prompt to the execution queue without running                        |
| `Ctrl+F` / `Cmd+F` | Open CodeMirror's search panel (editor-scoped find)                                  |
| `Tab`              | Accept the active completion if a dropdown is open; otherwise insert a tab character |

### Global (window/document-level, work anywhere in the webview)

| Key                                      | Location                                     | Effect                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+Z` / `Cmd+Z`                       | `useUndoRedoKeyHandler` (window)             | Undo the last workflow edit. Ignored when a text input, textarea, or CodeMirror editor has focus (they get their own undo), and blocked while a workflow is actively running. |
| `Ctrl+Y` or `Ctrl+Shift+Z` / `Cmd` equiv | `useUndoRedoKeyHandler` (window)             | Redo — same focus/active-workflow guards as undo.                                                                                                                             |
| `Ctrl+F` / `Cmd+F`                       | `OutputSection` (window, capture)            | Open the output-pane find bar — only when focus is **not** inside a CodeMirror editor (which handles its own `Ctrl+F` first).                                                 |
| `Ctrl+N` / `Cmd+N`                       | `useNewWorkflowKeyHandler` (window, capture) | New blank workflow — same action as the "New" split button's main click (posts `CLEAR_WORKFLOW`). Ignored when a text input, textarea, or CodeMirror editor has focus.        |
| `Ctrl+Shift+N` / `Cmd+Shift+N`           | `useNewWorkflowKeyHandler` (window, capture) | New workflow from template — same action as "New From Template..." in the split button dropdown (posts `NEW_WORKFLOW`, which opens the template modal). Same focus guard.     |
| `Escape`                                 | `Modal`                                      | Close the open modal                                                                                                                                                          |
| `Escape`                                 | `GlobalSettingsDrawer`                       | Close the global settings drawer                                                                                                                                              |
| `Escape`                                 | `PromptEditor`                               | Close the properties drawer                                                                                                                                                   |
| `Escape`                                 | `HistorySearchDrawer`                        | Close the history search drawer                                                                                                                                               |
| `Escape`                                 | `StepContextMenu`                            | Close the open context menu                                                                                                                                                   |

### Output find bar (`useOutputFind` / `OutputFindBar`)

| Key           | Effect                     |
| ------------- | -------------------------- |
| `Enter`       | Jump to the next match     |
| `Shift+Enter` | Jump to the previous match |
| `F3`          | Next match                 |
| `Shift+F3`    | Previous match             |
| `Escape`      | Close the find bar         |

### Component-scoped `Enter`/`Space` activation

Standard `role="button"` accessibility pattern (see Accessibility Conventions) applied throughout the dashboard, including: `SplitButton` (also `ArrowDown`/`ArrowUp` to navigate menu items, `Escape` to close and restore focus, `Tab` to close the dropdown), `RunSelector` (`Escape` to close), `SaveWorkflowDialog` (`Enter` to save), `WorkflowStatus` (`Enter` to confirm a workflow rename, `Escape` to cancel), `TemplateModal` (`Enter` to confirm template selection), `McpManagerSection` and `AgentSkillsManagerSection` (`Enter` to confirm inline edits), `FinalStepFooter`, `PromptChipRail`, `WorkflowStep`, `OutputRow`, `OutputMinimap` (select/expand items), `PanelBar`, `EditorSection`, `OutputSection`, `WorkflowPropertiesPanel`, `OutputSectionHeader` (toggle collapse/expand).

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

| Context                    | Format                                                                                                                                | Example                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `package.json` keybindings | `ctrl+key` lowercase                                                                                                                  | `"ctrl+shift+enter"`                    |
| `package.json` mac variant | `cmd+key` lowercase                                                                                                                   | `"cmd+shift+enter"`                     |
| CodeMirror `keymap.of`     | `Ctrl-Key` PascalCase with hyphen                                                                                                     | `"Ctrl-Enter"`                          |
| CodeMirror mac variant     | `Cmd-Key` (or `Mod-Key` if the combo should follow OS convention) — **not used** for Run/Queue, which stay literal `Ctrl` on every OS | `"Cmd-Enter"`                           |
| React `onKeyDown`          | `e.key` values                                                                                                                        | `"Enter"`, `"Escape"`, `"ArrowDown"`    |
| VS Code `when` clause      | exact view ID string                                                                                                                  | `"focusedView == 'ctrlyoke.dashboard'"` |
