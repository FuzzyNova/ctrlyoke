# Categorized temp prompt files collide across concurrent runs of the same workflow

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli), by code reading
- **Area:** `src/utils/TempFileManager.ts` (`getCategoryFilePath` ~96), `src/core/harness/shared/CliPromptPreparer.ts` (~616-622, ~650, ~803)
- **Resolution:** fixed in this commit

## Symptom

When a prompt is delivered through categorized temp files, each file is named
`<unix-seconds>-<sanitized workflowName>-<stepNumber>.<category>[.<part>].md` under the
workspace's `.ctrlyoke/temp/`. Nothing in that name is unique to the run. Two runs of
the same workflow that reach the same step in the same second get the same path:

- The second write overwrites the first, so run A's harness can read run B's prompt
  (with B's `--var` values, prior-context, secrets placeholders, and so on).
- Temp files are deleted as soon as the turn that consumed them completes, so whichever
  run finishes first deletes the file the other harness may still need to read. That
  step then runs without its prompt, or fails to find it.

`sanitizeBasename` also folds different names together (`fix_bug` and `fix-bug`,
`a/fix.ctrlyoke.yaml` and `b/fix.ctrlyoke.yaml`), which widens the collision to
different workflows with similar names.

## Steps to Reproduce

1. In one workspace, start two runs of one workflow at once, for example from a script:
   `ctrlyoke run review.ctrlyoke.yaml --var file=a.ts & ctrlyoke run review.ctrlyoke.yaml --var file=b.ts`
   (or start two lineages of the same workflow from the dashboard within a second).
2. Use a prompt large enough (or with attachments/excerpts) to be delivered via temp
   files.
3. Both runs plan `.ctrlyoke/temp/<same-second>-review-1.prompt.md`. The later write wins
   for both, and the first run to finish its turn deletes the file.

## Root Cause

`CliPromptPreparer` computes one second-resolution timestamp per plan and passes the
workflow name and step number to `TempFileManager.getCategoryFilePath`; the name has no
run- or process-unique component.

## Suggested Fix

Add a unique component to categorized temp filenames, generated once per plan so every
planned path stays byte-identical to what `apply()` writes (e.g. a short random suffix
from `crypto.randomBytes`, or the run's `runRef`/executionInstanceId plus pid). Keep the
`.md` suffix so the orphan sweep still matches. Consider writing with the exclusive `wx`
flag so an unexpected collision fails loudly instead of overwriting. Unit test: two plans
for the same workflow name, step and timestamp yield different paths.
