# Undo/Redo Support for the Dashboard

## Background

The dashboard's `CodeMirrorEditor` already has built-in undo/redo for prompt text (via CodeMirror 6's history extension). The rest of the dashboard — prompt list mutations (add, remove, reorder), prompt property edits once committed, and workflow-level settings — has no undo support.

This document describes how to implement undo/redo for the dashboard.

---

## VS Code API Assessment

**VS Code exposes no undo/redo hook for `WebviewViewProvider` (sidebar panels).** The only supported mechanism is `CustomEditorProvider`, which is architecturally tied to file-backed documents opened as editor tabs — not applicable to FlightPath's sidebar dashboard.

Implications:
- Ctrl+Z in the webview is captured by the webview's own JS event loop before VS Code's keybinding service sees it. We can intercept it cleanly with `window.addEventListener('keydown', ...)`.
- When a CodeMirror editor is focused, CodeMirror handles Ctrl+Z for its own text history. When the rest of the dashboard is focused, we handle it at the React level.
- No extension-host changes needed. Undo/redo is entirely self-contained in the webview.

---

## Scope: What Is and Is Not Undoable

### Undoable (tracked in history)
These are "document" edits — changes to the workflow definition:

| Action | Triggered by |
|--------|-------------|
| Add prompt | "Add" / queue button in new prompt mode |
| Delete prompt | Delete button on prompt item |
| Reorder prompts | Drag-and-drop reorder |
| Edit prompt (save) | "Save" button in edit mode commits changes to `workflowStore.prompts` |
| Rename workflow | Workflow name field edit |
| Edit/clear final prompt | Final prompt edit committed via save |

### Not Undoable
| Action | Reason |
|--------|--------|
| Start workflow | Not a document edit; begins async execution |
| Stop/pause workflow | Runtime control action |
| Load workflow from disk | Full replacement — not incremental edit |
| Draft editor text (before Save) | CodeMirror handles its own undo for in-progress typing |
| CLI outputs / retry state | Runtime data, not user-editable workflow definition |

---

## Technical Approach: `zundo` Temporal Middleware

[`zundo`](https://github.com/charkour/zundo) is a zero-dependency undo/redo middleware for Zustand (<700B). It adds `pastStates` and `futureStates` arrays to a Zustand store and exposes `undo()` / `redo()` / `clear()` functions.

### Why `zundo`

- No VS Code API hook exists — `zundo` is the right abstraction layer.
- `partialize` option limits history to only the undoable fields (excludes runtime state entirely).
- `limit` option prevents unbounded memory growth.
- History is reactive — `pastStates.length > 0` can drive button enabled state.
- Works seamlessly with the existing Zustand store architecture.

---

## Implementation Plan

### Step 1: Install `zundo`

```bash
cd src/ui/webview-react
npm install zundo
```

### Step 2: Define the Undoable State Slice

The undoable fields in `workflowStore` are:

```typescript
interface UndoableWorkflowState {
  prompts: PromptItem[];
  workflowName: string | null;
  finalPrompt: PromptItem | null;
}
```

Everything else in `workflowStore` (`executionState`, `currentStep`, `cliOutputs`, `retryStates`, `statusMessages`, `streamingChunks`, `historyOutputs`, etc.) is **excluded** from history.

### Step 3: Wrap `workflowStore` with `temporal`

In `workflowStore.ts`:

```typescript
import { create } from "zustand";
import { temporal } from "zundo";

// Replace:
export const useWorkflowStore = create<WorkflowState & WorkflowActions & WorkflowSelectors>(
  (set, get) => ({ ... })
);

// With:
export const useWorkflowStore = create<WorkflowState & WorkflowActions & WorkflowSelectors>()(
  temporal(
    (set, get) => ({ ... }),
    {
      // Only snapshot the undoable fields
      partialize: (state): UndoableWorkflowState => ({
        prompts: state.prompts,
        workflowName: state.workflowName,
        finalPrompt: state.finalPrompt,
      }),
      limit: 100,
    }
  )
);
```

The `temporal` middleware creates a companion store accessible via `useWorkflowStore.temporal`.

### Step 4: Suppress History for Non-User Actions

`zundo` records a snapshot before every `set()` call. Some `set()` calls are driven by incoming extension messages (e.g. `loadWorkflow`, `setExecutionState`, `addCliOutput`) and should **not** generate undo entries.

`zundo` v2+ provides a `pause()` / `resume()` API on the temporal store to suppress recording during bulk operations:

```typescript
// In loadWorkflow action (and other server-driven setters):
loadWorkflow: (data) => {
  useWorkflowStore.temporal.getState().pause();
  set({ ... }); // This set() will not be added to history
  useWorkflowStore.temporal.getState().resume();
},
```

Actions that **should** generate undo entries (called only by user interaction):
- `setPrompts` (reorder)
- `updatePrompt` (edit via Save button)
- `setWorkflowName`
- `setFinalPrompt`

Actions that should **not** generate undo entries (driven by extension host messages or runtime):
- `loadWorkflow` — full replacement from disk
- `resetWorkflow` — full reset
- `resetExecutionState`
- `setExecutionState`, `setCurrentStep`, `setTotalSteps`
- `addCliOutput`, `addFinalPromptOutput`, `clearCliOutputs`
- `appendStreamingChunk`, `appendStreamingEvents`, `clearStreamingChunk`
- `setRetryState`, `clearRetryState`
- `addStatusMessage`, `addFinalPromptStatusMessage`, `clearStatusMessages`
- `setStepStatus` (driven by execution, not user)
- `loadHistoryRun`, `clearHistoryOutputs`
- `promoteHistoryToLive`, `clearRuntimeStateFromStep`, `clearAllRuntimeState`

The cleanest implementation: wrap every non-user `set()` call with `pause()`/`resume()` in the action body. This is explicit and co-located with each action.

### Step 5: Export a Typed Temporal Store Hook

In `workflowStore.ts`, export a hook for consuming temporal state reactively:

```typescript
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { TemporalState } from "zundo";

export const useWorkflowTemporalStore = <T>(
  selector: (state: TemporalState<UndoableWorkflowState>) => T
): T =>
  useStoreWithEqualityFn(useWorkflowStore.temporal, selector, Object.is);
```

Usage in components:

```typescript
const canUndo = useWorkflowTemporalStore((s) => s.pastStates.length > 0);
const canRedo = useWorkflowTemporalStore((s) => s.futureStates.length > 0);
const { undo, redo } = useWorkflowTemporalStore((s) => s);
```

### Step 6: Global Keyboard Handler

Create a component `UndoRedoKeyHandler` (or a hook `useUndoRedoKeyHandler`) that intercepts Ctrl+Z and Ctrl+Y/Ctrl+Shift+Z at the window level:

```typescript
// src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts

import { useEffect } from "react";
import { useWorkflowStore } from "../store/workflowStore";

export function useUndoRedoKeyHandler() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept if a text input / CodeMirror editor is focused —
      // let the focused element handle its own undo/redo.
      const target = e.target as HTMLElement;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.closest(".codemirror-editor") !== null;

      if (isTextInput) return;

      const isUndo = (e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey;
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" || (e.key === "z" && e.shiftKey));

      if (!isUndo && !isRedo) return;

      e.preventDefault();
      e.stopPropagation();

      const temporal = useWorkflowStore.temporal.getState();
      if (isUndo) temporal.undo();
      else temporal.redo();
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}
```

Mount this hook in `App.tsx`.

**Why `capture: true`:** Ensures our handler runs before the event reaches any child element (like CodeMirror's keymap), so we can properly check `target` before deciding whether to pass through.

### Step 7: Clear History on Workflow Load

When a workflow is loaded from disk (via `loadWorkflow`), the undo history should be cleared — the loaded state is the baseline:

```typescript
loadWorkflow: (data) => {
  const temporal = useWorkflowStore.temporal.getState();
  temporal.pause();
  set({ ... });
  temporal.resume();
  temporal.clear(); // Clear history — loaded state is the new baseline
},
```

Also clear on `resetWorkflow`.

### Step 8: UI — Undo/Redo Toolbar Buttons (Optional)

Add Undo/Redo icon buttons to the dashboard toolbar area. They should:
- Be disabled when `canUndo`/`canRedo` is false
- Show a tooltip on hover ("Undo" / "Redo")
- Use VS Code codicons (the codebase likely already imports them)

This is a nice-to-have; keyboard shortcuts are sufficient for MVP.

---

## Edge Cases

### CodeMirror Interaction
CodeMirror 6 has its own history extension managing per-editor undo for prompt text while the user is typing. Our handler checks for `.codemirror-editor` ancestry and passes through — CodeMirror handles its own undo. When the user clicks "Save", the committed text change records a snapshot in `workflowStore.temporal` via the `updatePrompt` action. This means:
- **Ctrl+Z while typing in editor** → CodeMirror undoes the text change (correct)
- **Ctrl+Z after clicking Save (focus outside editor)** → our handler fires, reverts the entire saved prompt to its previous state (correct)

### Workflow Running
Undo should be disabled (or no-op) while a workflow is running/paused, since prompts being actively executed should not be mutated. Add a guard in the keyboard handler:

```typescript
const isRunning = useWorkflowStore.getState().isWorkflowRunning();
if (isRunning) return;
```

Or disable the undo/redo buttons when `executionState !== IDLE`.

### History Across Webview Reloads
VS Code may recreate the webview when hidden (if `retainContextWhenHidden` is false). In this case, the in-memory undo history is lost. This is acceptable — the workflow state is restored from the extension host, and the restored state becomes the new baseline (history cleared on `loadWorkflow`).

### `pause()`/`resume()` Thread Safety
`pause()`/`resume()` are synchronous in `zundo`. Since JS is single-threaded, the pattern is safe as long as the `set()` call between them is synchronous (which it always is in Zustand).

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/ui/webview-react/store/workflowStore.ts` | Wrap with `temporal` middleware; add `pause()`/`resume()` around non-user actions; export `useWorkflowTemporalStore` hook and `UndoableWorkflowState` type |
| `src/ui/webview-react/hooks/useUndoRedoKeyHandler.ts` | New hook — global keyboard handler |
| `src/ui/webview-react/App.tsx` | Mount `useUndoRedoKeyHandler` |
| `src/ui/webview-react/package.json` | Add `zundo` dependency |
| Toolbar component (TBD) | Optional: Undo/Redo icon buttons |

---

## Non-Goals

- Syncing undo history to the extension host or `.flightpath/` files — in-memory only
- Undo for workflow-level settings in the Settings panel (separate store; lower priority)
- Per-field undo inside the editor before Save (CodeMirror already handles this)
