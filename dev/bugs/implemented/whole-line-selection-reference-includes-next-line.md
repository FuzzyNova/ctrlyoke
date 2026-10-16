# Whole-line selections produce `#selection:` references one line too long

- **Found:** 2026-10-15 by claude-cli bug-hunt final step (traced through the code)
- **Area:** `src/platform/VsCodeEditorContextSource.ts`, `src/completions/ContextMenuReferenceCommands.ts`, `src/ui/webview-react/components/workspace-viewer/WorkspaceFileEditor.tsx`
- **Resolution:** fixed in this commit

## Symptom

Select line 10 with a triple-click or `Ctrl+L`, then type `#` in a prompt (or
use the "add selection to prompt" context-menu command). The inserted token is
`#selection:file:10-11` and the detail says "Lines 10-11", although only line
10 was selected. At run time `ContextExpander` slices the range inclusively,
so the unselected line 11 is attached. Selecting lines 10–12 with
`Shift+Down` likewise yields `10-13`.

## Steps to Reproduce

1. In VS Code, put the cursor on line 10 and press `Ctrl+L`.
2. Type `#` in a ctrlyoke prompt and accept the selection completion.
3. Observe `#selection:<file>:10-11`.

## Root Cause

VS Code reports a whole-line selection's end as column 0 of the **next** line.
Each site converts the end position with a plain `end.line + 1`:

- `VsCodeEditorContextSource.ts` around line 38 (feeds `#` completions in VS
  Code and the dashboard);
- `ContextMenuReferenceCommands.ts` around lines 108-109 and 213;
- `WorkspaceFileEditor.tsx` around lines 351-352 (`doc.lineAt(to).number`,
  the CodeMirror equivalent).

## Suggested Fix

Add one shared helper that returns the 1-based inclusive end line, using
`end.line` (not `end.line + 1`) when `end.character === 0 && end.line > start.line`,
and use it at every site (with the CodeMirror equivalent: step back one line
when `to` is at a line start and after `from`). Add unit tests for the helper
and the call sites.
