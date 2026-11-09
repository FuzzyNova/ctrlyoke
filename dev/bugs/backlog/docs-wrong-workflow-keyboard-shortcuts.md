# Commands reference and templates guide list wrong / non-firing dashboard shortcuts

- **Found:** 2026-11-09 by bug-hunt final step (claude-cli subagent, docs-vs-code sweep)
- **Area:** `docs/reference/commands.md` (~34-42), `docs/workflows/templates.md` (~29-30)
- **Severity:** low

## Symptom

`docs/reference/commands.md` says, "while the ctrlyoke dashboard view has focus":
New Workflow from Template = `Ctrl+Shift+T`, New Blank Workflow = `Ctrl+Shift+N`,
Select Prompt File = `Ctrl+Shift+L`, Queue Prompt File = `Ctrl+Shift+Q`.
`docs/workflows/templates.md` repeats `Ctrl+Shift+T` for the template picker.

In the dashboard, `useNewWorkflowKeyHandler` (`src/ui/webview-react/hooks/useNewWorkflowKeyHandler.ts:18-46`)
catches Ctrl/Cmd+N outside text inputs: `Ctrl+N` is a new blank workflow and `Ctrl+Shift+N` opens
the template picker — the opposite of what commands.md says for Shift+N, and what
`docs/guide/dashboard.md` (~259-260) correctly documents. The four `package.json`
`contributes.keybindings` (`when: focusedView == 'ctrlyoke.dashboard'`) are recorded as
non-functional in `dev/reference/KEYBOARD_SHORTCUTS.md` because focus is inside the webview.

## Steps to Reproduce

Compare the pages above with `useNewWorkflowKeyHandler` and `docs/guide/dashboard.md`.

## Root Cause

The commands table was written from `package.json` keybindings rather than the webview handler.

## Suggested Fix

In commands.md, show `Ctrl+N` / `Cmd+N` for New Blank Workflow and `Ctrl+Shift+N` /
`Cmd+Shift+N` for New Workflow from Template (dashboard focused, outside text inputs), and drop
the T/L/Q shortcuts. Change templates.md to `Ctrl+Shift+N` in the dashboard. Leave
`package.json` keybindings alone (a separate decision).
