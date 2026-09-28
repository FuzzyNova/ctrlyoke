# A script step's `shell:` is silently dropped when the workflow is loaded

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/PromptFileParser.ts`, `src/core/WorkflowStepSanitizer.ts`
- **Severity:** high

## Symptom

The schema allows `shell` on a script step, and the executor passes `step.shell` through to the
script runner. However, the value never survives parsing, so script steps always run under the
platform default shell:

- `{type: script, shell: bash, script: 'echo "ps=$($PSVersionTable.PSVersion)"'}` prints
  `ps=7.x` on Windows, which means it ran under PowerShell.
- `shell: cmd` with `echo %OS%` prints `%OS%` literally.
- The run's saved `workflow.ctrlyoke.json` has no `shell` field, and the dry-run preview shows the
  wrong shell because it reads the same parsed step.

`dev/bugs/implemented/condition-shell-override-ignored.md` says "Script steps do honour shell",
which is not true.

## Steps to Reproduce

1. On Windows, create a workflow with the single step
   `{type: script, shell: cmd, script: "echo %OS%"}`.
2. `node out/cli.js run wf.ctrlyoke.yaml --headless`
3. The output is `%OS%` (PowerShell) instead of `Windows_NT`.

## Root Cause

`PromptFileParser.buildScriptStep` (around line 667) copies every script field except `shell`.
The clipboard clone helpers in `WorkflowStepSanitizer.ts` (`cloneEndCondition`,
`clonePreCondition`, and the script branch of `sanitizeClipboardWorkflowStep`) omit `shell` too,
so copy and paste also loses it.

## Suggested Fix

Copy `shell` in `buildScriptStep` and in the three sanitizer clones. Preferably, derive the copied
field list from one shared list of script-step fields so the next new field cannot be missed in one
place. Add a parser test for `shell` round-tripping, and a sanitizer test.
