# Multi-Select Steps Plan

**Status: v1 complete (2026-10-03).**

## Goal

Let the user select more than one step in `WorkflowStepsPanel` and act on all of them
at once: **bulk delete, bulk reorder, bulk property edit, bulk enable/disable, and
bulk color**.

There are no checkboxes. Every `WorkflowStepItem` row
(`components/prompts/WorkflowStep.tsx`) can be selected, including completed and
running steps, prompt and script steps, and parallel-group members. The selection is
built with the standard list gestures (Shift+Click, Ctrl/Cmd+Click, Ctrl+A) on
desktop, and with context-menu items on touch.

**Selection is unrestricted. What the selection lets you _change_ is restricted.**
Each available action is derived from the selection's contents:

| Action                                  | All editable, prompts only | All editable, mixed or scripts only | Selection includes a completed/running/locked step |
| --------------------------------------- | -------------------------- | ----------------------------------- | -------------------------------------------------- |
| Color                                   | yes                        | yes                                 | **yes**                                            |
| Enable / disable                        | yes                        | yes                                 | no                                                 |
| Delete                                  | yes                        | yes                                 | no                                                 |
| Reorder (drag, Move Up/Down)            | yes¹                       | yes¹                                | no                                                 |
| Prompt properties (drawer, quick picks) | yes                        | no                                  | no                                                 |
| Prompt text                             | no (see Future)            | no                                  | no                                                 |

¹ v1 excludes selections containing parallel-group members from multi-drag. See §6.

While more than one step is selected, `CodeMirrorEditor` is read-only and its
placeholder explains the state (§8). For example: _"5 prompts selected — use the
prompt properties drawer to change the properties for all selected prompts"_, or
_"5 steps selected — cannot edit properties for completed or running steps. Remove
them from the selection to edit properties. Color can still be changed."_

No existing backlog doc covers this. `dev/backlog/` was searched for "multi-select"
and "bulk", and the only hits are unrelated (MCP Manager bulk actions, scheduling).

### Why allow locked steps in the selection at all

Two reasons: a click on a completed step already navigates the output pane to that
step, and completed steps can already have their color changed. Refusing them in a
multi-selection would make range selection across the done/pending boundary (the
common case) silently skip rows. It would also make bulk recolor of a finished run
impossible.

There is no blocker to allowing them. The costs are:

1. **Capabilities must be derived live, not computed once at selection time.** A
   selected pending step can start running while the user works on the selection.
   That must flip Delete, Enable and property editing to disabled. The host
   re-validates each batch atomically anyway (§4), so a race still loses cleanly with
   an error toast and no partial write.
2. **Color must travel on the color-only path whenever any locked step is selected.**
   `UPDATE_PROMPT` on a completed step triggers the rewind/continuation flow. Bulk
   color therefore must never ride the general bulk-update message when the
   selection contains a locked step. §5 handles this.
3. **Range selections across the boundary will often land in the color-only state.**
   The explanatory placeholder and tooltips (§8) carry most of the UX weight, so they
   need to name the fix ("remove them from the selection").

### Non-goals (v1)

- **Shared prompt-text editing** ("the same prompt for many steps"). It fits the
  design, but needs its own UX. See "Future: shared prompt text".
- Bulk editing of script-only fields (`script`, `timeoutSec`, `onPass`, …).
- Multi-select gestures in `PromptChipRail`, the collapsed rail. It renders the
  selection but keeps single-select clicks. See §11.
- Bulk copy/paste. This is a natural follow-up because `serializeWorkflowStepText`
  and `INSERT_WORKFLOW_STEP` already exist, but it isn't requested.
- The final step (`FinalStepFooter`). It is not a `WorkflowStepItem`, has its own
  selection target and update message (`UPDATE_FINAL_PROMPT`), and cannot be deleted
  or reordered. It never joins a multi-selection.

---

## What exists today (research)

### Selection is single-valued and owned by `editorStore`

- `editorStore.selectionTarget` is `NEW_PROMPT | {QUEUE, index} | FINAL_STEP`
  (`store/editorStore.ts:162`). Selecting a step _loads it into the editor draft_:
  `selectPrompt` → `enterEditMode` (`editorStore.ts:488-665`) copies the step's text,
  name, script fields and `properties` (`PropertyValues`, `editorStore.ts:65`) into
  draft state. Unsaved edits are kept per target in `pendingEdits`, keyed by
  `queue:<index>` (`selectionTargetKey`, `editorStore.ts:155`), and sent to the host
  only when the user presses Update.
- The row click path discards the DOM event. `WorkflowStepRow.tsx:193` passes
  `onClick={() => onStepClick(index)}` → `WorkflowStepsPanel.handleStepClick`
  (`WorkflowStepsPanel.tsx:1152`) → `useStepClickHandler` (`hooks/useStepClickHandler.ts`).
  That handler calls `selectPrompt` and then smooth-scrolls the output pane to the
  step. No `shiftKey`/`ctrlKey` reaches the handler today.
- Rows render in three places, and all use `isSelected = selectionTarget.index === index`:
  1. the executed/locked prefix (`WorkflowStepsPanel.tsx:~2049`),
  2. the sortable pending list (`~2164`),
  3. members of parallel groups (`ParallelGroupPanel.tsx:362, 428`, via a single
     `selectedIndex` prop).
- `cy-no-select` is already on the panel root (`WorkflowStepsPanel.tsx:1875`), so
  shift+click will not start a native text selection.
- The listbox `onKeyDown` (`WorkflowStepsPanel.tsx:~1950`) handles Escape (deselect)
  and Ctrl+C/Ctrl+V. It explicitly bails when Shift, Alt or Meta is held. Ctrl+Z/Y is
  a window capture listener (`hooks/useUndoRedoKeyHandler.ts`).
- Nothing remaps `selectionTarget.index` after a structural change. Drag reorder
  (`WorkflowStepsPanel.tsx:~1733`), Move Up/Down (`useStepContextMenu.tsx:~193`) and
  editor delete (`PromptEditor.tsx:~1358`) call `cancelEdit()`. The context-menu
  delete and the `PROMPT_DELETED` / `REORDER_PROMPTS_CONFIRMED` handlers
  (`useMessageHandler.ts:1056-1118`) don't touch selection at all. **So the existing
  single selection can already go stale after a context-menu delete.**

### Step mutations are revision-guarded

- `DELETE_PROMPT { indices }` and `UPDATE_STEP_COLOR { indices, color }` are
  batch protocols. `UPDATE_PROMPT { index, text, properties, clearProperties,
promptName, rewindCompletedStep? }` (`src/types/WebviewMessageTypes.ts`). They route
  through `WorkflowStepHandlers` to `WorkflowOrchestrator` and have two
  persistence branches:
  - **Instance-bound:** `WorkflowInstance` → `PromptQueue.updatePrompt`,
    `deletePrompts` or `updatePromptColors`.
  - **Run-addressed static write:** `applyRunAddressedMutation` → one
    `WorkingFileManager`/`RunContinuationService` batch write. Deletes validate
    every index before mutation and compute parallel topology from the final set.
- **`UPDATE_STEP_COLOR` exists precisely so a cosmetic edit bypasses completed-step
  rewind classification.** Its payload deliberately cannot carry content or
  properties (doc comment at `WebviewMessageTypes.ts:~2159`). The run-addressed write
  passes a `StepColorInvalidation { kind: "stepColor", indices }`
  (`core/orchestration/RunViewPublisher.ts:35`) so the view refresh stays narrow.
  This is why completed steps can already be recolored, and it is the path bulk color
  must reuse.
- **The webview's `sendMessage` stamps every definition mutation with a
  `WorkflowDefinitionMutation`** (`{address, expectedDefinitionRevision,
expectedDescriptorRevision}`, `hooks/useMessageHandler.ts:~213`). Therefore
  **N back-to-back messages cannot implement a bulk op**. They all carry the same
  expected revision, so the first write succeeds and the rest are rejected as
  stale. The same race is documented for `UPDATE_PROMPT` +
  `SET_START_POSITION` at `WorkflowStepHandlers.ts:137`, which is why
  `updateCompletedPromptInQueue` exists. Bulk ops need **one message → one
  host-side mutation → one revision bump**.
- **Undo** is zundo on the webview's `workflowStore`. Each `PROMPT_DELETED` /
  `STEPS_EXTENDED` / `REORDER_PROMPTS_CONFIRMED` broadcast records one entry
  (`useMessageHandler.ts:947, 1056, 1084`). One bulk message that produces one
  broadcast gives exactly one undo entry, which is what we want.
- **Mutability rules** a bulk op must respect for _every_ index:
  - `PromptQueue.assertPendingRewindSuffixIndex` (`PromptQueue.ts:3133`): no
    preserved-prefix steps while a continuation is pending.
  - `PromptQueue.assertEditableDuringExecution` (`PromptQueue.ts:3181`): while
    running, the completed prefix and the in-flight step are locked.
  - On the run-addressed path, `RunContinuationService` keeps executed-prefix and
    `terminalStatus` steps immutable even after the run stops (commit 337ea9ed).
  - In the UI, `isStepExecutionLocked` (`ParallelGroupPanel.tsx:113`) plus the busy
    current step decide which rows are locked. The Delete menu item's own gate is in
    `useStepContextMenu.tsx:~446`. **Note:** today that gate only disables the
    _executing_ step (`isExternallyManaged || isExecutionTargetLocked`), so the
    menu still offers Delete on completed steps and relies on the host to reject
    it. `getStepCapabilities` must encode the host's real rules (executed prefix,
    `terminalStatus`, pending-rewind prefix), not copy the looser menu gate.
  - The single-step context-menu Enable/Disable item sends `UPDATE_PROMPT` built by
    `buildWorkflowStepEnabledUpdate`. Bulk enable uses `UPDATE_STEPS` instead.
  - Editing a _completed_ nonzero step goes through `rewindCompletedStep` →
    `updateCompletedPromptInQueue`, which starts a pending continuation. That is a
    single-step design.
- **Parallel groups:** `deleteParallelGroupStep` (`core/ParallelGroupTopology.ts:377`)
  shrinks a group, dissolves one left with fewer than two members, shifts later
  groups, and throws if a _started_ two-member group would drop to one.

### Reorder already speaks "full permutation"

- `REORDER_PROMPTS { newPendingOrder, pendingGroups }` is a full slice-relative
  permutation of the pending tail (from `currentStep`) plus the resulting group ranges
  (`buildPendingReorderPayload`, `WorkflowStepsPanel.tsx:577`;
  `PromptQueue.reorderPendingPrompts`, `PromptQueue.ts:2903`). **A multi-step move
  needs no protocol change**: it is just a different permutation.
- dnd-kit (`@dnd-kit/core ^6.3.1`, `@dnd-kit/sortable ^10`) has no multi-item drag.
  The panel already builds its own live preview (`computeLivePreviewState`,
  `previewDragState`) and reorders the DOM for real. Multi-drag therefore means
  teaching the _panel's_ drag model to move a set of items. Read the dnd-kit bullets
  in `webview-react-components.instructions.md` before touching this. They record
  several drag feedback-loop and drop-resolution traps (`overDragId` vs
  `event.over`, positional drag ids, no `<DragOverlay>`).
- Move Up/Down (`useStepContextMenu.tsx:180`) is an adjacent-swap permutation over
  the same message.

### Editor, header controls and drawer

- `CodeMirrorEditor` already takes `readOnly` and `placeholder` props
  (`CodeMirrorEditor.tsx:125-129`). `PromptEditor.tsx:1508` passes
  `readOnly={isExternallyManaged}` and a final-step placeholder.
  - `readOnly` toggles live: an effect flips `contentDOM.contentEditable`
    (`CodeMirrorEditor.tsx:789-797`).
  - **`placeholderText` does not toggle live.** It is in the view-construction
    effect's dependency list (`CodeMirrorEditor.tsx:1676`), so changing it destroys
    and recreates the `EditorView`. For a mode toggle driven by clicks, move
    `placeholder` into a `Compartment` and reconfigure it instead of rebuilding the
    view.
  - The placeholder only renders when the doc is empty, so bulk mode must also show
    an empty doc (§8).
- `EditorSection.tsx:~262-288` holds the per-step **enable toggle**
  (`setStepEnabled`, check / circle-slash icon) and the **`StepColorQuickPicker`**
  in the editor header. The same color control also appears as `StepColorField` in
  the drawer (`PropertiesDrawer.tsx:849`) and in the script editor
  (`PromptEditor.tsx:1563`). The header's "Editing: Prompt N of M" text is in
  `EditorSection.tsx:~165-176`.
- `EditorFooter` already disables its buttons through `isExternallyManaged` /
  `isPromptBeingSent` / `isPromptActivelyRunning` (`EditorFooter.tsx:~228-367`, flags
  from `PromptEditor.tsx:~302-316`). Bulk mode adds more flags of the same kind. It
  is not a new mechanism.
- `PropertiesDrawer` and the footer quick pickers read and write
  `editorStore.properties` directly (`setProperty`). They follow the tri-state model:
  `undefined` = inherit, `null` = explicitly none, value = override. **Harness change
  cascades inline** (`PropertiesDrawer.tsx:~405-420`):
  - Choosing inherit clears `harness`, `model` and `additionalArgs` to `undefined`.
  - Choosing a harness sets `model` to that harness's default model, and
    `additionalArgs` to its default args, or `null` ("none") when it has none.
- `PromptEditor.handleUpdate` (`PromptEditor.tsx:~1162-1340`) builds
  `{properties, clearProperties}` from the draft (`getPropertyValues(true)`,
  `PromptEditor.tsx:~410`) and sends `UPDATE_PROMPT`. It sends `UPDATE_STEP_COLOR`
  instead when only the color changed.
- Host side, `WorkflowInstance.updatePromptInQueue` merges with
  `mergeWorkflowStepUpdate` (`src/core/WorkflowStepSanitizer.ts:578`): existing step,
  then incoming fields, then cleared keys. That merge is already a partial-patch
  primitive, which is exactly what a bulk update needs per step.
- Inherited values display as "Inherit (X)" (`INHERIT_DEFAULT_OPTION`, resolved step →
  workflow → global in `PropertiesDrawer.tsx:~170-300`). Override styling comes from
  `FooterQuickPicker`'s `isOverride` prop, and tab override badges come from
  `hooks/useDrawerTabOverrides.ts`. **There is no "mixed value" concept anywhere
  yet.**
- Fields **shared by prompt and script steps**: `name`, `enabled`, `color`,
  `executionMode`, `secrets`, `errorBehavior`. v1 bulk-edits two of them, `enabled`
  and `color`, on mixed selections.

---

## Design

### 1. Selection model: a multi-selection slice in `editorStore`

Keep `selectionTarget` for the _primary_ (single) selection. It still drives the
editor for a single step. Add the multi-selection next to it in `editorStore`, which
owns selection. `uiStore` is for persisted view state, and multi-selection should not
persist.

```ts
// editorStore
multiSelection: {
  indices: number[];          // absolute queue indices, kept sorted ascending
  anchorIndex: number;        // range origin for Shift+Click / "Select to Here"
} | null;                     // null = not in multi-select mode
```

Rules:

- `multiSelection` is non-null only when `indices.length >= 2`. Dropping back to one
  selected index collapses into an ordinary `selectPrompt(index)`, so single-step
  editing is unchanged.
- Entering multi-select from a single edited step runs the same save that
  `deselect()` already does (`editorStore.ts:771`). The step's unsaved draft goes into
  `pendingEdits` and is restored if the user returns to that step alone.
- **Any `WorkflowStepItem` can be selected**: completed, running, locked, disabled,
  prompt, script, parallel-group member. The final step cannot (see Non-goals).
- **Index stability.** Steps have no stable id, and drag ids are positional (see the
  `stepDragId` bullet in the components instructions). So the selection is
  index-based, and it must be remapped or cleared on _structural_ changes only:
  - After a bulk reorder, the panel knows the permutation it sent. It remaps
    `indices` through it so the moved block stays selected.
  - After a bulk delete, clear the multi-selection.
  - On any other structural change (step count changes, or order changes from
    another client, undo/redo, `RUN_VIEW_LOADED`, or a workflow switch), clear it.
  - **Do not clear on runtime-only updates.** Selections now include running
    workflows, and `STEPS_EXTENDED` also fires for status/runtime promotion. Clearing
    on every broadcast would make a selection impossible to hold during a run. Gate
    the clear on "length changed or step identity at some index changed", using
    `isStepContentEqual` (the single source for step-content equality,
    `workflowStore`).
  - Fix the existing single-selection staleness gap in the same hook points.
- Selectors must return primitives or stored references
  (`webview-react-store.instructions.md`). Expose `useIsStepMultiSelected(index)`
  that returns a boolean rather than having every row subscribe to the array.
  Otherwise a 50-step workflow re-renders every memoized `WorkflowStepItem` on each
  click.

### 2. Capabilities: one per-step predicate, reduced over the selection

The capability matrix in the Goal must not be re-derived separately by the context
menu, editor header, drawer, footer and drag code. Single-source it:

```ts
// utils/stepCapabilities.ts
interface StepCapabilities {
  canEditColor: boolean;       // true for every queue step, as today
  canToggleEnabled: boolean;   // false for completed/running/locked
  canDelete: boolean;
  canReorder: boolean;         // pending, not in-flight, and not cancelling
  canEditPromptProperties: boolean; // prompt step AND not locked
}
getStepCapabilities(step, index, ctx): StepCapabilities
getSelectionCapabilities(indices, steps, ctx): StepCapabilities // AND-reduce + group rule
```

- `ctx` carries `currentStep`, `executionState`, pending-rewind boundary and the
  externally-managed / read-only-lineage flags. Build the per-step half from the same
  facts the UI already uses (`isStepExecutionLocked`, the context menu's Delete gate),
  moving that logic here. The single-step context menu then uses
  `getStepCapabilities` too. That is one source for "can this step be X'd", instead
  of a second copy for bulk.
- `getSelectionCapabilities` also applies the v1 group rule: `canReorder` is false if
  any selected step is a parallel-group member.
- Recompute on every render from live store state (memoized on `steps`,
  `currentStep` and `executionState`), never snapshot it at selection time. See
  "Why allow locked steps", item 1.
- The host stays authoritative. These capabilities only decide what the UI offers;
  every batch is re-validated atomically on the host (§4, §5).
- The capability lock includes the host's executed prefix (`index < currentStep`),
  any `_runtime.terminalStatus`, the pending-rewind preserved prefix, and the
  currently executing target. This is stricter than the former single-step Delete
  menu gate, which only checked the executing target. Color remains available for
  every queue step because it uses the cosmetic update path.

### 3. Gestures

Standard list-selection conventions (Windows Explorer, VS Code's explorer, macOS
Finder list view). **Alt+Click is not a standard deselect gesture in lists**: VS Code
uses it for multi-cursor, some Linux desktops use it to move windows, and only image
editors use it for "subtract from selection". Deselection is Ctrl/Cmd+Click, which
toggles.

| Gesture                               | Behavior                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Click                                 | Unchanged: single select, loads editor, scrolls output to the step.                                  |
| Shift+Click                           | Replace the selection with the range `anchor..clicked` (anchor unchanged).                           |
| Ctrl+Click (Cmd+Click on macOS)       | Toggle the clicked step in or out of the selection; clicked step becomes the anchor.                 |
| Ctrl+Shift+Click (Cmd+Shift on macOS) | Add the range `anchor..clicked` to the existing selection.                                           |
| Ctrl+A / Cmd+A (step list focused)    | Select all queue steps (not the final step).                                                         |
| Escape / click empty list space       | Clear the selection (the existing `deselect()` paths).                                               |
| Delete (step list focused)            | Delete the selection, or the single selected step (with confirmation per `confirmDeleteOperations`). |
| Shift+ArrowUp/Down (optional, later)  | Extend the range by one step with the keyboard.                                                      |

- **Anchor:** the primary `selectionTarget` index when leaving single selection. After
  that, the last plain click or Ctrl-click.
- **Output navigation stays as today.** Any click that leaves the clicked step
  selected scrolls the output pane to it (`useStepClickHandler`). A Ctrl-click that
  _removes_ a step doesn't scroll.
- **Ctrl+A scope:** only when focus is in the step list. Inside CodeMirror, Ctrl+A
  keeps selecting editor text. The list's `onKeyDown` already filters editable
  targets with `isEditableClipboardTarget`, which is the same guard to reuse.
- **macOS:** use `metaKey` rather than `ctrlKey`, because Ctrl+Click is a right-click
  on macOS. Derive "toggle" as `isMac ? e.metaKey : e.ctrlKey` in one helper.
- **Plumbing:** change the row click contract from `(index) => void` to
  `(index, modifiers: StepClickModifiers) => void`, where
  `StepClickModifiers = { range: boolean; toggle: boolean }`. Derive it once in
  `WorkflowStepItem` from the `MouseEvent`. Thread it through `WorkflowStepRow`,
  `SortableWorkflowStepWrapper` and `ParallelGroupPanel` (`onStepClick`). Keyboard
  Enter/Space passes `{range:false, toggle:false}`.

### 4. Touch (and the context menu in general)

Touch has no modifier keys, so the long-press context menu (`useLongPress` →
`useStepContextMenu`) gains selection items. They are also shown on desktop
right-click, where they're harmless and discoverable:

| Item                      | Shown when                                                                                | Effect                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Select All**            | always                                                                                    | Same as Ctrl+A.                                                            |
| **Select to Here**        | something is already selected (single or multi) and the pressed row isn't the only member | Range `anchor..pressed row` (Shift+Click).                                 |
| **Add to Selection**      | pressed row is not selected and something else is                                         | Ctrl+Click equivalent. Needed for non-contiguous selections on touch.      |
| **Remove from Selection** | pressed row is part of a multi-selection                                                  | Ctrl+Click equivalent. The only way to drop one row from a range on touch. |
| **Clear Selection**       | multi-selection active                                                                    | Escape equivalent.                                                         |

Add/Remove matter because the placeholder text (§8) tells users to "remove completed
or running steps from the selection". Without them, a touch user could select a range
but could not take the blocking step back out.

**Right-click/long-press on a row outside the multi-selection must not collapse the
selection.** Otherwise "Select to Here" and "Add to Selection" could never work on
touch. Adopt VS Code's explorer behavior instead: the selection stays, and the
menu's _row_ actions (Delete, Move Up/Down, Dry Run, …) target the pressed row alone.
When the pressed row is _inside_ the multi-selection, the row actions become bulk
actions: "Delete 5 steps", "Disable 5 steps", "Move Up", "Move Down". Each is gated by
`getSelectionCapabilities`, and a disabled item carries a tooltip giving the reason.

### 5. Protocol and host changes

Pre-release means no compatibility constraints, so **generalize the single-index
messages to index arrays** instead of adding parallel bulk twins. Single-step callers
send `[index]`. This leaves one handler, one queue method and one test surface per
operation (DRY).

| Message                  | Change                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `DELETE_PROMPT`          | `index: number` → `indices: number[]`.                                                                                  |
| `UPDATE_STEP_COLOR`      | `index: number` → `indices: number[]`. `StepColorInvalidation.index` → `indices`.                                       |
| **`UPDATE_STEPS`** (new) | `{ indices, properties, clearProperties }`. No text, no name. Bulk properties + `enabled` + `color` for editable steps. |
| `UPDATE_PROMPT`          | Unchanged. It is still the single-step content editor (text, name, `rewindCompletedStep`).                              |
| `REORDER_PROMPTS`        | Unchanged. Multi-moves are just permutations.                                                                           |

Add `UPDATE_STEPS` to the `definitionMutationTypes` set in `sendMessage`. Keep
`WebviewMessageTypes.ts`, `DashboardConstants.MESSAGE_TYPES`, the router table,
`WorkflowStepHandlers`, and `McpServer`'s `remove_step` tool (which calls the same
delete path) in sync.

**Host semantics, the same for all three array messages:**

- **Validate every index before mutating anything.** Use the existing guards
  (`assertPendingRewindSuffixIndex`, `assertEditableDuringExecution`,
  `RunContinuationService` executed-prefix / `terminalStatus` immutability) on
  each index. One bad index rejects the whole batch.
- Apply, then bump the revision once, write the working file once, and emit one
  broadcast. That gives one undo entry.
- **Delete** (`PromptQueue.deletePrompts`): delete in **descending** index order.
  Its private `removeStepAt(index)` handles the `currentIndex`,
  `completedIndices` and `results` shifts. `deleteParallelGroupSteps` computes
  topology for the complete selection. **Parallel-group
  edge case:** removing two members of a started three-member group passes a
  per-step check on the first and throws on the second, after the first was
  already applied in memory. So compute the next topology for the whole batch
  first, then commit it.
  - Run-addressed: `WorkingFileManager.deleteStepsAtRun` and
    `RunContinuationService.removeStepsAtRun` validate and commit the whole batch.
- **Color** (`updateStepColorInQueue(indices, color)`): keeps its deliberate property:
  it **cannot carry anything but color**, so it stays legal on completed steps and
  never triggers rewind classification. It skips the editability guards exactly as
  today, and only range-checks the indices.
- **`UPDATE_STEPS`** (`PromptQueue.updateSteps`): per index, apply
  `mergeWorkflowStepUpdate` without persisting per step. It also validates keys per
  step kind: script steps accept only the shared keys `enabled` and `color`, and
  prompt steps accept the bulk-editable prompt keys too. Keep that key list as one
  exported constant, used by both the host validator and the UI's field gating. It
  **never** takes the `rewindCompletedStep` path: completed/locked steps fail
  validation instead. Run-addressed: `WorkingFileManager.updateStepsAtRun`, reusing
  `buildPromptStepChange` per index. One `STEPS_EXTENDED` broadcast.

**Rejected alternative: merge on the client and post an `UNDO_REDO_SYNC`-style
whole-steps write.** `syncStepsForUndoRedo` already writes every step under one
revision. But it is a whole-topology replace built for restoring a known-good
snapshot. It skips the per-index editability checks and the completed-step rewind
classification. It also overwrites any concurrent host-side change to steps outside
the selection with the client's copy. Targeted index-array messages keep the host
authoritative over everything the user didn't select.

### 6. Bulk reorder (drag a multi-selection)

**Drag model:** the user grabs the drag handle of _any_ selected row. On drop, the
selected rows are pulled out of the pending order, **preserving their relative
order**, and reinserted as a contiguous block at the drop slot. Non-contiguous
selections become contiguous. This is how VS Code's explorer and most list UIs
behave, and it is the only interpretation that makes sense for a single drop slot.

- `buildPendingDragState` / `movePendingDragItem` / `computeLivePreviewState`
  (`WorkflowStepsPanel.tsx:~234-376`) learn a "companion ids" list. When the active
  drag id belongs to the multi-selection, the preview collapses the companions into
  the active item's slot (hidden, with a "+N" badge on the active row) and moves one
  logical block. `buildPendingReorderPayload` expands the block back into member
  indices.
- Multi-drag is only available when `getSelectionCapabilities(...).canReorder`: every
  selected step is pending and reorderable, and none is a parallel-group member. In
  any other case, handles on selected rows do a normal single-row drag of that row,
  and the multi-selection stays.
- Dragging an **unselected** row's handle does a normal single-row drag.
- After `REORDER_PROMPTS` is sent, remap `multiSelection.indices` through the
  permutation (§1).
- **Bulk Move Up/Down** in the context menu shifts the whole block by one slot as one
  permutation. This is the touch and keyboard path.
- The block-move and permutation logic lives as **pure functions** in
  `utils/stepMultiSelection.ts`, shared by the drag and Move Up/Down paths and
  unit-tested without dnd-kit.
- Group-aware multi-drag (moving a block into or out of parallel-group containers)
  is a follow-up. It multiplies the already delicate container logic
  (`resolvePendingDropTarget`, the straddle checks in
  `reorderParallelGroupPendingSteps`).

### 7. Bulk property, enable and color edit (the patch draft)

The drawer, quick pickers, enable toggle and color picker are all built around a
_single_ draft (`editorStore.properties`, `stepEnabled`). Bulk mode swaps in a sparse
patch:

```ts
// editorStore, alongside multiSelection
bulkPatch: Partial<PropertyValues & { enabled: boolean }>; // only keys the user touched
```

- **Display value per field** is derived, never stored:
  - the patch value if the key is in `bulkPatch`;
  - else the common value if every selected step has the same raw value (including
    "all inherit" = `undefined`);
  - else a **MIXED** sentinel. Pickers render it as "(mixed)". The enable toggle
    gets a third, mixed icon state. The color picker shows a mixed swatch.
- **Choosing the original value again is how you revert a field.** No separate
  "revert" control is needed:
  - When the selected steps' original values differ, the field's dropdown (or the
    mode dropdown of a compound editor) offers **"(mixed)"** as a real option,
    alongside inherit/none/override. Selecting it **removes the key from
    `bulkPatch`**, so each step keeps its own value. The option only exists when the
    originals differ.
  - When the originals all agree, there is no "(mixed)" option, because the common
    value _is_ the original. **Normalize on write:** a patch value equal to the common
    original is dropped from the patch rather than stored. This keeps "change it,
    then change it back" at `isDirty = false`, and stops Update from sending no-op
    writes (which would still bump the revision and add an empty undo entry).
  - **Cascades revert together.** Choosing "(mixed)" (or the original harness) on
    harness also drops the `model` and `additionalArgs` keys the harness cascade
    wrote, unless the user set those separately afterward. Otherwise reverting
    harness would leave its companion overrides behind.
  - After Update, reverting is the normal Undo, which is one entry per bulk
    operation (§5).
- **Writes** go to `bulkPatch` instead of `properties` / `stepEnabled`. The least
  invasive route is a store-level redirect: `setProperty` and `setStepEnabled` check
  `multiSelection` and write to the patch. The controls then only need to render the
  MIXED state and read the derived display value, and their write calls are
  unchanged.
- **Field gating** comes from `getSelectionCapabilities` (§2):
  - Prompt fields are disabled unless `canEditPromptProperties`. That means every
    drawer page except the color field, and the footer quick pickers.
  - The enable toggle is disabled unless `canToggleEnabled`.
  - Color is always enabled.
  - A disabled control's tooltip names the reason and the fix: _"Cannot edit
    properties for completed or running steps. Remove them from the selection to
    edit properties."_, or _"Select only prompt steps to edit prompt properties."_
- **Harness cascade applies in bulk exactly as for a single step.** Choosing a
  harness writes `harness`, `model` (the harness's default model) and
  `additionalArgs` (the harness's default args, or `null` "none") into the patch.
  Choosing inherit writes all three as `undefined`. The new harness is the same for
  every selected prompt, so the companion values are uniform and fit the patch.
  Extract today's inline cascade (`PropertiesDrawer.tsx:~405-420`) into a pure
  `buildHarnessChangeCascade(harness)` → `Partial<PropertyValues>` that both modes
  call. `HarnessQuickPicker` (`HarnessQuickPicker.tsx:~57`) has its own copy of
  this cascade today, so route it through the same helper. That removes an existing
  duplication and keeps the footer picker and drawer from drifting apart in bulk
  mode.
- **Harness-dependent option lists:** when the selected prompts' _effective_
  harnesses differ and the patch doesn't set `harness`, the model and
  additional-args pickers have no single option list. Disable them with _"Set a
  harness to change the model for all selected prompts."_ Audit each drawer page for
  other harness-scoped option lists (skills, agents, tool permissions).
- **Fields not offered in bulk (v1):** `sessionId`/`resumeSession` (step-relative),
  `endCondition`/`preCondition` (nested editors, a later addition), and `name`
  (per-step identity).
- **Update / Cancel:** the footer's Update commits the patch, and Cancel discards it.
  `isDirty` is true when the patch is non-empty. Update picks the message:
  - Patch is color-only → `UPDATE_STEP_COLOR { indices, color }`. This is legal even
    when locked steps are selected.
  - Otherwise → `UPDATE_STEPS { indices, properties, clearProperties }`. It is only
    enabled when the selection's capabilities allow every key in the patch. Build
    `properties`/`clearProperties` with the **same** tri-state mapping
    `getPropertyValues` uses, extracted so single and bulk share it.
- **Selection changes keep the patch.** If the user edits harness and then
  Shift-clicks a completed step into the selection, the patch survives. Update
  disables with the "remove completed or running steps" tooltip, and removing the
  step re-enables it. Clearing the selection entirely discards the patch, the way
  Cancel does.
- **Immediate context-menu actions** skip the patch. "Disable N steps" / "Enable N
  steps" sends `UPDATE_STEPS { enabled }` directly. The label is "Disable" if any
  selected step is enabled, otherwise "Enable".

### 8. Editor in bulk mode

`CodeMirrorEditor` is read-only with an empty doc and a state-specific placeholder.
The strings live in `EDITOR_PLACEHOLDER_TEXT` (`DashboardConstants.ts:2217`) as
formatter functions of `N`:

| Selection state                   | Placeholder                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All editable, prompts only        | "N prompts selected — use the prompt properties drawer to change the properties for all selected prompts"                                                  |
| All editable, mixed/scripts only  | "N steps selected — color, enable/disable, reorder and delete apply to all selected steps. Select only prompts to edit prompt properties."                 |
| Includes completed/running/locked | "N steps selected — cannot edit properties for completed or running steps. Remove them from the selection to edit properties. Color can still be changed." |

- Render the editor with a bulk-mode `value=""`. Don't write into `promptText`, and
  don't let the empty value leak into any step's draft or `pendingEdits`.
- Move `placeholder` into a CodeMirror `Compartment` so entering and leaving bulk mode
  doesn't destroy the `EditorView`. Otherwise it would drop undo history and
  completion state for the next single-step edit. `readOnly` already toggles live.
- The header's "Editing: Prompt N of M" becomes "N prompts selected" / "N steps
  selected". The enable toggle and `StepColorQuickPicker` stay in the header,
  bound to the patch (§7).
- The drawer can open for any multi-selection, so color is reachable there too. Its
  pages are gated per §7. `ScriptConditionEditor` is not rendered in bulk mode.
- Footer: Update/Cancel are enabled per §7. Run/Queue, Dry Run and the editor's own
  Delete button (`PromptEditor.tsx:~1342-1375`) are disabled or hidden in bulk mode,
  through the same flag path `isExternallyManaged` uses. Bulk delete is reached from
  the context menu and the Delete key.

### 9. Row visuals

- A multi-selected row uses the existing `isSelected` styling (`bg-list-active-bg`).
  The anchor gets no distinct look in v1.
- `ParallelGroupPanel`'s `selectedIndex?: number` becomes a memoized predicate or a
  `ReadonlySet<number>`, so memoized rows don't all re-render.
- `PromptCounter` shows "N selected" while in multi-select mode.

### 10. Hosted browser dashboard

There is nothing host-specific: selection is client-local, and the changed messages
go through the same `WebviewMessageRouter` table for both hosts. The macOS
`metaKey` rule (§3) matters most here, since the browser client is the one most
likely to run on a Mac.

### 11. Chip rail

`PromptChipRail` (the collapsed panel) renders multi-selected chips as selected,
which is cheap once the predicate exists. Clicks there stay single-select in v1.

---

## Phasing

> Phasing note (orchestrator review, 2026-10-03): `UPDATE_STEPS` moved from phase 4
> to phase 2b. Bulk enable/disable (phase 3 and the context-menu items) needs it, so
> the host message must land first. Phase 4 is now purely the drawer/picker UI.

1. **Selection model, capabilities and gestures.**
   - [x] 1a: pure selection helpers (`utils/stepMultiSelection.ts`, selection half), the
         `multiSelection` slice, `stepCapabilities.ts`, and the single-step context menu
         migrated onto it (completed 2026-10-03).
   - [x] 1b: modifier plumbing through the three row render sites, plus Ctrl+A and
         Escape. The context-menu selection items (Select All / Select to Here / Add /
         Remove / Clear), and the no-collapse right-click rule. The structural-change
         remap/clear rules, including the existing staleness fix. Row highlighting,
         `PromptCounter` and chip-rail rendering (completed 2026-10-03).
2. **Array protocol, `UPDATE_STEPS`, and bulk delete / enable.**
   - [x] 2a: `DELETE_PROMPT` and `UPDATE_STEP_COLOR` use `indices` end to end,
         with one host mutation, revision bump, persistence write and broadcast per
         batch. The MCP `remove_step` tool preserves its single-index schema and
         delegates through the batch delete path (completed 2026-10-03).
   - [x] 2b: `UPDATE_STEPS` end to end on the host, with one exported bulk-editable
         prompt-key constant shared by host validation and webview imports. The Delete
         key, bulk context-menu Delete and Enable/Disable, count-aware confirmation,
         atomic completed/locked/key validation, and one-broadcast batch undo behavior
         are implemented (completed 2026-10-03).

3. **Editor bulk mode and patch draft** (completed 2026-10-03).
   - Placeholder `Compartment`, state-specific placeholders, and an empty read-only
     editor without changing the single-step draft.
   - The `bulkPatch` slice with derived MIXED display, normalized writes, selection
     persistence, and the `setProperty`/`setStepEnabled` redirect.
   - Bulk color and enable/disable from the editor header, committed through Update
     (`UPDATE_STEP_COLOR` for color-only, otherwise `UPDATE_STEPS`). The editor's own
     Delete action and run/queue actions are unavailable in bulk mode.
   - Tri-state property mapping is shared with single-step updates. Prompt property
     pickers and drawer pages remain gated for phase 4.
4. **Bulk prompt properties** (completed 2026-10-03).
   - The harness cascade helper, harness-dependent gating, and drawer page gating.
   - MIXED rendering and the "(mixed)" option in the drawer and footer pickers.
   - Drawer option-list audit: model, additional args, skills, agents, and tool
     permission options depend on the effective harness and are gated when selected
     prompts differ and no harness patch exists. Prior context, MCP servers, hooks,
     and secrets use workflow/global or workspace options and are not harness-scoped.
5. **Bulk reorder** (completed 2026-10-03).
   - Block-move pure helpers and bulk Move Up/Down.
   - Multi-drag in the live preview, with no parallel groups.
6. **Follow-ups:**
   - Shared prompt text; bulk script-field edit; bulk `executionMode` / `secrets` /
     `errorBehavior` on mixed selections.
   - Group-aware multi-drag; Shift+Arrow keyboard extension; chip-rail gestures.
   - A "Select All Pending" context-menu item for the "retune every remaining step"
     case. It isn't needed in v1: completed steps always sit above incomplete ones,
     so the pending steps are one contiguous block at the bottom. Click the first
     pending step and Shift+Click the last (or "Select to Here" on touch) already
     selects exactly them.
   - Bulk copy/paste; bulk property edit of completed steps via one rewind to
     `min(indices)`.

## Testing

- **Pure helpers:**
  - `utils/stepMultiSelection.ts`: range, toggle and add-range selection; anchor
    movement; block-move permutation (contiguous and non-contiguous, block to start or
    end, no-op drop); index remap through a permutation.
  - `utils/stepCapabilities.ts`: every row of the Goal matrix, running/completed/
    pending-rewind prefixes, and the group reorder rule.
  - `buildHarnessChangeCascade`: inherit, harness with default args, and harness
    with none.
- **`editorStore`:**
  - Entering multi-select saves the single-step draft to `pendingEdits`, and
    collapsing to one restores it.
  - The patch redirect and MIXED derivation.
  - Choosing "(mixed)" drops the key. Setting a value back to the common original
    leaves the patch empty (`isDirty` false). Reverting harness also drops its
    cascade companions, but not a companion the user set separately afterward.
  - The patch survives selection changes and is discarded on clear.
- **`WorkflowStepsPanel.test.tsx` / `WorkflowStepsPanelDrag.test.tsx`:**
  - Every gesture in §3, across all three render sites, including completed rows.
  - Output scroll on add-clicks but not on remove-clicks.
  - Ctrl+A ignored inside the editor; the Delete key.
  - Multi-drag payload, and the single-drag fallback when capabilities forbid a
    multi-drag.
  - Selection survives a runtime-only `STEPS_EXTENDED`.
  - A re-render-count assertion that a Shift+Click doesn't re-render every row.
- **`useStepContextMenu.test.tsx`:**
  - The selection items and their show conditions.
  - Right-click outside the selection keeps it and targets the pressed row.
  - Bulk labels and counts; disabled items with reason tooltips.
- **Editor:**
  - Placeholder per state, without rebuilding the `EditorView` (assert view
    identity).
  - Update picks `UPDATE_STEP_COLOR` for a color-only patch with a completed step
    selected, and `UPDATE_STEPS` otherwise.
- **`useMessageHandler.test.ts` / `workflowStore.temporal.test.ts`:** one bulk
  delete/update/color produces exactly one undo entry, and undo restores all N steps.
- **Extension** (`src/test/promptQueue.test.ts`, `unit/WorkflowStepHandlers.test.ts`,
  `unit/ParallelGroupTopology.test.ts`, `unit/WorkingFileManager.test.ts`,
  `unit/RunContinuationService.test.ts`, `unit/McpServer.test.ts`):
  - Batches are atomic: a bad index rejects the whole batch with nothing written.
  - Descending-order delete bookkeeping, and the started-group edge case evaluated
    against the final topology.
  - Exactly one revision bump per batch.
  - Bulk color succeeds on completed steps without starting a continuation.
  - `UPDATE_STEPS` rejects completed/locked indices, and rejects prompt-only keys on
    script steps.
- **Smoke:** `test/smoke/dashboardMount.test.tsx` renders with a multi-selection
  present. New selectors are the classic place for an unstable-selector React #185
  crash.

## Future: shared prompt text

The editor could become editable in prompt-only, all-editable bulk mode. It would
start empty (or show the common text if all selected prompts are identical), and on
Update the text would join `UPDATE_STEPS` as an optional `text` field. The host
merges per step already. The UX work is deciding what to show when the texts differ
and adding a confirm step ("replace the prompt text of N steps?").
