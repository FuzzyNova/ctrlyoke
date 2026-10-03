# On Windows, the "Shell Script" sample is batch content saved as a .sh file and fails under bash

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli); reproduced by running the template content under Git Bash
- **Area:** `src/core/EndConditionEvaluator.ts` (`createSampleScript`), `src/ui/webview-react/components/shared/CreateScriptModal.tsx`
- **Severity:** medium (the generated sample condition always fails on Windows)

## Symptom

On Windows, choosing **Shell Script** in the "Create New Script" modal creates
`.ctrlyoke/scripts/check_condition.sh` whose content is `check_condition.bat`
(`@echo off`, `REM ...`). ctrlyoke runs `.sh` files with `bash` on Windows, so the
"always succeed" demo script fails:

```
./check_condition.sh: line 1: @echo: command not found
./check_condition.sh: line 2: REM: command not found
...
./check_condition.sh: line 6: syntax error near unexpected token `('
exit=2
```

An end condition that uses the freshly created sample therefore fails and retries
instead of passing, and the batch-syntax example misleads the user about what
language to write.

## Steps to Reproduce

1. On Windows, open a step's end condition and click "New script".
2. Choose "Shell Script" and keep the default name `check_condition.sh`. The modal always sends that name; see `SCRIPT_TYPE_DEFAULT_NAMES`.
3. Inspect the created file: it is the `.bat` template.
4. Run the step: bash exits 2 on the batch syntax, so the end condition fails.

## Root Cause

`createSampleScript` (~1022-1028) picks `check_condition.bat` as the template on
`win32`, but the destination name comes from the modal (`check_condition.sh`, or
whatever the user typed). The template therefore no longer matches the file
extension that decides the interpreter. The `.sh` dispatch runs `bash` on Windows
(see the shebang comment ~730-735).

## Suggested Fix

Choose the template from the destination file's extension, not the platform:
`.bat`/`.cmd` gets `check_condition.bat`, and any other name for the shell type
gets `check_condition.sh`. That keeps a Windows user who explicitly types
`foo.bat` working while the default `.sh` gets bash content. Add a unit test
covering both names, independent of `process.platform`.
