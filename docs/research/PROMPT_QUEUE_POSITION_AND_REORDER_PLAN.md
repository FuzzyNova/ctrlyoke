# Prompt Queue Position Control & Reordering Plan

## Problem Statement

Users running long workflows (e.g. 100 prompts) need a way to:

1. Rewind execution to a prior completed step (cascade-reset prompts N–end back to pending)
2. Reorder pending prompts without starting over

The existing "Clear workflow state" eraser button resets the entire queue with **no confirmation guard** — that's also being fixed here.

## Invariants That Must Be Preserved

- **Completed prompts always form a contiguous prefix** — indices `0..currentStep-1` are done, `currentStep..end` are pending. No interleaving.
- Resetting a completed prompt **always cascades** — reset at index N means clear `_runtime.completedAt` for all prompts `>= N` and set `currentIndex = N`.
- Reordering is only permitted on **pending** prompts. Completed prompts are frozen.
- These operations are only available when the workflow is **not running** (idle / paused / completed / error states).

---

## Feature 0: Confirmation Modal for Reset Operations (Shared Infrastructure)

Both the existing "Clear all" eraser and the new "Set start point" button are destructive reset operations. They share a new confirmation modal and a new VS Code setting, separate from the existing delete confirmation.

### Why a Separate Setting from `confirmDeleteOperations`

`confirmDeleteOperations` controls permanent deletion (prompts, workflow history). Reset operations are different — they're recoverable (the workflow can be re-run) but still potentially surprising if triggered accidentally. Users may want to suppress reset confirmations independently of delete confirmations.

### New VS Code Setting: `confirmResetOperations`

Add to `package.json` `contributes.configuration.properties`:

```json
"flightpath.confirmResetOperations": {
  "type": "boolean",
  "default": true,
  "description": "Show a confirmation dialog before resetting workflow state (Clear All or Rewind to Step). Uncheck to skip the confirmation."
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

### New Message Type

Add to `src/types/DashboardConstants.ts`:

```typescript
UPDATE_CONFIRM_RESET: "updateConfirmReset",
// Payload: { value: boolean }
// Webview → Extension: update confirmResetOperations setting
```

Add `confirmResetOperations: boolean` to the `GlobalSettings` type so the webview store receives it via `globalSettingsUpdate`.

### New `ResetConfirmModal` Component

Create `src/ui/webview-react/components/shared/ResetConfirmModal.tsx`, mirroring the structure of `DeleteConfirmModal` but for reset operations.

Key differences from `DeleteConfirmModal`:

- Reads `globalSettings.confirmResetOperations` (not `confirmDeleteOperations`)
- Posts `MESSAGE_TYPES.UPDATE_CONFIRM_RESET` (not `UPDATE_CONFIRM_DELETE`)
- Checkbox label: `"Don't ask me again for reset operations"`
- Confirm button: `variant="primary"` (not `"danger"`) — resets are recoverable, not permanent
- Confirm button label: passed as prop (will be `"Clear All"` or `"Rewind"` depending on caller)

```tsx
interface ResetConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  detail?: React.ReactNode;
  confirmLabel?: string; // defaults to "Reset"
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

## Feature 2: "Set Start Point" Hover Button

### UX Behavior

- Visible: On hover of any **completed** prompt row when execution state is NOT `running` or `cancelling`.
  - Hidden entirely (not just disabled) during running/cancelling — no temptation to click something that won't work.
- Icon: `$(debug-reverse-continue)` codicon in the left gutter, overlaying the status icon on hover.
- Tooltip: `"Rewind to step N — reset steps N–{total} to pending"`
- On click: opens `ResetConfirmModal` (checking `confirmResetOperations` setting first — skip modal if disabled).
- Modal content:
  - Title: `"Rewind Workflow"`
  - Message: `"Reset steps {N}–{total} to pending?"` (e.g. `"Reset steps 48–100 to pending?"`)
  - Detail: `"Steps 1–{N-1} remain completed. Your output history is preserved."`
  - Confirm label: `"Rewind"`
- On confirm: sends `MESSAGE_TYPES.RESET_FROM_STEP` with `{ fromIndex: N }`.

### New Message Type

Add to `src/types/DashboardConstants.ts`:

```typescript
RESET_FROM_STEP: "resetFromStep",
// Payload: { fromIndex: number }
// Webview → Extension: cascade-reset all prompts from fromIndex to end
```

Add payload type to `src/types/WebviewMessageTypes.ts`:

```typescript
export interface ResetFromStepMessage {
  type: "resetFromStep";
  fromIndex: number;
}
```

### PromptItem Changes

Add props:

```typescript
/** True when prompt is completed and workflow is stopped — shows rewind button on hover */
canRewind?: boolean;
/** Called when user confirms the rewind action (modal is handled by PromptsPanel) */
onRewind?: () => void;
```

Add local hover state: `const [isHovered, setIsHovered] = useState(false)`.

On hover + `canRewind` true: swap `StatusIcon` for the rewind button:

```tsx
<span className="flex-shrink-0 mt-0.5 w-4 flex items-center justify-center">
  {canRewind && isHovered ? (
    <button
      className="text-description-fg hover:text-foreground transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        onRewind?.();
      }}
      title={`Rewind to step ${index + 1}`}
      aria-label={`Rewind to step ${index + 1}`}
    >
      <i className="codicon codicon-debug-reverse-continue text-[12px]" />
    </button>
  ) : (
    <StatusIcon status={status} />
  )}
</span>
```

**`PromptsPanel` wires this up:**

```tsx
const [rewindFromIndex, setRewindFromIndex] = useState<number | null>(null);

const canRewindPrompts =
  !isRunning &&
  executionState !== EXECUTION_STATES.CANCELLING &&
  currentStep > 0;

const handleRewindClick = useCallback(
  (index: number) => {
    if (!globalSettings.confirmResetOperations) {
      sendMessage(MESSAGE_TYPES.RESET_FROM_STEP, { fromIndex: index });
      return;
    }
    setRewindFromIndex(index);
  },
  [globalSettings.confirmResetOperations]
);

const handleRewindConfirm = useCallback(() => {
  if (rewindFromIndex === null) return;
  sendMessage(MESSAGE_TYPES.RESET_FROM_STEP, { fromIndex: rewindFromIndex });
  setRewindFromIndex(null);
}, [rewindFromIndex]);
```

### Extension-Side Handler

In `WebviewMessageRouter` / `WorkflowOrchestrator`, handle `RESET_FROM_STEP`:

1. Call `WorkflowOrchestrator.resetFromStep(fromIndex)`.
2. In `resetFromStep`: for all prompts at index `>= fromIndex`, clear `_runtime.completedAt`, `_runtime.startedAt`, `_runtime.harness`, `_runtime.model`; set `status = undefined`. Set `_runtime.currentIndex = fromIndex` and `executionState = IDLE`.
3. Write working file.
4. Call `dashboardProvider.notifyWorkflowStateReset(currentState.prompts)` — reuses existing reset notification, webview gets same response as full clear.

---

## Feature 3: Auto-Computed Boundary Bar

### Visual Design

A sticky divider row rendered in the `PromptsPanel` list between index `currentStep - 1` and `currentStep` **when `currentStep > 0`** (i.e., at least one prompt has been completed).

Content:

```
──────── ✓ 47 completed ────────
```

or more compact:

```
──── ▶ Next: step 48 ────
```

Styling:

- Full-width horizontal rule with centered label
- `text-description-fg`, `border-panel-border`
- `text-[10px] uppercase tracking-widest`
- Not interactive — purely visual
- Height: ~20px so it doesn't inflate the list

### Implementation

In `PromptsPanel.tsx`, after rendering `prompts[currentStep - 1]` and before `prompts[currentStep]`:

```tsx
{
  index === currentStep && currentStep > 0 && (
    <BoundaryBar completedCount={currentStep} />
  );
}
```

`BoundaryBar` is a tiny inline component (can live in `components/prompts/`):

```tsx
export const BoundaryBar: React.FC<{ completedCount: number }> = ({
  completedCount,
}) => (
  <div className="flex items-center gap-2 px-3 py-1 select-none">
    <div className="flex-1 h-px bg-panel-border" />
    <span className="text-[10px] uppercase tracking-widest text-description-fg whitespace-nowrap">
      ✓ {completedCount} completed
    </span>
    <div className="flex-1 h-px bg-panel-border" />
  </div>
);
```

When `currentStep === 0` (nothing completed) or `currentStep === prompts.length` (all completed), the bar is not shown.

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

**Key constraint:** Only pending prompts (index `>= currentStep`) are sortable. Completed prompts have no drag handles and are excluded from the `SortableContext`.

Drag handles are only active when execution state is NOT `running` or `cancelling`. During those states, the `useSortable` hook should have `disabled: true`.

**Stable IDs:** Each prompt needs a stable ID for dnd-kit. Use a generated `id` field if present (already tracked in some prompt shapes), otherwise fall back to `prompt-pending-{originalIndex}`. The working file does not use prompt GUIDs today — we can use array index as id within the pending subset since the pending section never has completed prompts interfering.

### New Message Type

Add to `src/types/DashboardConstants.ts`:

```typescript
REORDER_PROMPTS: "reorderPrompts",
// Payload: { newPendingOrder: number[] }
// Array of original prompt indices in new order, covering only the pending section.
// Webview → Extension
```

### PromptsPanel Changes

Split the prompts map into two sections: `completedPrompts` (0..currentStep-1) and `pendingPrompts` (currentStep..end).

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

Completed prompts are rendered as plain non-sortable `PromptItem` components above the `<BoundaryBar />`.

### PromptItem Changes for Drag Handle

Add a `dragHandleProps` optional prop (the spreaded `{...listeners} {...attributes}` from `useSortable`):

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

In `WorkflowCommandHandler` (or wherever `RESET_WORKFLOW_STATE` is handled):

1. Receive new order of pending prompt indices.
2. Reconstruct `queueData.prompts`: keep completed prefix as-is, splice pending prompts in new order.
3. Write working file.
4. Send confirmation back to webview (reuse file reload pattern or send `PROMPTS_REORDERED` message).

---

## Interaction Summary

| State        | Clear All guard        | Set Start Point         | Boundary Bar | Drag Reorder |
| ------------ | ---------------------- | ----------------------- | ------------ | ------------ |
| `idle`       | ✅ modal if setting on | ✅ if `currentStep > 0` | ✅ shown     | ✅ enabled   |
| `running`    | N/A (button hidden)    | ❌ hidden               | ✅ shown     | ❌ disabled  |
| `paused`     | ✅ modal if setting on | ✅ if `currentStep > 0` | ✅ shown     | ✅ enabled   |
| `cancelling` | N/A (button hidden)    | ❌ hidden               | ✅ shown     | ❌ disabled  |
| `completed`  | ✅ modal if setting on | ✅ visible              | ✅ shown     | ✅ enabled   |
| `error`      | ✅ modal if setting on | ✅ if `currentStep > 0` | ✅ shown     | ✅ enabled   |

---

## Files to Touch

| File                                                           | Change                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                                 | Add `flightpath.confirmResetOperations` setting; add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` deps |
| `src/utils/ConfigurationUtils.ts`                              | Add `shouldConfirmResetOperations()` + `setConfirmResetOperations()`                                                 |
| `src/types/DashboardConstants.ts`                              | Add `RESET_FROM_STEP`, `REORDER_PROMPTS`, `UPDATE_CONFIRM_RESET` message types                                       |
| `src/types/WebviewMessageTypes.ts`                             | Add payload types; add `confirmResetOperations` to `GlobalSettings`                                                  |
| `src/ui/webview-react/components/shared/ResetConfirmModal.tsx` | **New** — mirrors `DeleteConfirmModal` for reset operations                                                          |
| `src/ui/webview-react/components/prompts/BoundaryBar.tsx`      | **New** — visual divider between completed/pending sections                                                          |
| `src/ui/webview-react/components/layout/PromptsPanel.tsx`      | Guard eraser with modal; split completed/pending render; add dnd-kit context; rewind state; boundary bar             |
| `src/ui/webview-react/components/prompts/PromptItem.tsx`       | Add `canRewind`, `onRewind`, `dragHandleProps` props; hover state                                                    |
| `src/ui/webview-react/store/settingsStore.ts`                  | Add `confirmResetOperations` to `GlobalSettings` shape                                                               |
| `src/ui/WebviewMessageRouter.ts`                               | Handle `RESET_FROM_STEP`, `REORDER_PROMPTS`, `UPDATE_CONFIRM_RESET`                                                  |
| `src/ui/WebviewSettingsSync.ts`                                | Send `confirmResetOperations` in `globalSettingsUpdate` messages                                                     |
| `src/flightpath/WorkflowOrchestrator.ts`                       | Add `resetFromStep(fromIndex)` and `reorderPrompts(fromIndex, newOrder)` methods                                     |
| `src/flightpath/WorkflowInstance.ts`                           | Wire new orchestrator methods; call `notifyWorkflowStateReset` after `resetFromStep`                                 |

---

## Open Questions

1. **`REORDER_PROMPTS` with active sessions**: if a run is paused mid-flight with a live terminal session, reordering only affects the queue file — the live process is unaffected. The next prompt after resume uses the new order. Safe and expected.
2. **Output history after rewind**: `RESET_FROM_STEP` should clear `cliOutputs[N..]` from the webview store (live view) but leave `.flightpath/.history/` snapshots untouched. The cleared output vanishes from live view but remains accessible via the run history selector. Confirm this behavior with `OutputHistoryManager`.
3. **`notifyWorkflowStateReset` reuse for `resetFromStep`**: the existing method sends all prompts back branded as freshly reset. This works for `resetFromStep` too since the completed prefix is still populated — verify `notifyWorkflowStateReset` doesn't accidentally wipe harness/model `_runtime` on the completed prompts.
