# A condition script found by the documented lookup is lost when its arguments contain shell syntax

- **Found:** 2026-10-10 by claude-cli bug-hunt final step (reproduced with `ctrlyoke run` on a script-only workflow)
- **Area:** `src/core/EndConditionEvaluator.ts` (shell-fallback branch, ~232-275)
- **Severity:** low

## Symptom

Put `.ctrlyoke/gate.cmd` in the workspace (one of the documented script
lookup locations):

- `script: gate.cmd` resolves the file, runs it and prints `GATE-RAN`.
- `script: gate.cmd && echo SECOND` fails with
  `The term 'gate.cmd' is not recognized`, exit 1.

The same happens for files found through `~/.ctrlyoke/scripts/` or the
workspace root when it differs from the execution directory. Also, the file
is run through the shell's file association instead of the interpreter
ctrlyoke picks from its extension. For example, `check.js | …` goes to
Windows Script Host instead of `node`. That part is certain from the code but
was not run.

## Steps to Reproduce

1. Create `.ctrlyoke/gate.cmd` with `@echo GATE-RAN`.
2. Run a script-only workflow with end condition `script: gate.cmd && echo SECOND`.
3. The condition errors with "not recognized".

## Root Cause

`EndConditionEvaluator` resolves `resolvedScriptPath` and then, if the
remaining arguments contain shell syntax, takes the shell branch, which runs
the untouched `condition.script` text. Both the resolved absolute path and
the extension-chosen interpreter are discarded, so the shell looks the first
token up relative to the execution directory and `PATH` only.

## Suggested Fix

In the shell branch, when `resolvedScriptPath` is set, replace the first
token of the command with the interpreter command for the resolved file
(e.g. `node "C:\…\check.js"`, or the quoted path for `.cmd`/`.ps1`), quoted
for the resolved target shell. Keep the rest of the text unchanged so pipes
and `&&` keep their shell meaning. Quote with the existing shell-quoting
helpers for each `shellKind`. Test in `src/test/endConditionEvaluator.test.ts`.
