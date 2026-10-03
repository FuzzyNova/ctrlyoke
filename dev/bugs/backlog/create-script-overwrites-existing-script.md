# Create Script silently overwrites an existing script in .ctrlyoke/scripts

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), code reading
- **Area:** `src/core/EndConditionEvaluator.ts` (`createSampleScript`), `src/ui/webview-react/components/shared/CreateScriptModal.tsx`, `src/ui/WebviewMessageRouter.ts`
- **Severity:** medium (silent data loss of user-authored scripts)

## Symptom

The dashboard's "Create New Script" modal (used by the end-condition / precondition
script editors) pre-fills the default name `check_condition.<ext>`. If a file with
that name already exists in `.ctrlyoke/scripts/`, for example the user's edited
script from an earlier step, clicking **Create Script** replaces its contents with
the sample template. There's no warning or confirmation, and the dashboard reports
success.

## Steps to Reproduce

1. In any step's end condition, click "New script" and create the default `check_condition.py`.
2. Edit `.ctrlyoke/scripts/check_condition.py` with real logic and save.
3. In another step (or the same one), click "New script" again and accept the default name.
4. `.ctrlyoke/scripts/check_condition.py` is now the demo template again, and the user's logic is gone.

## Root Cause

`EndConditionEvaluator.createSampleScript` (~1061-1066) writes the template with a
plain `fs.promises.writeFile(destinationPath, templateContent)`, which truncates any
existing file. Neither the modal nor `WebviewMessageRouter` (~914) checks whether
the destination exists.

## Suggested Fix

Write with the exclusive flag (`{ flag: "wx" }`). On `EEXIST`, throw a clear
error such as `A script named "<name>" already exists in .ctrlyoke/scripts. Choose
another name.`. The existing `END_CONDITION_SCRIPT_CREATION_FAILED` path already
surfaces errors to the modal. Add a Mocha test that creates a script twice under
the same name and asserts that the second call rejects and the first file's
content is unchanged.
