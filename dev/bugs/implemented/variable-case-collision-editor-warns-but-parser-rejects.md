# The vars editor only warns about names that differ by case, but the parser rejects the file

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude, helper agent)
- **Area:** `src/utils/KeyValueKeyKinds.ts` (`validateKeyValueKey` VARIABLE case ~L115-119, compared with `getVariableKeyErrors` ~L28-30)
- **Resolution:** fixed in this commit

## Symptom

In the variables editor, adding `region` and `REGION` shows only a warning ("Another variable
name differs only by case."), so the user can save. The saved workflow then fails to load:
`PromptFileParser` throws `Validation failed: vars: Variable names must not differ only by case`.

## Steps to Reproduce

Verified with tsx probes:

1. `validateKeyValueKey(KEY_VALUE_KEY_KINDS.VARIABLE, "region", ["region", "REGION"])` →
   diagnostic with `severity: "warning"`.
2. `getVariableKeyErrors(["region", "REGION"])` → one error. `PromptFileParser.ts` (~L272)
   turns it into a load failure.

## Root Cause

Commit `ff510898` tightened the parser (`getVariableKeyErrors`) to reject case collisions but
left the editor diagnostic as a `warning`. Each side has a test locking in its own behavior
(`src/test/unit/KeyValueKeyKinds.test.ts`, `WorkflowSchema.test.ts`).

## Suggested Fix

Make the VARIABLE case-collision diagnostic an `error`, so the editor blocks the save, and reuse
the same message as `getVariableKeyErrors` so there's one source of wording. Update
`KeyValueKeyKinds.test.ts` and the React `KeyValueRowsEditor.test.tsx` expectation.
