# Condition `.cmd`/`.bat` script files break on a spaced path with quoted arguments or an `&` in the path

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced on Windows with `ctrlyoke run` on a script-only workflow)
- **Area:** `src/core/EndConditionEvaluator.ts` (`getScriptCommand`, CMD interpreter; file-dispatch branch of the evaluator)
- **Severity:** medium

## Symptom

A pre- or end-condition (or script step) that runs a `.cmd`/`.bat` file through
file dispatch fails on Windows when:

- the path contains a space and an argument is quoted:
  `script: '"sub dir/chk.cmd" "hello world" two'` prints
  `'...\ws\sub' is not recognized as an internal or external command`, exit 1.
  Expected: the script runs with arg1 = `hello world`.
- the path contains a cmd metacharacter: `script: '"r&d/chk.cmd"'` fails the
  same way.

These work: no arguments, unquoted arguments, or a quoted argument when the
path has no space.

## Steps to Reproduce

1. In a scratch workspace, create `sub dir/chk.cmd` containing `@echo arg1=%~1`.
2. Run a script-only workflow whose end condition has
   `script: '"sub dir/chk.cmd" "hello world" two'`.
3. The condition errors with "is not recognized".

## Root Cause

`src/core/EndConditionEvaluator.ts` (~675-678) maps the CMD interpreter to
`{ executable: "cmd", args: ["/c", scriptPath] }`. The evaluator then appends
the extra arguments (~258). There is no `/s`, no outer quote pair and no
`windowsVerbatimArguments`, so Node quotes each argv element and cmd's
quote-stripping rule (more than two quotes with `/c` but without `/s` → strip
the first and last quote) breaks the command line. Unescaped `&`, `^`, `|`
etc. in the path are interpreted by cmd. The fixed
`dev/bugs/implemented/cmd-shell-scripts-starting-with-quote-are-mangled.md`
covered only the inline-shell path, not file dispatch.

## Suggested Fix

For the CMD interpreter, build the argv with the existing
`buildCmdExeVerbatimArgs(resolvedPath, additionalArgs)` from
`src/core/harness/shared/WindowsCmdEscaping.ts` and set
`windowsVerbatimArguments: true`. The additional arguments must go through
that builder rather than being appended afterwards, so the evaluator's
"append additionalArgs" step has to let the interpreter own its arguments for
CMD. Tests in `src/test/endConditionEvaluator.test.ts` (Windows-only): a
spaced path with a quoted argument, and a directory containing `&`.
