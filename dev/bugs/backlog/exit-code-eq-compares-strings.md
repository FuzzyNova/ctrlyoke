# Exit-code `eq`/`ne` comparisons are string comparisons, contrary to the schema

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/ScriptComparison.ts` (`compareScriptOutput`)
- **Severity:** low

## Symptom

The schema's operator description says comparisons are numeric when `compareSource` is
`exitCode`. For `eq`/`ne` they are string comparisons, so any non-canonical number text gives the
wrong result. Reproduced with `npx tsx` against the real `compareScriptOutput`:

| Config | Exit code | Observed | Expected |
| --- | --- | --- | --- |
| `compareSource: exitCode, operator: eq, expected: "00"` | 0 | `passed: false` | `true` |
| `… eq, expected: "0.0"` | 0 | `passed: false` | `true` |
| `… eq, expected: "+1"` | 1 | `passed: false` | `true` |
| `… ne, expected: "01"` | 1 | `passed: true` | `false` |

A YAML number such as `expected: 1` works, because it normalizes to `"1"`.

## Steps to Reproduce

1. Write a script end condition with `compareSource: exitCode`, `operator: eq`,
   `expected: "00"`, and a script that exits 0.
2. The condition fails.

## Root Cause

`compareScriptOutput` (`ScriptComparison.ts:~216-229`) sends only `gte`/`gt`/`lte`/`lt` through
`compareNumeric`. `eq`/`ne` always do a trimmed string comparison against `String(exitCode)`.

## Suggested Fix

When `compareSource` is `exitCode` and the operator is `eq` or `ne`, compare numerically. Reuse
`compareNumeric`'s finite and non-empty guards, and fail with its existing message when `expected`
is not a number. Add unit tests for the table above.
