# Quick Picker Improvements Plan

## Goal

Make the editor footer quick pickers useful for the two common property-editing scopes:

- **Prompt**: one-off overrides for the selected prompt.
- **Workflow**: defaults for the whole workflow, used by all prompts that inherit.

The quick pickers should stay compact in the footer, but the opened popup should clearly state what property is being edited and which scope the edit targets.

## UX Position

The concept is good, but only if the target scope is explicit inside the popup.

The current footer behavior makes sense for narrow, fast prompt overrides. The user problem is that workflow-level properties are often the more common operation: a workflow can run several prompts on one harness/session, then switch the whole workflow to another harness for the next block of prompts. For that usage, forcing every change through `WorkflowPropertiesPanel` makes the nearby quick pickers feel less useful than their placement suggests.

The risk is accidental broad edits. A quick picker in the prompt editor naturally feels local to the selected prompt, so workflow edits need visible framing:

- The popup title must name the property, for example `Harness`.
- A segmented target control must be visible near the title: `Prompt` / `Workflow`.
- The trigger label should indicate workflow-scope edits when possible, so the user can tell that a workflow value is active even when the selected prompt is inheriting.
- Changing the target should update the list semantics immediately. In workflow mode, there is no `Inherit` row because workflow values inherit only from global settings, not from the prompt.

## Decisions

### Target scope

Use a two-option segmented control in the popup title area:

- `Prompt`
- `Workflow`

Do not use a checkbox or toggle switch. A binary switch would be physically compact, but it makes the meaning less scannable and increases the chance that users edit the wrong scope.

### Default target

Open each picker in `Prompt` mode by default for v1.

Rationale: the quick pickers currently only edit prompt overrides, so this preserves muscle memory. A later enhancement can remember the last target per picker in `uiStore` if workflow editing becomes the dominant path.

### Inherit behavior

Prompt target:

- Show the existing `Inherit (...)` row.
- Selecting `Inherit` clears the prompt-level property.
- The inherited value resolves from workflow first, then global settings.

Workflow target:

- Hide the `Inherit` row.
- Include explicit values only.
- For properties that support an explicit none state, keep that row:
  - Agent: `None`
  - Skills: `None`
- Clearing a workflow override back to global settings should be a separate affordance, not another `Inherit` row. Use a small title-bar action such as `Use Global` or a reset icon with a tooltip.

### Title bar

Add title-bar support to `FooterQuickPicker`, not to every picker separately.

The shared shell should support:

- `heading`: display title, for example `Harness`, `Model`, `Agent`, `Skills`.
- `target`: current target scope.
- `onTargetChange`: callback for changing between prompt/workflow.
- optional `actions`: right-aligned small buttons such as reset-to-global.

This keeps sizing, border, and layout consistent across quick pickers.

### Show hidden placement

Move `Show hidden` to the bottom in inline/drop-up `CustomSelect` usage.

The current inline mode forces the hidden-options bar to the top because the footer popup opens upward. That is inconsistent with the non-inline select behavior and visually competes with the new title bar. The popup shell already constrains height, so the preferred structure should be:

1. title bar
2. scrollable options
3. `Show hidden` footer bar

If a future dropdown opens downward, the placement should still remain at the bottom for consistency.

## Affected Components

| Component | Planned role |
| --- | --- |
| `FooterQuickPicker.tsx` | Own popup title bar, target segmented control, and optional title actions. |
| `HarnessQuickPicker.tsx` | Support prompt/workflow targets and remove `Inherit` in workflow mode. |
| `ModelQuickPicker.tsx` | Same target behavior; model list depends on the effective harness for that target. |
| `AgentQuickPicker.tsx` | Same target behavior; keep explicit `None`. |
| `SkillsQuickPicker.tsx` | Same target behavior; keep explicit `None`/empty selection semantics. |
| `CustomSelect.tsx` | Move inline `Show hidden` bar to bottom and avoid special top-bar behavior. |
| `SkillsSelect.tsx` | Match title/footer popup layout if it has inline hidden controls of its own. |
| `WorkflowPropertiesPanel.tsx` | Extract reusable workflow-property update helper so quick pickers can preserve undo behavior. |

## Data and Undo Requirements

Prompt target writes use the existing `editorStore.setProperty()` path.

Workflow target writes must use the same workflow-property update behavior as `WorkflowPropertiesPanel`:

- update `settingsStore.workflowProperties`
- post `MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY` to the extension
- call `workflowStore.setUndoWorkflowProperties()` after the update so undo/redo tracks workflow-property edits correctly
- preserve dependent updates, for example changing harness should also update model and additional args consistently with the workflow panel

Avoid duplicating the workflow update algorithm inside every quick picker. Extract a small shared hook, for example:

```typescript
useWorkflowPropertyUpdater()
```

It should expose targeted helpers like:

- `updateWorkflowProperties(updates)`
- `setWorkflowHarness(harness)`
- `setWorkflowModel(model)`
- `setWorkflowAgent(agent)`
- `setWorkflowSkills(skills)`

## Trigger Label Rules

The footer trigger should keep showing the effective value, but its active styling needs to distinguish prompt overrides from workflow values.

Recommended v1:

- Prompt override: active accent styling, same as today.
- No prompt override but workflow override exists: subtler active styling or a compact `W` badge.
- Pure global inherited value: dimmed/default styling.

This avoids making inherited workflow configuration look like an accidental prompt override.

## Implementation Steps

1. **Refactor workflow updates**
   - Extract a shared webview hook/utility from `WorkflowPropertiesPanel` for workflow-property updates and undo synchronization.
   - Update `WorkflowPropertiesPanel` to use it.

2. **Add quick picker title shell**
   - Extend `FooterQuickPicker` with `heading`, optional target control, and optional title actions.
   - Keep current props backward-compatible while migrating each picker.

3. **Normalize hidden-option footer placement**
   - Update `CustomSelect` inline mode so `Show hidden` renders at the bottom.
   - Remove picker-level workarounds that only exist to compensate for top placement.

4. **Implement target-aware harness picker**
   - Add `Prompt`/`Workflow` target state.
   - Use prompt update path in prompt mode.
   - Use workflow update path in workflow mode.
   - Hide `Inherit` in workflow mode.
   - Preserve harness-dependent model/additional-args reset behavior.

5. **Implement target-aware model, agent, and skills pickers**
   - Apply the same shell and target behavior.
   - Ensure model options resolve against the right harness for the selected target.
   - Keep explicit `None` semantics for agent and skills.

6. **Add tests**
   - `CustomSelect` inline mode renders `Show hidden` at the bottom.
   - `FooterQuickPicker` renders title and target selector.
   - Each quick picker writes to prompt properties in prompt mode.
   - Each quick picker writes to workflow properties and syncs undo state in workflow mode.

## Non-Goals

- Editing global settings from quick pickers.
- Adding target controls to every footer picker immediately if a picker has complex behavior not covered here.
- Replacing the full workflow and prompt property drawers. Quick pickers remain fast-access controls, not complete configuration panels.
- Remembering the last target per picker in v1.

## Open Questions

- Should workflow target be disabled when no workflow file is loaded, or should it still update the in-memory workflow defaults for a new unsaved workflow?
- Should the quick picker target default to `Workflow` when the selected prompt has no prompt override but the workflow already has an override?
- Is a `W` badge enough for workflow-level active styling, or should the trigger title include `Workflow Harness: ...` for better accessibility?
