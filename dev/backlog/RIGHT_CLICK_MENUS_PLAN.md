# Right Click Menus Plan

## Goal

Implement the new queued-step context menu behavior around `StepContextMenu`, with two larger feature tracks:

1. full-step copy/paste, including `Ctrl+C` / `Ctrl+V` when the steps panel is focused
2. first-class step enable/disable, wired through schema, runtime, dashboard state, and tests

This plan is the shared source of truth for the follow-up workflow prompts appended to the
`right click menus` queue.

---

## Decisions

### Step enabled flag

- Use `enabled?: boolean`, not `disabled?: boolean`.
- Omitted means enabled, which preserves current behavior and keeps saved YAML/JSON concise.
- `enabled: false` is explicit, easy to read in YAML, and matches positive-checkbox UI semantics.
- The field belongs on both prompt and script steps via the shared step schema shape, and should
  also be accepted on `finalStep` because it reuses the same `workflowStep` union.

### Runtime semantics for disabled steps

- Disabled steps remain in the workflow, stay reorderable when reordering is otherwise allowed,
  and keep their step numbers.
- Disabled steps must never execute AI, scripts, pre-conditions, or end conditions.
- During execution, disabled queue steps should auto-advance as skipped with a clear reason in logs
  and status messaging.
- A disabled `finalStep` should be treated as present but non-executing, not silently deleted.
- Copying a step includes `enabled: false` when present.
- Pasting a step must never copy `_runtime`, `status`, retry state, or any other view/runtime-only
  fields.

### UI placement for enable/disable

- Put the primary toggle in `EditorSection`, because enabled/disabled is core step state, not an
  advanced inherited execution property.
- Keep the context-menu `Enable` / `Disable` action as the fast row-level affordance.
- Do not add this to `PropertiesDrawer` in v1 unless implementation simplicity strongly depends on
  reusing existing drawer plumbing.

### Disabled-step presentation

- Use the existing `StatusIcon disabled` path for the leading icon.
- Keep the stored step status logic intact; the disabled visual state should key off `enabled === false`,
  not off a synthetic replacement status.
- Add a compact `Disabled` badge/chip in the step row so the state is visible even before a run.
- Dim the step row/body text slightly more than a normal pending step, but keep it readable.

### Clipboard contract for full-step copy/paste

- Full-step copy uses plain JSON text in canonical schema shape, not a custom prefix wrapper.
- The copied object should be the persistable step payload only:
  - include step fields like `type`, `name`, `prompt`/`script`, `enabled`, and all normal
    prompt/script properties
  - exclude `_runtime`, transient `status`, output, retry, and UI-only metadata
- `Copy Prompt` / `Copy Script` copies only the raw `prompt` or `script` string.
- Paste validates the clipboard text by JSON parsing plus step-shape checks before enabling insert.

### Keyboard shortcut scope

- `Ctrl+C` and `Ctrl+V` are only handled when the `WorkflowStepsPanel` listbox has focus or a step row
  inside it has focus.
- Do not intercept when the target is an input, textarea, or contenteditable element.
- `Ctrl+C` copies the currently selected queue step.
- `Ctrl+V` pastes after the currently selected queue step.
- If there is no selected queue step, the shortcut is a no-op.

### Mutation guards

- Copy actions remain available in read-only/running states.
- Paste, enable/disable, delete, and set-start-position follow existing mutation restrictions:
  disabled when CLI-managed, and disabled whenever runtime rules already block equivalent queue edits.

---

## Work Breakdown

### Prompt 1: enabled plumbing

- Add `enabled` to schema, core types, parser, queue serialization, working-file updates, and any
  prompt/final-step normalization helpers.
- Ensure disabled steps survive load/save/update/reorder/set-start-position flows without losing the flag.
- Update execution so disabled queue/final steps are skipped without running step logic.
- Add focused core tests for parsing and executor behavior.

### Prompt 2: clipboard/paste plumbing

- Add a clean insert/paste path for a fully formed copied step after an arbitrary queue index.
- Reuse existing queue/update infrastructure where possible, but avoid abusing prompt-text-only APIs
  if that causes shape loss for script steps or `enabled`.
- Add shared step sanitization helpers for copy/paste payloads.
- Add extension/webview message types only if the existing execute/queue messages cannot carry this cleanly.

### Prompt 3: step-panel context menu and keyboard UX

- Expand `StepContextMenu` to support solid dividers.
- Add `Copy Step`, `Copy Prompt` / `Copy Script`, `Paste Step`, `Enable` / `Disable`, and preserve
  `Copy Output`, `Set Start Position`, and `Delete`.
- Wire `WorkflowStepsPanel` keyboard handling for `Ctrl+C` / `Ctrl+V` using the selection model that
  already drives editor editing.
- Keep context-menu labels step-type aware and mutation-state aware.

### Prompt 4: disabled-step editor/list UI

- Surface the enabled/disabled toggle in `EditorSection`.
- Reflect disabled state in the step list, selected-step editing state, and any relevant final-step UI.
- Ensure updating an edited step preserves `enabled`.
- Add webview tests for menu state, keyboard behavior where practical, and editor/list rendering.

### Prompt 5: verification and cleanup

- Run targeted tests for changed areas.
- Fix regressions from prompt interactions between queue editing, runtime skipping, and clipboard paste.
- Verify the final menu order exactly matches the requested spec.

---

## Final Menu Shape

1. `Copy Step` (`Ctrl+C`)
2. `Copy Prompt` or `Copy Script`
3. `Copy Output`
4. `Paste Step` (`Ctrl+V`)
5. divider
6. `Enable` or `Disable`
7. `Set Start Position`
8. divider
9. `Delete`
