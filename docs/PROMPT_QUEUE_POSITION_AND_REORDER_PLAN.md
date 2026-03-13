# Prompt Queue Position Control & Reordering Plan

## Problem Statement

Users running long workflows (e.g. 100 prompts) need a way to:

1. **Rewind** execution to a prior completed step (cascade-reset prompts N–end back to pending)
2. **Skip ahead** to a future pending step (mark prompts up to N as skipped so execution resumes from N)
3. Reorder pending prompts without starting over
4. Recover from an accidental "Clear All" or over-rewind by fast-forwarding back to the right position

The existing "Clear workflow state" eraser button resets the entire queue with **no confirmation guard** — that's also being fixed here.

## Invariants That Must Be Preserved

- **Non-pending prompts always form a contiguous prefix** — indices `0..currentStep-1` are either `completed` or `skipped`; index `currentStep..end` are `pending`. No interleaving.
- Changing the start position **always cascades**:
  - Rewinding to index N: clear `_runtime` for all prompts `>= N`, reset their status to `pending`. Set `currentIndex = N`.
  - Moving forward to index N: mark prompts `currentIndex..N-1` as `skipped`. Set `currentIndex = N`.
- Reordering is only permitted on **pending** prompts. Completed and skipped prompts are frozen.
- These operations are only available when the workflow is **not running** (idle / paused / completed / error / stopped states).

---

## New Concept: `skipped` Step Status

Introduce `STEP_STATUS.SKIPPED = "skipped"` to represent prompts that were intentionally bypassed via "Set Start Position" (skip-ahead direction). This is distinct from `STEP_STATUS.COMPLETED`:

| Status      | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `completed` | AI executed this step successfully in a prior run                 |
| `skipped`   | Step was intentionally bypassed — moved past without AI execution |
| `pending`   | Step has not run and is queued for future execution               |
| `cancelled` | Step was pending when the run was stopped (not manually skipped)  |

**Why not reuse `completed`?** Marking skipped prompts as `completed` is misleading — users need to know which steps the AI actually ran vs. which were bypassed. Skipped steps appearing as completed could cause confusion when reviewing output history or understanding execution results.

**Persistence:** The `skipped` status is stored via `_runtime.status` on `PromptItem` in the working file. When VS Code restarts, the working file is reloaded and `currentIndex` skips over those steps naturally.

**Position-based fallback logic update:** `getPromptStatus` in `PromptsPanel.tsx` currently falls back to `STEP_STATUS.COMPLETED` for `index < currentStep` when no explicit status exists. With skipped prompts, the explicit `status` field (merged from results when the message is sent) takes priority and returns the correct `skipped` icon. The fallback (`index < currentStep → COMPLETED`) remains correct for historically-completed prompts that don't have an explicit status field.

### StatusIcon addition

Add a case to `StatusIcon.tsx` for `STEP_STATUS.SKIPPED`:

```typescript
case STEP_STATUS.SKIPPED:
  return {
    icon: "codicon-debug-step-over",
    colorClass: "text-description-fg", // muted — not bold like completed
  };
```

---

## Feature 0: Confirmation Modal for Reset/Position Operations (Shared Infrastructure)

Both the existing "Clear All" eraser and the new "Set Start Position" button change workflow execution state. They share a new confirmation modal and a new VS Code setting, separate from the existing delete confirmation.

### Why a Separate Setting from `confirmDeleteOperations`

`confirmDeleteOperations` controls permanent deletion (prompts, workflow history). Position-change operations are different — they're recoverable but still potentially surprising if triggered accidentally. Users may want to suppress these confirmations independently of delete confirmations.

### New VS Code Setting: `confirmResetOperations`

Add to `package.json` `contributes.configuration.properties`:

```json
"flightpath.confirmResetOperations": {
  "type": "boolean",
  "default": true,
  "description": "Show a confirmation dialog before changing the workflow start position (Clear All or Set Start Position). Uncheck to skip the confirmation."
}
```

Add to `src/utils/ConfigurationUtils.ts`:

```typescript
shouldConfirmResetOperations(): boolean {
  return getConfig().get<boolean>("confirmResetOperations", true);
},
async setConfirmResetOperations(enabled: boolean): Promise<void> {
  await this.updateSetting("confirmResetOperations", enabled);
},
```

### New Message Types

Add to `src/types/DashboardConstants.ts`:

```typescript
UPDATE_CONFIRM_RESET: "updateConfirmReset",
// Payload: { value: boolean }
// Webview → Extension: update confirmResetOperations setting

SET_START_POSITION: "setStartPosition",
// Payload: { toIndex: number }
// Webview → Extension: set the workflow start position to this index (handles both forward and backward)

SET_START_POSITION_CONFIRMED: "setStartPositionConfirmed",
// Payload: { prompts: PromptItem[], currentIndex: number }
// Extension → Webview: confirms the position change with updated prompts (status merged in)
```

Add `confirmResetOperations: boolean` to the `GlobalSettings` type so the webview store receives it via `globalSettingsUpdate`.

### New `ResetConfirmModal` Component

Create `src/ui/webview-react/components/shared/ResetConfirmModal.tsx`, mirroring the structure of `DeleteConfirmModal` but for position-change operations.

Key differences from `DeleteConfirmModal`:

- Reads `globalSettings.confirmResetOperations` (not `confirmDeleteOperations`)
- Posts `MESSAGE_TYPES.UPDATE_CONFIRM_RESET` (not `UPDATE_CONFIRM_DELETE`)
- Checkbox label: `"Don't ask me again for these operations"`
- Confirm button: `variant="primary"` (not `"danger"`) — position changes are recoverable
- Confirm button label: passed as prop (will be `"Clear All"` or `"Set Position"` depending on caller)

```tsx
interface ResetConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  detail?: React.ReactNode;
  confirmLabel?: string; // defaults to "Confirm"
  onConfirm: () => void;
  onCancel: () => void;
}
```

> **Future refactor note:** `DeleteConfirmModal` and `ResetConfirmModal` are structurally very similar. If a third confirm modal is needed, refactor both into a generic `ConfirmModal` with `settingKey`, `settingMessageType`, `dontAskLabel`, and `confirmVariant` props. For now, two separate components is fine.

---

## Feature 1: Fix Existing "Clear All" Eraser Button

The `canClearState` eraser button in `PromptsPanel` currently fires `RESET_WORKFLOW_STATE` directly with no guard.

### Changes

**`PromptsPanel.tsx`:**

- Add `useState<boolean>(false)` for `showClearConfirm`.
- Change `handleClearState` to: check `globalSettings.confirmResetOperations`; if false, send immediately; otherwise set `showClearConfirm = true`.
- Render `<ResetConfirmModal>` at the bottom of the component (outside the list, same pattern as `PromptEditor` rendering `<DeleteConfirmModal>`).
- Modal content:
  - Title: `"Clear Workflow State"`
  - Message: `"Reset all prompts to pending?"`
  - Detail: `"This will clear all completion state so every prompt will run again. Your output history is preserved."`
  - Confirm label: `"Clear All"`

---

## Feature 2: "Set Start Position" Hover Button (Bidirectional)

This replaces the original single-direction "Rewind" concept. The button now appears on both completed/skipped prompts (to rewind) AND on pending prompts further into the queue (to skip ahead).

### UX Behavior

**When shown:**

- On hover of any **completed or skipped** prompt row (index `< currentStep`) — rewind direction
- On hover of any **pending** prompt row at index `> currentStep` — skip-ahead direction
- Hidden entirely on the **current step** (the first pending prompt at `currentStep`) — no-op
- Hidden entirely during `running` or `cancelling` states — no interaction during active execution

**Icon (direction-aware, shown on hover overlaying the status icon):**

- Rewinding (clicking completed/skipped prompt): `$(debug-reverse-continue)` — backward arrow
- Skipping ahead (clicking pending prompt): `$(debug-step-over)` — forward step icon

**Tooltip (generic — does not say "rewind" or "skip"):**

```
"Set step {N} as start position"
```

**On click:** Opens `ResetConfirmModal` (respects `confirmResetOperations` setting — skip modal if disabled).

**Modal content (generic title + direction-aware detail):**

- Title: `"Set Start Position"` (same regardless of direction)
- Message: `"Start workflow from step {N}?"` (same regardless of direction — {N} is 1-based)
- Detail (computed at click time based on direction):
  - **Rewind** (N < currentStep): `"Steps {N}–{total} will reset to pending. Steps 1–{N-1} remain completed."`
  - **Skip-ahead** (N > currentStep): `"Steps {currentStep+1}–{N-1} will be marked as skipped. Steps {N}–{total} remain pending."`
- Confirm label: `"Set Position"`

**On confirm:** sends `MESSAGE_TYPES.SET_START_POSITION` with `{ toIndex: N }` (0-based index).

### New Payload Type

Add to `src/types/WebviewMessageTypes.ts`:

```typescript
export interface SetStartPositionMessage {
  type: typeof MESSAGE_TYPES.SET_START_POSITION;
  toIndex: number; // 0-based index to set as new currentIndex
}

export interface SetStartPositionConfirmedMessage {
  type: typeof MESSAGE_TYPES.SET_START_POSITION_CONFIRMED;
  prompts: PromptItem[]; // Full prompts array with .status merged in from results
  currentIndex: number; // The new start position
}
```

### PromptItem Component Changes

Add props:

```typescript
/** Set when this prompt can be used as a new start position (not running, not current step) */
canSetStartPosition?: boolean;
/** Called when user activates the set-start-position button for this prompt */
onSetStartPosition?: () => void;
/** Direction of position change if this prompt is clicked — used to pick the correct icon */
startPositionDirection?: "rewind" | "forward";
```

Add local hover state: `const [isHovered, setIsHovered] = useState(false)`.

On hover + `canSetStartPosition` true: swap `StatusIcon` for the direction-appropriate button:

```tsx
<span className="flex-shrink-0 mt-0.5 w-4 flex items-center justify-center">
  {canSetStartPosition && isHovered ? (
    <button
      className="text-description-fg hover:text-foreground transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        onSetStartPosition?.();
      }}
      title={`Set step ${index + 1} as start position`}
      aria-label={`Set step ${index + 1} as start position`}
    >
      <i
        className={`codicon ${
          startPositionDirection === "rewind"
            ? "codicon-debug-reverse-continue"
            : "codicon-debug-step-over"
        } text-[12px]`}
      />
    </button>
  ) : (
    <StatusIcon status={status} />
  )}
</span>
```

**`PromptsPanel` wires this up:**

```tsx
const [setPositionIndex, setSetPositionIndex] = useState<number | null>(null);

const canChangeStartPosition =
  !isRunning && executionState !== EXECUTION_STATES.CANCELLING;

const handleSetPositionClick = useCallback(
  (index: number) => {
    if (!globalSettings.confirmResetOperations) {
      sendMessage(MESSAGE_TYPES.SET_START_POSITION, { toIndex: index });
      return;
    }
    setSetPositionIndex(index);
  },
  [globalSettings.confirmResetOperations]
);

const handleSetPositionConfirm = useCallback(() => {
  if (setPositionIndex === null) return;
  sendMessage(MESSAGE_TYPES.SET_START_POSITION, { toIndex: setPositionIndex });
  setSetPositionIndex(null);
}, [setPositionIndex]);

// Build modal content based on direction
const setPositionModalContent =
  setPositionIndex !== null
    ? (() => {
        const n = setPositionIndex + 1; // 1-based for display
        const total = prompts.length;
        const isRewind = setPositionIndex < currentStep;
        return {
          message: `Start workflow from step ${n}?`,
          detail: isRewind
            ? `Steps ${n}–${total} will reset to pending. Steps 1–${n - 1} remain completed.`
            : `Steps ${currentStep + 1}–${n - 1} will be marked as skipped. Steps ${n}–${total} remain pending.`,
        };
      })()
    : null;

// In render — each PromptItem gets:
const isCurrentStep = index === currentStep;
const canSetPos = canChangeStartPosition && !isCurrentStep;
const direction = index < currentStep ? "rewind" : "forward";
```

### Extension-Side: `PromptQueue.setStartPosition(toIndex)`

New method on `PromptQueue`. Handles both direction cases — no separate rewind/forward methods needed:

```typescript
async setStartPosition(toIndex: number): Promise<void> {
  const currentIndex = this.state.currentIndex;
  if (toIndex === currentIndex) return; // No-op

  if (toIndex < currentIndex) {
    // REWIND: Clear _runtime and reset results to PENDING for all prompts >= toIndex
    this.state.prompts = this.state.prompts.map((prompt, index) => {
      if (index < toIndex) return prompt; // Keep completed prompts untouched
      const { _runtime, ...rest } = prompt as any;
      return rest; // Strip _runtime entirely
    });
    this.state.results = this.state.results.map((result, index) =>
      index < toIndex ? result : { ...result, status: STEP_STATUS.PENDING }
    );
  } else {
    // SKIP-AHEAD: Mark prompts currentIndex..toIndex-1 as SKIPPED
    this.state.prompts = this.state.prompts.map((prompt, index) => {
      if (index < currentIndex || index >= toIndex) return prompt;
      return {
        ...prompt,
        _runtime: {
          ...(prompt._runtime ?? {}),
          startedAt: Date.now(),
          completedAt: Date.now(),
          // status stored here for working file persistence
        },
      };
    });
    this.state.results = this.state.results.map((result, index) =>
      index >= currentIndex && index < toIndex
        ? { ...result, status: STEP_STATUS.SKIPPED }
        : result
    );
  }

  this.state.currentIndex = toIndex;
  this.state.status = EXECUTION_STATES.IDLE;
  this.state.stopped = false;

  // Rebuild completedIndices to cover all non-pending prefix prompts (0..toIndex-1)
  this.state.completedIndices = new Set<string>(
    Array.from({ length: toIndex }, (_, i) => String(i))
  );

  this.emitStateChange();
  await this.updateWorkingFile();
}
```

### Extension-Side: `WorkflowInstance.setStartPosition(toIndex)`

```typescript
async setStartPosition(toIndex: number): Promise<void> {
  Log.info(`WorkflowInstance.setStartPosition: Moving to index ${toIndex}`);
  await this.promptQueue.setStartPosition(toIndex);
  if (this.dashboardSink) {
    const state = this.promptQueue.getState();
    // Merge results status into prompts before sending to webview
    const promptsWithStatus = state.prompts.map((prompt, index) => ({
      ...prompt,
      status: state.results[index]?.status ?? STEP_STATUS.PENDING,
    }));
    this.dashboardSink.notifyStartPositionSet(promptsWithStatus, toIndex);
  }
  Log.info(`WorkflowInstance.setStartPosition: Complete`);
}
```

### `FlightPathWebviewProvider` addition

```typescript
public notifyStartPositionSet(prompts: any[], currentIndex: number): void {
  this.postMessage({
    type: MESSAGE_TYPES.SET_START_POSITION_CONFIRMED,
    prompts,
    currentIndex,
  });
}
```

Add to `IDashboardSink.ts`:

```typescript
notifyStartPositionSet(prompts: any[], currentIndex: number): void;
```

### Webview Handler (`useMessageHandler.ts`)

```typescript
handlers[MESSAGE_TYPES.SET_START_POSITION_CONFIRMED] = (message) => {
  const workflowStore = useWorkflowStore.getState();
  const prevCurrentStep = workflowStore.currentStep;
  const newCurrentStep = message.currentIndex as number;

  workflowStore.applyStartPositionChange(message.prompts || [], newCurrentStep);

  // For rewind: clear live CLI outputs for rewound steps
  if (newCurrentStep < prevCurrentStep) {
    workflowStore.clearRuntimeStateFromStep(newCurrentStep);
  }

  // Cancel any active edit — the selected prompt's state has changed
  const editorStore = useEditorStore.getState();
  if (editorStore.selectionTarget.kind !== "newPrompt") {
    editorStore.cancelEdit();
  }
};
```

### New `workflowStore.applyStartPositionChange()` method

```typescript
applyStartPositionChange: (prompts: PromptItem[], newCurrentStep: number) =>
  set(() => ({
    prompts, // already have .status merged in from extension
    currentStep: newCurrentStep,
    totalSteps: prompts.length,
    executionState: EXECUTION_STATES.IDLE,
    finalPromptStatus: null,
  })),
```

> **Note:** `clearRuntimeStateFromStep` is called separately (see above) to preserve the `set()` pattern. This avoids mutating two independent parts of state in one call.

### Handling `SET_START_POSITION` in `WebviewMessageRouter.ts`

```typescript
table.set(MESSAGE_TYPES.SET_START_POSITION, async (message) => {
  await this.handleSetStartPosition(message.toIndex as number);
});
```

Where `handleSetStartPosition` finds the active `WorkflowInstance` and calls `instance.setStartPosition(toIndex)`.

### Interaction with Output History

- **Rewind case:** Clearing live `cliOutputs[N..]` in the webview store removes the stale output from the live output panel. The `.flightpath/.history/` snapshots are untouched — previous run output remains accessible via the run history selector.
- **Skip-ahead case:** Skipped prompts never ran, so there is no output to clear. The live output panel is unchanged.

---

## Feature 3: Auto-Computed Boundary Bar

### Visual Design

A divider row rendered in the `PromptsPanel` list between index `currentStep - 1` and `currentStep` **when `currentStep > 0`** and `currentStep < prompts.length` (i.e., there is a non-empty done section AND a non-empty pending section).

The label adapts based on what's in the done section (mix of completed and skipped):

```
──── ✓ 47 completed ────
──── ✓ 30 completed · 17 skipped ────
```

Styling:

- Full-width horizontal rule with centered label
- `text-description-fg`, `border-panel-border`
- `text-[10px] uppercase tracking-widest`
- Not interactive — purely visual
- Height: ~20px so it doesn't inflate the list

### Implementation

`BoundaryBar` is a tiny component in `components/prompts/`:

```tsx
interface BoundaryBarProps {
  completedCount: number;
  skippedCount: number;
}

export const BoundaryBar: React.FC<BoundaryBarProps> = ({
  completedCount,
  skippedCount,
}) => {
  const label =
    skippedCount > 0
      ? `✓ ${completedCount} completed · ${skippedCount} skipped`
      : `✓ ${completedCount} completed`;

  return (
    <div className="flex items-center gap-2 px-3 py-1 select-none">
      <div className="flex-1 h-px bg-panel-border" />
      <span className="text-[10px] uppercase tracking-widest text-description-fg whitespace-nowrap">
        {label}
      </span>
      <div className="flex-1 h-px bg-panel-border" />
    </div>
  );
};
```

**In `PromptsPanel.tsx`**, compute the counts before the render loop:

```tsx
const completedCount = prompts
  .slice(0, currentStep)
  .filter((p) => p.status !== STEP_STATUS.SKIPPED).length;
const skippedCount = currentStep - completedCount;
```

Render the bar between `prompts[currentStep - 1]` and `prompts[currentStep]`:

```tsx
{
  index === currentStep && currentStep > 0 && currentStep < prompts.length && (
    <BoundaryBar completedCount={completedCount} skippedCount={skippedCount} />
  );
}
```

---

## Feature 4: Drag-to-Reorder Pending Prompts

### Library: `@dnd-kit`

**Chosen over alternatives because:**

| Library                               | Verdict                                                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dnd-kit/core` + `@dnd-kit/sortable` | ✅ **Best choice** — modular, actively maintained, built-in `KeyboardSensor` with full arrow-key sorting, ARIA live regions, no jQuery/DOM mutation, React 19 compatible, tree-shakeable |
| `react-sortable-hoc`                  | ❌ Deprecated/unmaintained — author recommends migrating to dnd-kit                                                                                                                      |
| `hello-pangea/dnd`                    | ⚠️ Good (Atlassian lineage), but more opinionated API, weaker TypeScript types                                                                                                           |
| `pragmatic-drag-and-drop`             | ⚠️ Newer Atlassian library, less community resources, no built-in React hooks                                                                                                            |
| `react-beautiful-dnd`                 | ❌ Deprecated                                                                                                                                                                            |

**Keyboard support (replaces ▲▼ buttons):** dnd-kit's `KeyboardSensor` with `sortableKeyboardCoordinates` gives:

- `Tab` → focus the drag handle
- `Enter` or `Space` → pick up the item
- `Arrow Up/Down` → move the item
- `Enter` or `Space` → drop in new position
- `Escape` → cancel drag and revert

This is fully sufficient — no ▲▼ fallback buttons needed.

### Install

```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

Packages to add to `package.json` devDependencies (they compile into the webview bundle):

- `@dnd-kit/core`
- `@dnd-kit/sortable`
- `@dnd-kit/utilities`

### Architecture

**Key constraint:** Only **pending** prompts (index `>= currentStep`) are sortable. Completed and skipped prompts have no drag handles and are excluded from the `SortableContext`. Skipped prompts are part of the "done" prefix section and cannot be reordered without first rewinding to include them in the pending section.

Drag handles are only active when execution state is NOT `running` or `cancelling`. During those states, the `useSortable` hook should have `disabled: true`.

**Stable IDs:** Use `prompt-pending-{originalIndex}` as the dnd-kit item ID within the pending subset.

### New Message Type

Add to `src/types/DashboardConstants.ts`:

```typescript
REORDER_PROMPTS: "reorderPrompts",
// Payload: { newPendingOrder: number[] }
// Array of original prompt indices in new order, covering only the pending section.
// Webview → Extension
```

### PromptsPanel Changes

Split the prompts map into two sections: `donePrefixPrompts` (0..currentStep-1, includes both completed and skipped) and `pendingPrompts` (currentStep..end).

Wrap only `pendingPrompts` in the dnd-kit context:

```tsx
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

// Inside PromptsPanel render:
const canReorder = !isRunning && executionState !== EXECUTION_STATES.CANCELLING;

const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: { distance: 5 }, // prevent accidental drags on click
  }),
  useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
);

function handleDragEnd(event) {
  const { active, over } = event;
  if (over && active.id !== over.id) {
    // compute new pending order, send message
    sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, { newPendingOrder: [...] });
  }
}
```

Done-prefix prompts (completed and skipped) are rendered as plain non-sortable `PromptItem` components above the `<BoundaryBar />`.

### PromptItem Changes for Drag Handle

Add a `dragHandleProps` optional prop:

```typescript
dragHandleProps?: {
  listeners: SyntheticListenerMap | undefined;
  attributes: DraggableAttributes;
};
```

When `dragHandleProps` is provided, render a `$(grabber)` handle on the left before the status icon:

```tsx
{
  dragHandleProps && (
    <span
      className="flex-shrink-0 cursor-grab active:cursor-grabbing text-description-fg hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
      {...dragHandleProps.listeners}
      {...dragHandleProps.attributes}
      aria-label="Drag to reorder"
    >
      <i className="codicon codicon-grabber text-[12px]" />
    </span>
  );
}
```

Add `group` class to the container div so `group-hover:opacity-100` works on the handle.

### Extension-Side Handler for `REORDER_PROMPTS`

In `WebviewMessageRouter`:

1. Receive new order of pending prompt indices.
2. Reconstruct `queueData.prompts`: keep done-prefix (completed + skipped) as-is, splice pending prompts in new order.
3. Write working file.
4. Send `REORDER_PROMPTS_CONFIRMED` or reuse file reload pattern to confirm.

---

## Interaction Summary

| State        | Clear All guard        | Set Start Position (rewind)     | Set Start Position (forward)     | Boundary Bar | Drag Reorder |
| ------------ | ---------------------- | ------------------------------- | -------------------------------- | ------------ | ------------ |
| `idle`       | ✅ modal if setting on | ✅ on completed/skipped rows    | ✅ on pending rows > currentStep | ✅ shown     | ✅ enabled   |
| `running`    | N/A (button hidden)    | ❌ hidden                       | ❌ hidden                        | ✅ shown     | ❌ disabled  |
| `paused`     | ✅ modal if setting on | ✅ on completed/skipped rows    | ✅ on pending rows > currentStep | ✅ shown     | ✅ enabled   |
| `cancelling` | N/A (button hidden)    | ❌ hidden                       | ❌ hidden                        | ✅ shown     | ❌ disabled  |
| `completed`  | ✅ modal if setting on | ✅ visible (all rows completed) | N/A (no pending rows to forward) | not shown    | ✅ enabled   |
| `error`      | ✅ modal if setting on | ✅ on completed/skipped rows    | ✅ on pending rows > currentStep | ✅ shown     | ✅ enabled   |

---

## Files to Touch

| File                                                           | Change                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                 | Add `flightpath.confirmResetOperations` setting; add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` deps                              |
| `src/utils/ConfigurationUtils.ts`                              | Add `shouldConfirmResetOperations()` + `setConfirmResetOperations()`                                                                              |
| `src/types/DashboardConstants.ts`                              | Add `SKIPPED` to `STEP_STATUS`; add `SET_START_POSITION`, `SET_START_POSITION_CONFIRMED`, `REORDER_PROMPTS`, `UPDATE_CONFIRM_RESET` message types |
| `src/types/WebviewMessageTypes.ts`                             | Add `SetStartPositionMessage`, `SetStartPositionConfirmedMessage` payload types; add `confirmResetOperations` to `GlobalSettings`                 |
| `src/types/IDashboardSink.ts`                                  | Add `notifyStartPositionSet(prompts, currentIndex)` to the interface                                                                              |
| `src/ui/webview-react/components/prompts/StatusIcon.tsx`       | Add `SKIPPED` case with `codicon-debug-step-over` icon                                                                                            |
| `src/ui/webview-react/components/shared/ResetConfirmModal.tsx` | **New** — mirrors `DeleteConfirmModal` for position-change operations                                                                             |
| `src/ui/webview-react/components/prompts/BoundaryBar.tsx`      | **New** — visual divider; shows completed + skipped counts                                                                                        |
| `src/ui/webview-react/components/layout/PromptsPanel.tsx`      | Guard eraser; split done-prefix/pending render; add dnd-kit context; set-position state; boundary bar                                             |
| `src/ui/webview-react/components/prompts/PromptItem.tsx`       | Add `canSetStartPosition`, `onSetStartPosition`, `startPositionDirection`, `dragHandleProps` props; hover state                                   |
| `src/ui/webview-react/store/workflowStore.ts`                  | Add `applyStartPositionChange()` method                                                                                                           |
| `src/ui/webview-react/store/settingsStore.ts`                  | Add `confirmResetOperations` to `GlobalSettings` shape                                                                                            |
| `src/ui/webview-react/hooks/useMessageHandler.ts`              | Handle `SET_START_POSITION_CONFIRMED`                                                                                                             |
| `src/ui/WebviewMessageRouter.ts`                               | Handle `SET_START_POSITION`, `REORDER_PROMPTS`, `UPDATE_CONFIRM_RESET`                                                                            |
| `src/ui/WebviewSettingsSync.ts`                                | Send `confirmResetOperations` in `globalSettingsUpdate` messages                                                                                  |
| `src/ui/FlightPathWebviewProvider.ts`                          | Add `notifyStartPositionSet(prompts, currentIndex)` method                                                                                        |
| `src/flightpath/PromptQueue.ts`                                | Add `setStartPosition(toIndex)` method (handles both rewind and skip-ahead)                                                                       |
| `src/flightpath/WorkflowInstance.ts`                           | Add `setStartPosition(toIndex)` method; merge results into prompts before notifying webview                                                       |

---

## Open Questions

1. **`REORDER_PROMPTS` with active sessions**: if a run is paused mid-flight with a live terminal session, reordering only affects the queue file — the live process is unaffected. The next prompt after resume uses the new order. Safe and expected.

2. **Output history after rewind**: `SET_START_POSITION` (rewind) clears `cliOutputs[N..]` from the webview store (live view) but leaves `.flightpath/.history/` snapshots untouched. The cleared output vanishes from live view but remains accessible via the run history selector. Confirmed: `clearRuntimeStateFromStep` already does this correctly.

3. **Skipped prompts in output history snapshots**: When a skip-ahead run is saved to history, the snapshot stores no output for skipped steps (empty arrays). The history viewer already handles missing steps gracefully. Nothing extra needed.

4. **`completedIndices` and skipped prompts**: `completedIndices` in `QueueState` is a fast-lookup cache for dynamic queue deduplication. After `setStartPosition`, we rebuild it to contain all indices `0..toIndex-1` (both completed and skipped). This prevents them from being re-queued via dynamic extension. Correct behavior.

5. **`notifyWorkflowStateReset` vs `notifyStartPositionSet`**: These are kept separate deliberately. `notifyWorkflowStateReset` (for "Clear All") sends prompts without status and the webview forces all to `PENDING`, `currentStep = 0`. `notifyStartPositionSet` sends prompts with results merged in and sends the new `currentIndex`, allowing partial completion to persist. Mixing these would break one of the two use cases.

6. **Skip-ahead past a prompt with a session that's in-flight**: Not applicable — `SET_START_POSITION` is only available when the workflow is NOT running. No in-flight session concerns.

7. **Recovering from accidental "Clear All"**: The user can reload the workflow from its original file (if it was file-backed) to restore prompts. Or they can re-run from the beginning. The original plan's concern about "accidentally clearing" is mitigated by the confirmation modal — the `confirmResetOperations = true` default means users must actively confirm. For "skip-forward to recover from over-rewind", the exact recovery is: use "Set Start Position" on the prompt that was the original `currentStep` before the accidental rewind — this marks the already-completed prompts as skipped and resumes from the right point.

8. **Working file persistence of skipped status**: Skipped prompts have `_runtime.completedAt` (set to the skip timestamp) and their `results[i].status = SKIPPED` is stored via the normal working file update path. When the session is restored, `SESSION_RESTORED` sends `results` to the webview and `loadWorkflow` merges `results[i].status` into `prompts[i].status`. The `getPromptStatus` fallback (`index < currentStep → COMPLETED`) is never reached for skipped prompts because `results[i].status = SKIPPED` takes priority. ✅
