# A higher settings scope cannot replace an object-valued setting with a scalar or a different object variant

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/config/CtrlYokeConfigService.ts` (`deepMerge`)
- **Resolution:** fixed in this commit

## Symptom

`getAll()` merges defaults → user → workspace → CLI overlay through
`deepMerge`. Once a lower scope has stored an **object** for a setting, a
higher scope can no longer override it with a schema-valid non-object value,
and two different object variants get key-merged into an invalid hybrid.
`resolve("defaults").source` still reports `workspace`, so the UI claims the
workspace value is in effect when it is not.

Affected union-valued settings: `defaults.worktree`
(`false | true | string | {mode:"managed",…} | {mode:"named",branch,…}`) and
`defaults.priorContext` (keyword string | number array | `{previous:n}`).

| user                                              | workspace                               | effective                                                    | expected                      |
| ------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ | ----------------------------- |
| `worktree: {mode:"managed",merge:true}`           | `worktree: false`                       | `{mode:"managed",merge:true}`                                | `false`                       |
| `worktree: {mode:"managed"}`                      | `worktree: "feature-x"`                 | `{mode:"managed"}`                                           | `"feature-x"`                 |
| `worktree: {mode:"managed",merge:true,keep:true}` | `worktree: {mode:"named",branch:"dev"}` | `{mode:"named",merge:true,keep:true,branch:"dev"}` (invalid) | `{mode:"named",branch:"dev"}` |
| `priorContext: {previous:2}`                      | `priorContext: "none"`                  | `{previous:2}`                                               | `"none"`                      |
| `priorContext: {previous:2}`                      | `priorContext: [1,3]`                   | `{previous:2}`                                               | `[1,3]`                       |

Impact: a repository that commits `"worktree": false` still runs every
workflow in a managed worktree (and with `merge: true`, merges into the
source checkout) for any user whose global settings use the object form.

## Steps to Reproduce

1. Construct `CtrlYokeConfigService` with stub user/workspace backends holding
   the values from any row above.
2. Read `getAll().defaults.worktree` / `getAll().defaults.priorContext`.
3. The user value (or a key-merged hybrid) is returned instead of the
   workspace value.

## Root Cause

`deepMerge` (around lines 181-225) skips a source value when
`isPlainObject(targetVal) && !isPlainObject(sourceVal)`. The guard exists so a
malformed scalar cannot replace an **object default** (test "malformed object
sections cannot replace object defaults" in
`src/test/unit/CtrlYokeConfigService.test.ts`), but it inspects `targetVal`
— the value merged so far, which may come from the user scope — instead of
the schema default. And when both sides are objects it always recurses, even
for union leaves whose object variants are mutually exclusive.

## Suggested Fix

Decide "settings section vs. replaceable leaf" from the schema, not from the
runtime value: only recurse/guard when the setting's schema default
(`getSettingDefault(settingPath)`) is a plain object (a real settings
section). Union-valued leaves (`worktreeConfig`, the priorContext forms) must
be replaced wholesale by the higher scope. Keep the existing malformed-section
test passing and add a test for each row of the table.
