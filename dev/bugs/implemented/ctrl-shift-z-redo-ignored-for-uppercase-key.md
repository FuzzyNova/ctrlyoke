# Ctrl+Shift+Z redo is ignored because e.key is uppercase "Z" when Shift is held

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts`
- **Resolution:** fixed in this commit

## Symptom

In the dashboard, outside a text input or CodeMirror editor, Ctrl+Shift+Z does not redo a step edit. The same applies to Cmd+Shift+Z on macOS when the browser reports `"Z"`. Only Ctrl+Y redoes. With verbose webview logging on, the debug line reads `key=Z shift=true isUndo=false isRedo=false`. Ctrl+Z also does nothing while Caps Lock is on.

The broken shortcut is documented as the redo key in `docs/guide/prompt-editor.md` ("Ctrl+Z / Ctrl+Shift+Z | Undo / redo") and `dev/reference/KEYBOARD_SHORTCUTS.md`.

## Steps to Reproduce

1. Open the ctrlyoke dashboard (VS Code webview or hosted browser) on Windows, with no workflow running or paused.
2. Make an undoable step edit, such as reordering or deleting a step.
3. Click empty dashboard space (not a text field or editor) and press Ctrl+Z. The edit is undone.
4. Press Ctrl+Shift+Z. Expected: the edit is redone. Actual: nothing happens. With verbose webview logging, the `[UndoRedo] keydown` line shows `key=Z shift=true isUndo=false isRedo=false`.
5. Press Ctrl+Y. The redo works, so only the Shift+Z path is broken.

## Root Cause

`src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts:161-163` pre-filters on `e.key` being `"z"`, `"y"` or `"Z"`. That means it expects the shifted form. The classification below it is case-sensitive, though:

```ts
const isUndo = (e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey;   // line 174
const isRedo =
  (e.ctrlKey || e.metaKey) &&
  (e.key === "y" || (e.key === "z" && e.shiftKey));                         // lines 175-177
```

With Shift held, Chromium reports `e.key === "Z"`. Neither check matches, and line 189 (`if (!isUndo && !isRedo) return;`) exits before `temporal.redo()` is called. Caps Lock without Shift also produces `"Z"`, so the undo check fails as well.

`src/ui/webview-react/hooks/useNewWorkflowKeyHandler.ts:21` already lowercases `e.key` before comparing. This handler does not.

## Suggested Fix

Lowercase the key once at the top of the handler (`const key = e.key.toLowerCase();`) and use it everywhere:

- pre-filter: `key === "z" || key === "y"`
- `isUndo = mod && key === "z" && !e.shiftKey`
- `isRedo = mod && (key === "y" || (key === "z" && e.shiftKey))`

Add Vitest cases under `src/ui/webview-react/test/hooks/`:

- `{ key: "Z", ctrlKey: true, shiftKey: true }` triggers redo.
- `{ key: "Z", ctrlKey: true }` with no Shift (the Caps Lock case) triggers undo.

## Decision

Normalize `e.key` once before classifying shortcuts, so uppercase `Z` works
for undo and redo without changing the documented key combinations.
