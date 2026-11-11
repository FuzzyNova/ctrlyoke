# Undo/Redo Ignores No-Turn-Started Status

- **Found:** 2026-11-10 by smell hunt
- **Area:** `src/ui/webview-react/`
- **Resolution:** fixed in this commit

## Symptom

After undo or redo, a step whose harness never started a turn could lose its
`No turn started` status or remain the current step even though it had ended.

## Steps to Reproduce

1. Run a workflow where a step is rejected before the harness starts a turn.
2. Undo or redo a workflow edit.
3. Observe that the step may lose its terminal status or current-step position.

## Root Cause

The dashboard's undo/redo status checks had copied the terminal status list
before `NO_TURN_STARTED` was added. The runtime status derivation already
produced `NO_TURN_STARTED`, but the copied predicates rejected it, so runtime
merging and current-step derivation treated an ended step as pending.

## Resolution

Terminal status checks now use the shared `isTerminalStepStatus` guard backed
by `PROMPT_TERMINAL_STATUS`. `NO_TURN_STARTED` can carry `_runtime` metadata,
so it is included in the terminal check used to select runtime harness/model
values in `WorkflowStepsPanel`.
