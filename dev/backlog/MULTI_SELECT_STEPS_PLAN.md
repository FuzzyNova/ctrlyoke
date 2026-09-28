# Multi-Select Steps Plan

## Goal

Let the user select more than one step in `WorkflowStepsPanel` and act on all of them
at once:

| Selection contents    | Bulk delete | Bulk reorder (drag) | Bulk property edit (drawer) | Bulk prompt-text edit |
| --------------------- | ----------- | ------------------- | --------------------------- | --------------------- |
| Prompt steps only     | yes         | yes                 | yes                         | no (see Non-goals)    |
| Mixed prompt + script | yes         | yes                 | no                          | no                    |
| Script steps only     | yes         | yes                 | no (not in v1)              | no                    |

There are no checkboxes. Modifier-clicks on `WorkflowStepItem` rows
(`components/prompts/WorkflowStep.tsx`) build the selection. While more than one step
is selected, `CodeMirrorEditor` is read-only and shows a placeholder: _"N prompts
selected — use the prompt properties drawer to change the properties for all selected
prompts"_. For a mixed selection it shows _"N steps selected — only reorder and
delete are available for mixed selections"_.

No existing backlog doc covers this. `dev/backlog/` was searched for "multi-select"
and "bulk", and the only hits are unrelated (MCP Manager bulk actions, scheduling).

### Non-goals (v1)

- **Shared prompt-text editing** ("the same prompt for many steps"). It fits the
  design below, since the patch could simply include `prompt`, but it needs its own UX
  (what to show when the texts differ, whether to confirm overwriting N prompts). It
  is deferred to a follow-up. See "Future: shared prompt text".
- Bulk editing of script-step fields.
- Multi-select in `PromptChipRail`, the collapsed rail. It keeps single selection;
  see "Chip rail".
- Multi-select on touch devices. Shift and Ctrl don't exist there; see "Touch".
- Bulk copy/paste. This is a natural follow-up because `serializeWorkflowStepText`
  and `INSERT_WORKFLOW_STEP` already exist, but it isn't requested.

---

## What exists today (research)

### Selection is single-valued and owned by `editorStore`

- `editorStore.selectionTarget` is `NEW_PROMPT | {QUEUE, index} | FINAL_STEP`
  (`store/editorStore.ts:162`). Selecting a step _loads it into the editor draft_:
  `selectPrompt` copies the step's text, name, script fields and `properties`
  (`PropertyValues`, `editorStore.ts:65`) into draft state. Unsaved edits are kept
  per target in `pendingEdits`, keyed by `queue:<index>` (`selectionTargetKey`,
  `editorStore.ts:155`), and saved to the host only when the user presses Update.
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

### Every step mutation is single-index, and revision-guarded

- `DELETE_PROMPT { index }` and `UPDATE_PROMPT { index, text, properties,
clearProperties, promptName, rewindCompletedStep? }`
  (`src/types/WebviewMessageTypes.ts:2148`). Both route through
  `WorkflowStepHandlers` (`src/ui/WorkflowStepHandlers.ts:121, 265`) to
  `WorkflowOrchestrator.{updatePromptInQueue,deletePromptFromQueue}`
  (`WorkflowOrchestrator.ts:3609, 3856`). Each has two persistence branches:
  - **Instance-bound:** `WorkflowInstance` → `PromptQueue.updatePrompt` /
    `deletePrompt` (`PromptQueue.ts:2706, 2808`).
  - **Run-addressed static write:** `applyRunAddressedMutation` →
    `WorkingFileManager.updateStepAtRun` / `deleteStepAtRun`
    (`WorkingFileManager.ts:1401, 1520`) → `RunContinuationService`.
- **The webview's `sendMessage` stamps every definition mutation with a
  `WorkflowDefinitionMutation`** (`{address, expectedDefinitionRevision,
expectedDescriptorRevision}`, `hooks/useMessageHandler.ts:~213`). Therefore
  **N back-to-back `DELETE_PROMPT`/`UPDATE_PROMPT` messages cannot implement a
  bulk op**: they all carry the same expected revision, so the first write succeeds
  and the rest are rejected as stale. The same race is documented for
  `UPDATE_PROMPT`+`SET_START_POSITION` in the comment at
  `WorkflowStepHandlers.ts:137`, which is why `updateCompletedPromptInQueue` exists.
  Bulk ops need **one message → one host-side mutation → one revision bump**.
- **Undo** is zundo on the webview's `workflowStore`. Each `PROMPT_DELETED` /
  `STEPS_EXTENDED` / `REORDER_PROMPTS_CONFIRMED` broadcast records one entry
  (`useMessageHandler.ts:947, 1056, 1084`). One bulk message that produces one
  broadcast gives exactly one undo entry, which is what we want ("undo" restores all
  N deleted steps).
- **Mutability rules** that a bulk op must respect for _every_ index:
  - `PromptQueue.assertPendingRewindSuffixIndex` (`PromptQueue.ts:3133`): no
    preserved-prefix steps while a continuation is pending.
  - `PromptQueue.assertEditableDuringExecution` (`PromptQueue.ts:3181`): while
    running, the completed prefix and the in-flight step are locked.
  - On the run-addressed path, `RunContinuationService` keeps executed-prefix and
    `terminalStatus` steps immutable even after the run stops (commit 337ea9ed).
  - In the UI, `isStepExecutionLocked` (`ParallelGroupPanel.tsx:112`) plus the busy
    current step decide which rows are locked.
  - Editing a _completed_ nonzero step goes through
    `rewindCompletedStep` → `updateCompletedPromptInQueue`, which starts a pending
    continuation. That is a single-step design.
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
  teaching the _panel's_ drag model to move a set of items, not configuring dnd-kit.
  Read the dnd-kit bullets in `webview-react-components.instructions.md` before
  touching this. They record several drag feedback-loop and drop-resolution traps
  (`overDragId` vs `event.over`, positional drag ids, no `<DragOverlay>`).
- Move Up/Down (`useStepContextMenu.tsx:180`) is an adjacent-swap permutation over
  the same message.

### Editor and drawer

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
    an empty doc (see §7).
- The editor header's "Editing: Prompt N of M" is in `EditorSection.tsx:~165-176`.
  In bulk mode it should read "N prompts selected" / "N steps selected".
- `EditorFooter` already disables its buttons through `isExternallyManaged` /
  `isPromptBeingSent` / `isPromptActivelyRunning` (`EditorFooter.tsx:~228-367`, flags
  from `PromptEditor.tsx:~302-316`). Bulk mode adds one more such flag. It is not a
  new mechanism.
- `PropertiesDrawer` (`components/editor/PropertiesDrawer.tsx`) and the footer quick
  pickers read and write `editorStore.properties` directly (`setProperty`). They
  follow the tri-state model: `undefined` = inherit, `null` = explicitly none,
  value = override. Some writes cascade: changing harness resets `model` and
  `additionalArgs` to the new harness's defaults (`PropertiesDrawer.tsx:~405-420`).
- `PromptEditor`'s Update (`handleUpdate`, `PromptEditor.tsx:~1162-1340`) builds
  `{properties, clearProperties}` from the draft (`getPropertyValues(true)`,
  `PromptEditor.tsx:~410`) and sends `UPDATE_PROMPT`. If only the color changed, it
  sends `UPDATE_STEP_COLOR` instead.
- Host side, `WorkflowInstance.updatePromptInQueue` merges with
  `mergeWorkflowStepUpdate` (`src/core/WorkflowStepSanitizer.ts:578`): existing step,
  then incoming fields, then cleared keys. That merge is already a partial-patch
  primitive, which is exactly what a bulk update needs per step.
- Inherited values display as "Inherit (X)" (`INHERIT_DEFAULT_OPTION`, resolved step →
  workflow → global in `PropertiesDrawer.tsx:~170-300`). Override styling comes from
  `FooterQuickPicker`'s `isOverride` prop, and tab override badges come from
  `hooks/useDrawerTabOverrides.ts`. **There is no "mixed value" concept anywhere
  yet.**
- Script steps close the drawer when selected (`editorStore.ts:~607`).
- Fields **shared by prompt and script steps**: `name`, `enabled`, `color`,
  `executionMode`, `secrets`, `errorBehavior`. This matters for the mixed-selection
  follow-up below.

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
  anchorIndex: number;        // for shift-range extension
} | null;                     // null = not in multi-select mode
```

Rules:

- `multiSelection` is non-null only when `indices.length >= 2`. Dropping back to one
  selected index collapses into an ordinary `selectPrompt(index)`, so single-step
  editing is unchanged.
- Entering multi-select from a single edited step runs the same save that
  `deselect()` already does (`editorStore.ts:771`). The step's unsaved draft goes into
  `pendingEdits` and is restored if the user returns to that step alone.
- The final step is never part of a multi-selection. So are rows that are not
  mutable at all: the locked prefix while running, or while a continuation is pending.
  Clicking one with a modifier is a no-op, and a plain click behaves as today.
- **Index stability.** Steps have no stable id. Drag ids are positional (see the
  `stepDragId` bullet in the components instructions). So the selection is index-based
  and must be invalidated or remapped when the step list changes:
  - After a bulk reorder the panel knows the permutation it sent and remaps
    `indices` itself, so the moved block stays selected and the user can keep
    dragging.
  - After a bulk delete, clear the multi-selection.
  - On any other change to the step list (another client's edit, undo/redo,
    `RUN_VIEW_LOADED`, workflow switch), clear it. The simplest robust hook: clear in
    the same places that today call `cancelEdit()`/reset the editor on view change
    (drag drop `WorkflowStepsPanel.tsx:~1733`, Move Up/Down
    `useStepContextMenu.tsx:~193`, workflow switch `useMessageHandler.ts:~445`),
    **and** in the `PROMPT_DELETED` / `REORDER_PROMPTS_CONFIRMED` /
    `STEPS_EXTENDED` handlers. Today those handlers don't touch selection at all, so
    even the existing single `selectionTarget.index` can go stale after a
    context-menu delete. Fix that gap for both selections at once.
- Selectors must return primitives or stored references
  (`webview-react-store.instructions.md`). Expose `useIsStepMultiSelected(index)`
  that returns a boolean rather than having every row subscribe to the array.
  Otherwise a 50-step workflow re-renders every memoized `WorkflowStepItem` on each
  shift+click.

### 2. Gestures

| Gesture                           | Behavior                                                                 |
| --------------------------------- | ------------------------------------------------------------------------ |
| Click                             | Unchanged: single select, loads editor, scrolls output.                  |
| Shift+Click                       | Select the contiguous range `anchor..index` (replacing the prior range). |
| Ctrl/Cmd+Click                    | Toggle one step in/out of the selection; moves the anchor.               |
| Escape / click empty list space   | Clear multi-selection (the existing `deselect()` paths).                 |
| Delete / Backspace (list focused) | Bulk delete (with confirmation per `confirmDeleteOperations`).           |
| Ctrl+A (list focused)             | Optional: select every mutable step.                                     |

Shift-range is what was asked for. Ctrl/Cmd-toggle costs almost nothing extra and
is what users expect from any list; without it, a non-contiguous selection is
impossible.

A shift-range that crosses immutable rows (locked prefix, running step) selects only
the mutable rows in the range. The anchor is the primary `selectionTarget` index when
entering from single selection.

Modifier-clicks must **not** trigger `useStepClickHandler`'s output scroll. Only the
plain click does.

Plumbing: change the row click contract from `(index) => void` to
`(index, modifiers: StepClickModifiers) => void`, where
`StepClickModifiers = { range: boolean; toggle: boolean }`. Derive it once in
`WorkflowStepItem` from the `MouseEvent`, with `metaKey` counting as `toggle` on
macOS. Thread it through `WorkflowStepRow`, `SortableWorkflowStepWrapper` and
`ParallelGroupPanel` (`onStepClick`). Keyboard Enter/Space keeps passing
`{range:false, toggle:false}`.

### 3. Row visuals

- `WorkflowStepItem` already has `isSelected` styling (`bg-list-active-bg`). A
  multi-selected row uses the same styling. The primary/anchor row doesn't need a
  distinct look in v1.
- `ParallelGroupPanel`'s `selectedIndex?: number` becomes a predicate
  (`isStepSelected(index)`) or a `ReadonlySet<number>`. The set must be memoized so
  the memoized rows don't all re-render.
- The step-count header (`PromptCounter`) can show "N selected" while in
  multi-select mode. This is optional but cheap.

### 4. Bulk delete

**Protocol:** new `DELETE_PROMPTS` message:

```ts
export interface DeletePromptsMessage {
  type: typeof MESSAGE_TYPES.DELETE_PROMPTS;
  indices: number[]; // absolute, any order; host sorts/dedupes
  mutation?: WorkflowDefinitionMutation;
}
```

Add it to the `definitionMutationTypes` set in `sendMessage` so it is stamped. Don't
extend `DELETE_PROMPT` to take an array. A separate type keeps the single-step path
and its tests untouched, and makes the bulk entry in router tables and logs obvious.

**Host side:** one mutation, applied atomically:

- `PromptQueue.deletePrompts(indices)`: validate **every** index first, using the same
  `assertPendingRewindSuffixIndex` + `assertEditableDuringExecution` checks, so a
  bad index rejects the whole batch before anything changes. Then delete in
  **descending** index order, reusing the per-index topology and bookkeeping logic
  (`deleteParallelGroupStep`, `currentIndex`, `completedIndices` and `results`
  shifting). Refactor `deletePrompt`'s body into a private
  `removeStepAt(index)` that both methods call, so there's one source for it. Bump the
  revision once, write the working file once, emit once.
  - Parallel-group edge case: deleting two members of a started three-member group
    one at a time would pass the first check and then throw on the second, after the
    first was already applied in memory. Validate against the _final_ topology instead:
    compute the next topology for the whole batch, and only then commit it.
- `WorkflowInstance.deletePromptsFromQueue`: one `dashboardSink.updatePromptDeleted(...)`
  broadcast (one undo entry), then `reconcileExecutionStateAfterStepChange`.
- `WorkflowOrchestrator.deletePromptsFromQueue`: same two-branch shape as
  `deletePromptFromQueue`. The run-addressed branch needs
  `WorkingFileManager.deleteStepsAtRun` and a batch remove in
  `RunContinuationService`, which enforces the executed-prefix/`terminalStatus`
  immutability on every index.
- `WorkflowStepHandlers.handleDeletePrompts` + router entry.
- **MCP / CLI parity** (optional): `McpServer`'s `remove_step` tool
  (`src/test/unit/McpServer.test.ts`) could accept an index array later. It isn't
  needed for the dashboard feature.

**UI:**

- Context menu: when the right-clicked row is part of the multi-selection, the menu
  switches to a bulk menu with "Delete N steps" (and "Move Up/Down" disabled). When
  the right-clicked row is _not_ in the selection, the selection collapses to that
  row first. This matches common file-explorer behavior.
- `useStepContextMenu`'s `pendingDeleteIndex: number | null` becomes
  `pendingDeleteIndices: number[] | null`. `DeleteConfirmModal` says "delete N
  steps?". The same `confirmDeleteOperations` setting applies.
- The editor's own Delete button (`PromptEditor.tsx:~1342-1375`) is hidden in bulk
  mode, or routed to the bulk delete.
- The Delete key handler is new. Today the list has no delete key at all, so it
  applies to single selection too (a small bonus).

### 5. Bulk reorder (drag a multi-selection)

**Protocol:** none. It is still `REORDER_PROMPTS` with a permutation.

**Drag model:** the user grabs the drag handle of _any_ selected row. On drop, the
selected rows are pulled out of the pending order, **preserving their relative
order**, and reinserted as a contiguous block at the drop slot. Non-contiguous
selections become contiguous. This is how VS Code's explorer and most list UIs
behave, and it is the only interpretation that makes sense for a single drop slot.

Implementation sketch:

- `buildPendingDragState` / `movePendingDragItem` / `computeLivePreviewState`
  (`WorkflowStepsPanel.tsx:~234-376`) learn a "companion ids" list. When the active
  drag id belongs to the multi-selection, the live preview collapses the companions
  into the active item's slot (hide them, or render a "+N" badge on the active row).
  It then moves one logical block. `buildPendingReorderPayload` expands the block
  back into its member indices.
- Dragging an **unselected** row's handle does a normal single-row drag and collapses
  the multi-selection to nothing (or to that row).
- **v1 restriction, parallel groups:** if the selection includes any parallel-group
  member, or any row whose drag is disabled (`!canReorder || isExecutionTargetLocked`),
  multi-drag is disabled and the handles on selected rows behave as single-row drags.
  Moving a block into or out of group containers multiplies the already delicate
  container logic (`resolvePendingDropTarget`, group straddle checks in
  `reorderParallelGroupPendingSteps`). It should come later, driven by a real need.
- After `REORDER_PROMPTS` is sent, remap `multiSelection.indices` through the
  permutation (§1). The existing `cancelEdit()` after a reorder
  (`WorkflowStepsPanel.tsx:~1733`) stays for the single-selection case.
- **Keyboard/tap alternative:** a bulk "Move Up"/"Move Down" in the bulk context
  menu. It shifts the whole block by one slot as a single permutation, which is cheap
  once the block-move helper exists. This also gives touch users (and the chip rail)
  a path later.

Keep the block-move and permutation logic as **pure functions in a util**
(e.g. `utils/stepMultiSelection.ts`). Both the drag path and the Move Up/Down path
call them, and they unit-test without dnd-kit.

### 6. Bulk property edit (prompt-only selections)

This is the largest piece, because the drawer is built around a _single_ draft
(`editorStore.properties`).

**Draft model:** a sparse patch, not a full `PropertyValues`:

```ts
// editorStore, alongside multiSelection
bulkPropertyPatch: Partial<PropertyValues>; // only keys the user touched
```

- **Display value per property** is derived, never stored:
  - the patch value if the key is in `bulkPropertyPatch`;
  - else the common value if every selected step has the same raw value (including
    "all inherit" = `undefined`);
  - else a **MIXED** sentinel. Controls render it as "(mixed)" or "Multiple values"
    and keep the inherit/none/override choices available.
- Writes go to `bulkPropertyPatch` instead of `properties`. The least invasive way is
  a store-level redirect: `setProperty` checks `multiSelection` and writes to the
  patch. The drawer and quick pickers then need only (a) the MIXED rendering and
  (b) reading the derived display value. Their write calls are unchanged. The
  alternative, passing a value/onChange adapter into every control, is cleaner but
  touches every picker.
- **Cascades must write every key they touch.** Changing harness writes `harness`,
  `model` and `additionalArgs` into the patch, as today's single-step cascade does.
- **Harness-dependent controls:** when the selected prompts' _effective_ harnesses
  differ and the patch doesn't set `harness`, the model and additional-args pickers
  have no single option list. Disable them with a hint: "Set a harness to change the
  model for all selected prompts." The same applies to any other harness-scoped
  control (skills, agents, tool permissions) whose option list comes from the
  harness. Audit each drawer page for this.
- **Update / Discard:** the editor footer's Update applies the patch to every selected
  prompt, and Cancel discards it. `isDirty` = patch is non-empty.
- **Properties not offered in bulk (v1):** `sessionId`/`resumeSession` (these are
  step-relative references and rarely correct to copy), `endCondition`/`preCondition`
  (complex nested editors; they could come later), and `name` (per-step identity).
  The drawer hides or disables those sections in bulk mode. Everything else in
  `PropertyValues` is fair game.

**Protocol:** new `UPDATE_PROMPTS` message:

```ts
export interface UpdatePromptsMessage {
  type: typeof MESSAGE_TYPES.UPDATE_PROMPTS;
  indices: number[];
  properties: Partial<PromptStep>; // keys to set
  clearProperties: string[]; // keys to reset to inherit
  mutation?: WorkflowDefinitionMutation;
}
```

No `text`. The host merges `properties`/`clearProperties` into each target step and
leaves `prompt` and `name` alone. Build `properties`/`clearProperties` from the patch
using the **same** helper `getPropertyValues` uses. Extract the tri-state →
`{properties, clearProperties}` mapping so single and bulk share it, rather than
reimplementing it.

**Host side:** `PromptQueue.updatePrompts(indices, changes)` validates all indices
(prompt steps only; mutability as in §4). It then applies `mergeWorkflowStepUpdate`
to each step without persisting per step, bumps the revision, writes the file and
emits once. Run-addressed: `WorkingFileManager.updateStepsAtRun`, reusing
`buildPromptStepChange` per index. There is one `STEPS_EXTENDED` broadcast, and so
one undo entry.

**Rejected alternative: merge on the client and post an `UNDO_REDO_SYNC`-style
whole-steps write.** `syncStepsForUndoRedo` already writes every step under one
revision, so the protocol side would come for free. But it is a whole-topology
replace built for restoring a known-good snapshot. It skips the per-index
`assertEditableDuringExecution` checks and the completed-step rewind classification
that `handleUpdatePrompt` does. It also races any concurrent host-side change to
steps outside the selection, because it would overwrite them with the client's copy.
A targeted `UPDATE_PROMPTS`/`DELETE_PROMPTS` keeps the server authoritative over
everything the user didn't select.

**Completed steps:** v1 **excludes completed steps from bulk property edit**. If the
selection contains any completed step, the drawer shows a notice and Update is
disabled, or completed rows cannot join a multi-selection at all. Editing a
completed step starts a pending continuation from _that_ step
(`updateCompletedPromptInQueue`). With N completed steps, the continuation would have
to start from the earliest one. That is solvable (rewind to `min(indices)`, then
apply), but it is a behavior users should explicitly opt into, and it isn't needed
for v1. Bulk delete of completed steps follows whatever the single-step delete allows
today; the host guards already reject the immutable ones.

### 7. Editor in bulk mode

- **Prompt-only selection:** `CodeMirrorEditor` gets `readOnly` and the placeholder
  `"N prompts selected — use the prompt properties drawer to change the properties
for all selected prompts"`. Its doc must be empty so the placeholder shows. Don't
  write into `promptText`; render the editor with a bulk-mode `value=""` and don't let
  that empty value leak into any step's draft or `pendingEdits`. The footer quick
  pickers and the drawer toggle stay enabled.
- **Mixed or script-only selection:** same read-only editor, with the placeholder
  `"N steps selected — only reorder and delete are available for mixed selections"`.
  Disable the drawer toggle and footer quick pickers. The script-step field editor
  (`ScriptConditionEditor`) is not rendered in bulk mode.
- Put the placeholder strings in `EDITOR_PLACEHOLDER_TEXT` (`DashboardConstants.ts:2217`)
  as functions of `N`, or as templates with a formatter, so they stay single-sourced.
- As noted above, move `placeholder` into a CodeMirror `Compartment` so entering and
  leaving bulk mode doesn't destroy the `EditorView`. Otherwise it would drop undo
  history and completions state for the next single-step edit. `readOnly` already
  toggles live.
- The footer's Update/Cancel stay enabled in prompt-only bulk mode (they commit or
  discard the patch). Run/Queue and the other single-step actions are disabled
  through the same flag path `isExternallyManaged` uses.

### 8. Hosted browser dashboard

There is nothing host-specific: selection is client-local, and the new messages go
through the same `WebviewMessageRouter` table for both hosts. Ctrl+Click in a
browser can open a context menu on macOS (Ctrl = right-click), so on Mac, toggle on
`metaKey` and not `ctrlKey`.

### 9. Touch

Shift and Ctrl don't exist on touch. v1 leaves touch single-select. A later "Select"
item in the long-press context menu could enter a sticky multi-select mode where
taps toggle. Record it as a follow-up; don't build it now.

### 10. Chip rail

`PromptChipRail` (the collapsed panel) keeps single selection in v1. It should render
multi-selected chips as selected for consistency, which is cheap once the selection
predicate exists. Modifier-clicks on chips can come later.

---

## Phasing

1. **Selection model and gestures.** `multiSelection` slice, modifier plumbing through
   the three row render sites, the collapse/invalidate rules, and row highlighting.
   No actions yet. This can ship on its own with no user-visible actions beyond
   highlighting, so it's best kept behind the next phase in the same release.
2. **Bulk delete.** `DELETE_PROMPTS` end to end (queue, instance, orchestrator,
   WorkingFileManager/RunContinuationService, handler, router), plus the bulk context
   menu, the Delete key, and the confirm modal.
3. **Editor bulk mode.** Read-only editor with placeholder text via `Compartment`, and
   drawer/footer enablement by selection kind.
4. **Bulk property edit.** Patch slice, MIXED display, the `setProperty` redirect,
   harness-dependent control gating, and `UPDATE_PROMPTS` end to end.
5. **Bulk reorder.** Block-move pure helpers, bulk Move Up/Down, then multi-drag in the
   live preview (no parallel groups).
6. **Follow-ups:** shared prompt text, bulk script-field edit, multi-drag into and out
   of parallel groups, touch select mode, bulk copy/paste, bulk edit of completed
   steps via one rewind.

Phases 2 and 4 each add a cross-layer message. Keep `WebviewMessageTypes.ts`,
`DashboardConstants.MESSAGE_TYPES`, the `sendMessage` mutation set, the router table
and `WorkflowStepHandlers` in sync (see `agentGuidance` in
`.github/copilot-instructions.md`).

## Testing

- **Pure helpers** (`utils/stepMultiSelection.ts`): range/toggle selection, skipping
  immutable rows, block-move permutation (contiguous and non-contiguous, block to
  start/end, no-op drop), index remap through a permutation.
- **`editorStore`:** entering multi-select saves the single-step draft to
  `pendingEdits`; collapsing to one restores it; the patch redirect in `setProperty`;
  MIXED derivation.
- **`WorkflowStepsPanel.test.tsx` / `WorkflowStepsPanelDrag.test.tsx`:** shift/ctrl
  click highlighting across all three render sites; the Delete key; the bulk context
  menu; multi-drag payload; the multi-drag-disabled fallback when a group member is
  selected. Add a re-render-count assertion that a shift+click doesn't re-render
  every row.
- **`useStepContextMenu.test.tsx`:** the bulk menu switch, collapse-on-right-click
  outside the selection, and the "delete N" modal.
- **`useMessageHandler.test.ts` / `workflowStore.temporal.test.ts`:** one bulk
  delete/update produces exactly one undo entry, and undo restores all N steps.
- **Extension (`src/test/promptQueue.test.ts`, `unit/WorkflowStepHandlers.test.ts`,
  `unit/ParallelGroupTopology.test.ts`, `unit/WorkingFileManager.test.ts`,
  `unit/RunContinuationService.test.ts`):** `deletePrompts`/`updatePrompts` are
  atomic, so a bad index rejects the whole batch with nothing written. Also cover:
  descending-order bookkeeping (`currentIndex`, `completedIndices`, `results`); the
  started-group two-member edge case evaluated against the final topology; exactly
  one revision bump; executed-step immutability on the run-addressed path; and
  script steps rejected by `updatePrompts`.
- **Smoke:** `test/smoke/dashboardMount.test.tsx` renders with a multi-selection
  present. New selectors are the classic place for an unstable-selector React #185
  crash.

## Open questions

1. Should rows that can't take part in bulk actions (executed/locked) be selectable at
   all? The plan above says no. The alternative lets them in and disables only the
   actions that don't apply, which is more discoverable but more complex.
2. When a bulk property update changes `harness`, should each step's model be reset to
   the new harness's default (the single-step behavior), or only if the step's
   current model is invalid for the new harness?
3. Mixed selections: the request limits them to reorder and delete. But
   `enabled` (Enable/Disable) and `color` are shared by both step kinds and already
   have context-menu or quick-picker entry points. A bulk "Disable N steps" and a
   bulk color are cheap via `UPDATE_PROMPTS` if the host accepts those two keys for
   script steps. Worth doing in v1, or leave for later?
4. Is "(mixed)" plus the existing inherit/none/override choices enough, or does the
   drawer need an explicit "leave unchanged" option per field? The patch model makes
   "untouched" the implicit default, so a "revert this field" affordance might be
   the only addition needed.

## Future: shared prompt text

The editor could become editable in prompt-only bulk mode. It would start empty (or
show the common text if all selected prompts are identical), and on Update the text
would join the patch as `text` in `UPDATE_PROMPTS`. The host side already merges per
step, so the protocol change is one optional field. The UX work is deciding what to
show when the texts differ and adding a confirm step ("replace the prompt text of N
steps?").
