# Dashboard editor drops end conditions that have no `returns`

- **Found:** 2026-11-08 by the user, editing the bug-hunt workflow's final step
- **Area:** `src/ui/webview-react/utils/promptPropertyValues.ts`
- **Resolution:** fixed in this commit

## Symptom

Saving a step or final step from the dashboard editor removes its end condition.
An operator condition such as `git status --porcelain` with `compareSource: stdout`
and `operator: isEmpty` disappears from the working file on save. An end
condition the step already had is also wiped whenever any other property of the
step is edited and saved. The edit is not blocked; the save sends
`endCondition: null` (None).

## Steps to Reproduce

1. Give a step or final step an end condition with a script and an `operator`
   (or one that just passes on exit code 0).
2. Edit the step in the dashboard editor and save.
3. The working file has no `endCondition`, and the condition never runs.

## Root Cause

`buildPropertyUpdateValues` turned any end condition without a non-empty
`returns` into `null`. `returns` was removed from the schema (`returns: not: {}`,
renamed to `expected`), so no valid end condition can have it. The webview also
kept two stale `EndConditionConfig` types that still declared `returns` and left
out `operator`/`expected`/`ignoreCase`. `END_CONDITION_DEFAULTS` seeded every new
custom end condition with `returns: ""`, which the schema rejects.

## Fix

The builder now keeps any end condition with a script. `script` is the only
field the schema requires. Both `EndConditionConfig` types are now aliases of the
core `EndCondition`, the default no longer seeds `returns`, and
`test/utils/promptPropertyValues.test.ts` checks the editor's save payload
against `schemas/workflow-schema.json`.
