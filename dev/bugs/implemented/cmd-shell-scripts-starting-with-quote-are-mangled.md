# `shell: cmd` scripts that start with a quoted token are mangled (missing `/s` and outer quotes)

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), reproduced with `ctrlyoke run`
- **Area:** `src/core/harness/PtyProcessManager.ts` (`buildShellWrapArgs`, `SHELL_KINDS.CMD` case ~131)
- **Resolution:** fixed in this commit

## Symptom

```yaml
steps:
  - type: script
    shell: cmd
    script: '"node" -e "process.exit(7)"'
    compareSource: exitCode
    expected: 7
```

`ctrlyoke run` output:

```
'node" -e "process.exit' is not recognized as an internal or external command,
✖ Failed — ... Actual: 1
```

Any cmd script whose first character is `"` (the normal way to invoke a program under
`C:\Program Files\...`) and that contains another quote is affected.

## Steps to Reproduce

Run the workflow above on Windows. Expected exit code 7; observed 1 with the error above.

## Root Cause

`buildShellWrapArgs` returns `["/d", "/c", script]` (spawned verbatim). Without `/s` and
an outer pair of quotes, cmd's legacy rule strips the first and last `"` of the command
line. The plan (`SCRIPT_STEP_SHELL_OVERRIDE_PLAN.md`) specifies `/d /s /c`, and
`src/core/harness/shared/WindowsCmdEscaping.ts` already builds cmd lines that way.

## Suggested Fix

Return `["/d", "/s", "/c", `"${script}"`]` for cmd (reusing the `WindowsCmdEscaping`
helper if it fits), keeping verbatim arguments. Check the headless and PTY paths both go
through it. Tests: `buildShellWrapArgs` output, plus a Windows-only spawn test for the
YAML above (exit 7) and for a script that doesn't start with a quote (`echo "a" & exit /b
3`) to confirm no regression.
