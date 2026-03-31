# Prompt Queue Position Control & Reordering — Implementation Plan

## Gaps & Clarifications Found

**Confirmed infrastructure (exists, no changes needed):**

- `clearRuntimeStateFromStep` already exists in `workflowStore.ts`
- `dashboardSink` is a private field on `WorkflowInstance`
- `confirmDeleteOperations` pattern — `settingsStore.ts` has its own `GlobalSettings` shape that must also be updated alongside `WebviewMessageTypes.ts`
- `WebviewMessageRouter.handleResetWorkflowState()` already follows the private-method pattern

**Spec ambiguities resolved:**

1. **`REORDER_PROMPTS_CONFIRMED`**: Given how `UPDATE_PROMPT` works (optimistic webview update, silent persistence), use **optimistic UI** — webview reorders `prompts` state immediately on drag end, then fires `REORDER_PROMPTS` for persistence. No confirmation round-trip needed.
2. **`getPromptStatus` fallback**: Adding `SKIPPED` to `STEP_STATUS` and merging `results[i].status` into `prompts[i]` before sending to the webview is sufficient. The fallback (`index < currentStep → COMPLETED`) is only reached when no explicit status exists.
3. **Type safety in `setStartPosition`**: Avoid `as any` cast. `PromptItem._runtime` is already typed as optional — use `{ ...prompt, _runtime: undefined }` directly.
4. **`results` array shape**: `PromptResult` requires `prompt: string` and `timestamp: Date`. The SKIP-AHEAD block spreads `{ ...result, status: SKIPPED }` which preserves both required fields correctly.
5. **`settingsStore.ts` vs `WebviewMessageTypes.ts`**: Both define a `GlobalSettings`-like shape. Update `settingsStore.ts`'s `GlobalSettings` interface AND the `GlobalSettingsUpdatedMessage` payload in `WebviewMessageTypes.ts`.

---

## Phase 1 — Foundation: Constants & Types

### `src/types/DashboardConstants.ts`

- Add `SKIPPED: "skipped"` to `STEP_STATUS`
- Add four new message type constants:
  - `SET_START_POSITION: "setStartPosition"` — Webview → Extension
  - `SET_START_POSITION_CONFIRMED: "setStartPositionConfirmed"` — Extension → Webview
  - `REORDER_PROMPTS: "reorderPrompts"` — Webview → Extension
  - `UPDATE_CONFIRM_RESET: "updateConfirmReset"` — Webview → Extension (persists the "don't ask again" checkbox)

### `src/types/WebviewMessageTypes.ts`

- Add `SetStartPositionMessage` payload type: `{ type, toIndex: number }`
- Add `SetStartPositionConfirmedMessage` payload type: `{ type, prompts: PromptItem[], currentIndex: number }`
- Add `ReorderPromptsMessage` payload type: `{ type, newPendingOrder: number[] }` — array of original indices in new order
- Add `confirmResetOperations?: boolean` to the `globalSettings` field of `GlobalSettingsUpdatedMessage`

### `src/types/IDashboardSink.ts`

- Add `notifyStartPositionSet(prompts: PromptItem[], currentIndex: number): void`

---

## Phase 2 — Backend: PromptQueue & WorkflowInstance

### `src/flightpath/PromptQueue.ts`

Add `setStartPosition(toIndex: number): Promise<void>`:

```typescript
async setStartPosition(toIndex: number): Promise<void> {
  const currentIndex = this.state.currentIndex;
  if (toIndex === currentIndex) return;

  if (toIndex < currentIndex) {
    // REWIND: strip _runtime for prompts at/after toIndex, reset results to PENDING
    this.state.prompts = this.state.prompts.map((prompt, index) =>
      index < toIndex ? prompt : { ...prompt, _runtime: undefined }
    );
    this.state.results = this.state.results.map((result, index) =>
      index < toIndex ? result : { ...result, status: STEP_STATUS.PENDING }
    );
  } else {
    // SKIP-AHEAD: mark currentIndex..toIndex-1 as SKIPPED in results
    this.state.results = this.state.results.map((result, index) =>
      index >= currentIndex && index < toIndex
        ? { ...result, status: STEP_STATUS.SKIPPED }
        : result
    );
    // Stamp a completedAt on skipped prompts so working file captures the skip
    this.state.prompts = this.state.prompts.map((prompt, index) => {
      if (index < currentIndex || index >= toIndex) return prompt;
      return {
        ...prompt,
        _runtime: { ...(prompt._runtime ?? { startedAt: Date.now() }), completedAt: Date.now() },
      };
    });
  }

  this.state.currentIndex = toIndex;
  this.state.status = EXECUTION_STATES.IDLE;
  this.state.stopped = false;
  // Rebuild completedIndices to cover all indices before toIndex (includes skipped)
  this.state.completedIndices = new Set(
    Array.from({ length: toIndex }, (_, i) => String(i))
  );

  this.emitStateChange();
  await this.updateWorkingFile();
}
```

Add `reorderPendingPrompts(newPendingOrder: number[]): Promise<void>`:

```typescript
async reorderPendingPrompts(newPendingOrder: number[]): Promise<void> {
  const currentIndex = this.state.currentIndex;
  const donePrompts = this.state.prompts.slice(0, currentIndex);
  const doneResults = this.state.results.slice(0, currentIndex);
  const newPending = newPendingOrder.map(i => this.state.prompts[i]);
  const newPendingResults = newPendingOrder.map(i => this.state.results[i]);
  this.state.prompts = [...donePrompts, ...newPending];
  this.state.results = [...doneResults, ...newPendingResults];
  this.emitStateChange();
  await this.updateWorkingFile();
}
```

### `src/flightpath/WorkflowInstance.ts`

Add `setStartPosition(toIndex: number): Promise<void>`:

- Validate: only allowed when `executionState` is IDLE, STOPPED, PAUSED, or COMPLETED (not RUNNING/CANCELLING)
- Call `this.promptQueue.setStartPosition(toIndex)`
- Merge `state.results[i].status` into each `state.prompts[i]` before sending to webview (same pattern as session restore)
- Call `this.dashboardSink?.notifyStartPositionSet(promptsWithStatus, toIndex)`

---

## Phase 3 — Settings Infrastructure

### `package.json`

- Add `flightpath.confirmResetOperations` boolean setting (default `true`) to `contributes.configuration.properties` — mirrors `confirmDeleteOperations` entry

### `src/utils/ConfigurationUtils.ts`

- Add `shouldConfirmResetOperations(): boolean` — `getConfig().get<boolean>("confirmResetOperations", true)`
- Add `async setConfirmResetOperations(enabled: boolean): Promise<void>` — same pattern as `setConfirmDeleteOperations`

### `src/ui/WebviewSettingsSync.ts`

- Add `confirmResetOperations: ConfigurationUtils.shouldConfirmResetOperations()` to the `globalSettings` object in both `sendInitialState()` and `sendGlobalSettingsUpdate()`

### `src/ui/FlightPathWebviewProvider.ts`

- Implement `notifyStartPositionSet(prompts: PromptItem[], currentIndex: number): void` — posts `SET_START_POSITION_CONFIRMED` with `{ prompts, currentIndex }` (mirrors `notifyWorkflowStateReset`)

---

## Phase 4 — Webview Store

### `src/ui/webview-react/store/settingsStore.ts`

- Add `confirmResetOperations: boolean` to the `GlobalSettings` interface
- Set initial value to `true` in the default state object

### `src/ui/webview-react/store/workflowStore.ts`

- Add `applyStartPositionChange(prompts: PromptItem[], newCurrentStep: number): void` to the `WorkflowState` interface and implementation:
  ```typescript
  applyStartPositionChange: (prompts, newCurrentStep) =>
    set(() => ({
      prompts,
      currentStep: newCurrentStep,
      totalSteps: prompts.length,
      executionState: EXECUTION_STATES.IDLE,
      finalPromptStatus: null,
    })),
  ```

---

## Phase 5 — New Components

### `src/ui/webview-react/components/shared/ResetConfirmModal.tsx` (new file)

Mirrors `DeleteConfirmModal.tsx`:

- Props: `isOpen`, `title`, `message`, `detail?`, `confirmLabel?` (defaults `"Confirm"`), `onConfirm`, `onCancel`
- Reads `globalSettings.confirmResetOperations` from `useSettingsStore()`
- "Don't ask again" checkbox immediately posts `UPDATE_CONFIRM_RESET` with `{ value: !checked }`
- Confirm button uses `variant="primary"` (not danger — position changes are recoverable)

### `src/ui/webview-react/components/prompts/BoundaryBar.tsx` (new file)

Pure display component, ~20px height:

- Props: `completedCount: number`, `skippedCount: number`
- Renders: centered label between two horizontal rules showing e.g. `"✓ 3 completed"` or `"✓ 3 completed · 1 skipped"`
- Classes: `text-[10px] uppercase tracking-widest text-description-fg`, border color `bg-panel-border`
- No interaction, no state

---

## Phase 6 — StatusIcon, PromptItem & PromptsPanel

### `src/ui/webview-react/components/prompts/StatusIcon.tsx`

- Add `case STEP_STATUS.SKIPPED: return { icon: "codicon-debug-step-over", colorClass: "text-description-fg" }`

### `src/ui/webview-react/components/prompts/PromptItem.tsx`

New props (all optional):

- `canSetStartPosition?: boolean`
- `onSetStartPosition?: () => void`
- `startPositionDirection?: "rewind" | "forward"`
- `dragHandleProps?: { listeners: SyntheticListenerMap | undefined; attributes: DraggableAttributes }`

Changes:

- Add `const [isHovered, setIsHovered] = useState(false)` + `onMouseEnter`/`onMouseLeave` on outer container
- Add `group` class to outer container
- Replace the `StatusIcon` with a conditional: when `canSetStartPosition && isHovered`, show direction-aware icon button (`codicon-debug-reverse-continue` for rewind, `codicon-debug-step-over` for forward) with a tooltip; otherwise show `<StatusIcon />`
- When `dragHandleProps` provided, render `codicon-grabber` handle before the status area with `opacity-0 group-hover:opacity-100` CSS transition

### `src/ui/webview-react/components/layout/PromptsPanel.tsx`

**State additions:**

- `const [showClearConfirm, setShowClearConfirm] = useState(false)` — for "Clear Workflow State" button
- `const [setPositionIndex, setPositionIndex_] = useState<number | null>(null)` — pending set-position

**Logic additions:**

- `handleClearState`: if `!globalSettings.confirmResetOperations`, send immediately; else set `showClearConfirm = true`
- `handleSetPositionClick(index)`: compute direction; if `!confirmResetOperations`, send `SET_START_POSITION` immediately; else set `setPositionIndex`
- `handleSetPositionConfirm()`: send `SET_START_POSITION` with `toIndex: setPositionIndex`, clear modal state
- Compute `completedCount` and `skippedCount` from `prompts.slice(0, currentStep)` by checking `results` statuses

**Render changes:**

1. Render done-prefix (indices `0..currentStep-1`) as plain `PromptItem` with `canSetStartPosition={canChangeStartPosition}` and `startPositionDirection="rewind"`
2. Render `<BoundaryBar completedCount skippedCount />` when `currentStep > 0 && currentStep < prompts.length`
3. Wrap pending prompts (indices `currentStep..end`) in dnd-kit `DndContext` + `SortableContext`; each item wrapped in a `SortablePromptItem` helper that passes `dragHandleProps` down, with `canSetStartPosition` and `startPositionDirection="forward"` (only for items strictly after `currentStep`; the item AT `currentStep` is current/active)
4. `handleDragEnd`: reconstruct the original-index array for the pending slice, call `sendMessage(MESSAGE_TYPES.REORDER_PROMPTS, { newPendingOrder })`
5. Render `<ResetConfirmModal>` for "Clear Workflow State" guarded by `showClearConfirm`
6. Render `<ResetConfirmModal>` for set-position operations guarded by `setPositionIndex !== null`, with direction-aware title/message

**dnd-kit setup:**

```typescript
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
);
const canReorder = !isRunning && pendingPrompts.length > 1;
```

---

## Phase 7 — Message Routing

### `src/ui/WebviewMessageRouter.ts`

Add three new entries to the dispatch table in `buildDispatchTable()`:

```typescript
table.set(MESSAGE_TYPES.SET_START_POSITION, async (message) => {
  const instance = this.getOrchestrator()?.getActiveInstance();
  await instance?.setStartPosition(message.toIndex as number);
});

table.set(MESSAGE_TYPES.REORDER_PROMPTS, async (message) => {
  const instance = this.getOrchestrator()?.getActiveInstance();
  await instance?.promptQueue.reorderPendingPrompts(
    message.newPendingOrder as number[]
  );
});

table.set(MESSAGE_TYPES.UPDATE_CONFIRM_RESET, async (message) => {
  await ConfigurationUtils.setConfirmResetOperations(message.value as boolean);
});
```

### `src/ui/webview-react/hooks/useMessageHandler.ts`

Add handler for `SET_START_POSITION_CONFIRMED`:

```typescript
handlers[MESSAGE_TYPES.SET_START_POSITION_CONFIRMED] = (message) => {
  const workflowStore = useWorkflowStore.getState();
  const prevCurrentStep = workflowStore.currentStep;
  const newCurrentStep = message.currentIndex as number;
  workflowStore.applyStartPositionChange(message.prompts || [], newCurrentStep);
  if (newCurrentStep < prevCurrentStep) {
    workflowStore.clearRuntimeStateFromStep(newCurrentStep);
  }
  const editorStore = useEditorStore.getState();
  if (editorStore.selectionTarget.kind !== "newPrompt") {
    editorStore.cancelEdit();
  }
};
```

---

## Phase 8 — Tests

### `src/test/unit/WorkflowInstance.test.ts`

- Add `notifyStartPositionSet: () => {}` to every mock `IDashboardSink` stub (multiple exist in the file)

### `src/test/unit/PromptQueue.test.ts` (new describe block)

Tests for `setStartPosition`:

- REWIND: verify `_runtime` stripped for rewound prompts, results reset to PENDING, `completedIndices` rebuilt correctly, `currentIndex` updated
- SKIP-AHEAD: verify results marked SKIPPED for skipped range, `_runtime.completedAt` set on skipped prompts, `completedIndices` includes skipped indices
- No-op: `toIndex === currentIndex` returns early without `emitStateChange`

Tests for `reorderPendingPrompts`:

- Verify done-prefix (indices < currentIndex) is unchanged
- Verify pending section reordered per `newPendingOrder`
- Verify `results` array reordered in sync with `prompts`

---

## Implementation Order

1. **Phase 1** — types/constants (unlocks all downstream TypeScript)
2. **Phase 2** — PromptQueue + WorkflowInstance (pure TypeScript, no UI risk)
3. **Phase 3** — settings infrastructure (required before modal can read `confirmResetOperations`)
4. **Phase 4** — webview store (required before Phase 7 webview handler compiles)
5. **Phase 7** — message routing (wires Phase 2 backend to Phase 4 store)
6. **Phase 5** — new components (self-contained, can overlap with Phase 4)
7. **Phase 6** — PromptItem, StatusIcon, PromptsPanel (depends on all above)
8. **Phase 8** — tests (after all behaviour is stable)
