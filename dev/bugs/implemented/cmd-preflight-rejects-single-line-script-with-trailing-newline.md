# cmd preflight rejects a single-line script that ends with a newline (YAML `|` block)

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced with a tsx probe
- **Area:** `src/utils/ShellCatalog.ts` (`MULTILINE_SCRIPT_NEWLINE`, `getShellInvocationError`)
- **Resolution:** fixed in this commit

## Symptom

A script step or script end condition that runs under cmd and is written as a
YAML block scalar fails with "Multi-line scripts cannot run under cmd…", although
it has only one line:

```yaml
- type: script
  shell: cmd
  script: |
    echo hello from cmd
```

YAML's `|` keeps the trailing newline, so `script` is `"echo hello from cmd\n"`.
The parser keeps that text verbatim (`PromptFileParser.buildScriptStep`).

- PTY script steps (`WorkflowInstance.spawnScriptPty`, ~3573) fail with exit code 1.
- Script end conditions (`EndConditionEvaluator`, ~274) throw.
- `ScriptConditionEditor.tsx` (~393) shows the error in the editor.

Running the same string through `cmd.exe /d /s /c` works fine.

## Root Cause

`MULTILINE_SCRIPT_NEWLINE = /\r\n?|\n/` (`ShellCatalog.ts` ~176) matches any
newline, including a trailing one. `EndConditionEvaluator.isMultilineInlineScript`
already uses the right rule: a script is multi-line only if a line *after the
first* has non-whitespace content. The shared preflight doesn't use it.

## Suggested Fix

Single-source the "meaningful newline" rule in `ShellCatalog.ts`. Use it in
`getShellInvocationError`, and have `EndConditionEvaluator.isMultilineInlineScript`
delegate to it. Add unit tests for a trailing `\n`/`\r\n` (accepted under cmd)
and a real second line (still rejected).
