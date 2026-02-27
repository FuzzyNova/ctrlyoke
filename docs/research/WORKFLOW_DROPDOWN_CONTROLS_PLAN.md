# Workflow Dropdown Controls Plan

## Overview

Enhance the `WorkflowStatus` dropdown with two UX improvements:

1. **Delete individual recent workflow entries** — trash/X codicon on the far right of each row in the "Workflows" (recent history) section.
2. **Playback controls in the Running Workflows section** — contextual play/pause and stop buttons for each active workflow entry, replacing the passive status display.

---

## Feature 1: Delete Individual Recent Workflows

### Current State

`RecentWorkflows.tsx` has a single "Clear History" footer button that nukes all entries. There is no way to remove a single entry from the list.

### Desired Behavior

- Each row in the "Workflows" section gets a `codicon-trash` (or `codicon-close`) button anchored to the far right.
- Button is **only visible on hover** of that row (reduces visual noise; consistent with VS Code tree view patterns).
- Clicking the remove button:
  1. Stops propagation so it doesn't also trigger `onSelect`.
  2. Sends a new message to the extension to delete that single history entry.
  3. Optimistically removes the entry from the local `recentWorkflows` state in `WorkflowStatus.tsx`.
- The "Clear History" footer remains unchanged.

### New Message Type

Add to `DashboardConstants.ts` `MESSAGE_TYPES`:

```typescript
REMOVE_WORKFLOW_HISTORY: "removeWorkflowHistory", // Webview -> Extension: Remove single history entry { filePath }
```

### Extension Handler

In `FlightPathWebviewProvider.ts` `handleWebviewMessage()`, add a case for `REMOVE_WORKFLOW_HISTORY`:

```typescript
case MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY: {
  const { filePath } = message;
  await this.outputHistoryManager?.removeHistoryEntry(filePath); // or equivalent
  // No response needed — webview already optimistically removed it
  break;
}
```

The extension-side implementation will call into whichever service manages the `.flightpath/.history/` or recent-workflows file to remove the single entry. Exact method TBD during implementation based on how `clearWorkflowHistory` is currently handled.

### Component Changes

**`RecentWorkflows.tsx`**

Add optional `onRemove` prop:

```typescript
interface RecentWorkflowsProps {
  // ...existing...
  onRemove?: (filePath: string) => void;
}
```

Change each row from a `<button>` to a `<div role="button">` wrapper so the inner action button doesn't nest `<button>` inside `<button>`. Layout:

```
[ Workflow Name (flex-1, truncate) ]  [ State Badge ]  [ Time ]  [ 🗑 ]
```

- Trash icon: `<i className="codicon codicon-trash" />` — 14px, `text-description-fg`, turns `text-error-fg` on hover.
- The icon itself is in a `<button>` that stops propagation and calls `onRemove(filePath)`.
- Wrap the whole row in `group` Tailwind class; trash button uses `opacity-0 group-hover:opacity-100 focus:opacity-100` so it hides when not focused/hovered.

**`WorkflowStatus.tsx`**

Wire up `onRemove`:

```typescript
const handleRemoveWorkflow = useCallback(
  (filePath: string) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.REMOVE_WORKFLOW_HISTORY,
      filePath,
    });
    // Optimistic update
    setRecentWorkflows((prev) => prev.filter((w) => w.filePath !== filePath));
  },
  [vscode]
);
```

Pass to `<RecentWorkflows onRemove={handleRemoveWorkflow} ... />`.

---

## Feature 2: Play/Pause & Stop Controls in Running Workflows Section

### Current State

`RunningWorkflowItem.tsx` is a passive display card — shows status icon, name, state badge, and elapsed time. No actions. The existing `PAUSE`, `RESUME`, and `STOP` message types operate on whichever workflow is currently **active** in the extension (i.e. the one the webview panel is showing). They do not accept a `workflowId`.

### Desired Behavior

Each `RunningWorkflowItem` shows contextual action buttons on the far right:

| Workflow state           | Buttons shown                                               |
| ------------------------ | ----------------------------------------------------------- |
| `RUNNING`                | `codicon-debug-pause` (Pause) + `codicon-debug-stop` (Stop) |
| `PAUSED`                 | `codicon-play` (Resume) + `codicon-debug-stop` (Stop)       |
| `STOPPED` / `CANCELLING` | _(no buttons — already stopping)_                           |

- Buttons are always visible (not hover-gated) because these are active live processes.
- Clicking Pause/Resume/Stop sends a targeted message carrying `workflowId` so the extension can route to the correct instance.
- Stop button renders in a dimmer color until hovered, then `text-error-fg`, to avoid drawing too much visual alarm for a normal action.

### New Message Types

Add to `DashboardConstants.ts`:

```typescript
// Multi-workflow targeted controls — Webview → Extension
PAUSE_WORKFLOW:  "pauseWorkflow",  // Pause specific workflow: { workflowId }
RESUME_WORKFLOW: "resumeWorkflow", // Resume specific workflow: { workflowId }
STOP_WORKFLOW:   "stopWorkflow",   // Stop specific workflow: { workflowId }
```

> **Why not reuse `PAUSE` / `RESUME` / `STOP`?**
> The existing messages have no `workflowId` payload. They are handled for the single active workflow and are used in other parts of the UI (header buttons). Adding optional `workflowId` to them creates ambiguity. Clean new message types are preferred — consistent with the SOLID/DRY principle of one message type per intent.

### Extension Handler

In `FlightPathWebviewProvider.ts`, add cases that delegate to `FlightPathManager` with the targeted ID:

```typescript
case MESSAGE_TYPES.PAUSE_WORKFLOW:
  await this.flightPathManager?.pauseWorkflow(message.workflowId);
  break;

case MESSAGE_TYPES.RESUME_WORKFLOW:
  await this.flightPathManager?.resumeWorkflow(message.workflowId);
  break;

case MESSAGE_TYPES.STOP_WORKFLOW:
  await this.flightPathManager?.stopWorkflow(message.workflowId);
  break;
```

`FlightPathManager` already maintains a map of active workflow instances (used by `SWITCH_WORKFLOW` and `WORKFLOW_DISMISSED`). These methods will look up the instance by ID and call its existing `pause()` / `resume()` / `stop()` methods.

### Component Changes

**`RunningWorkflowItem.tsx`**

Add props for the three actions:

```typescript
interface RunningWorkflowItemProps {
  workflow: WorkflowSummary;
  isCurrent: boolean;
  onClick: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}
```

Add the action button cluster to the right side of the item (before or after elapsed time):

```tsx
{
  /* Action buttons — only for active states */
}
{
  (isRunning || isPaused) && (
    <div
      className="flex items-center gap-1 flex-shrink-0"
      onClick={(e) => e.stopPropagation()} // prevent triggering onClick (switch)
    >
      {isRunning ? (
        <button
          title="Pause"
          onClick={onPause}
          className="p-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
        >
          <i className="codicon codicon-debug-pause" />
        </button>
      ) : (
        <button
          title="Resume"
          onClick={onResume}
          className="p-0.5 rounded text-description-fg hover:text-foreground hover:bg-toolbar-hover-bg transition-colors"
        >
          <i className="codicon codicon-play" />
        </button>
      )}

      <button
        title="Stop"
        onClick={onStop}
        className="p-0.5 rounded text-description-fg hover:text-error-fg hover:bg-toolbar-hover-bg transition-colors"
      >
        <i className="codicon codicon-debug-stop" />
      </button>
    </div>
  );
}
```

**`WorkflowStatus.tsx`**

Add three handler functions and pass them to each `RunningWorkflowItem`:

```typescript
const handlePauseWorkflow = useCallback(
  (workflowId: string) => {
    vscode.postMessage({ type: MESSAGE_TYPES.PAUSE_WORKFLOW, workflowId });
  },
  [vscode]
);

const handleResumeWorkflow = useCallback(
  (workflowId: string) => {
    vscode.postMessage({ type: MESSAGE_TYPES.RESUME_WORKFLOW, workflowId });
  },
  [vscode]
);

const handleStopWorkflow = useCallback(
  (workflowId: string) => {
    vscode.postMessage({ type: MESSAGE_TYPES.STOP_WORKFLOW, workflowId });
  },
  [vscode]
);
```

Pass into the rendered list:

```tsx
{
  loadedWorkflows.map((workflow) => (
    <RunningWorkflowItem
      key={workflow.id}
      workflow={workflow}
      isCurrent={workflow.id === activeWorkflowId}
      onClick={() => handleSwitchWorkflow(workflow.id)}
      onPause={() => handlePauseWorkflow(workflow.id)}
      onResume={() => handleResumeWorkflow(workflow.id)}
      onStop={() => handleStopWorkflow(workflow.id)}
    />
  ));
}
```

---

## Implementation Order

1. **`DashboardConstants.ts`** — add 4 new message type constants (`REMOVE_WORKFLOW_HISTORY`, `PAUSE_WORKFLOW`, `RESUME_WORKFLOW`, `STOP_WORKFLOW`).
2. **`RecentWorkflows.tsx`** — add `onRemove` prop, convert row to `group` container with hover-gated trash button.
3. **`RunningWorkflowItem.tsx`** — add `onPause`, `onResume`, `onStop` props and action button cluster.
4. **`WorkflowStatus.tsx`** — wire up all new handlers, pass props down.
5. **`FlightPathWebviewProvider.ts`** — add `handleWebviewMessage` cases for the 4 new types.
6. **`FlightPathManager.ts`** — add `pauseWorkflow(id)`, `resumeWorkflow(id)`, `stopWorkflow(id)` methods that delegate to the correct running instance; add `removeHistoryEntry(filePath)` or equivalent.

---

## Non-Goals / Out of Scope

- Keyboard shortcuts for per-workflow controls (future).
- Confirmation dialog before stop (VS Code convention is stop-is-immediate).
- Drag-to-reorder running workflows (future).
