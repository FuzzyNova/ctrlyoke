# `$endCondition:<field>` followed by a comma or hyphen is silently left unsubstituted

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/FileReferenceParser.ts` (`parseConditionOutputRefs`), `src/core/ConditionOutputRefs.ts`
- **Severity:** medium

## Symptom

In a retry prompt, a condition-output placeholder immediately followed by `,` or `-` is not
replaced. The harness receives the literal token, and no diagnostic is raised.

Reproduced with `npx tsx` against the real `substituteConditionOutputRefs` and the condition output
`{ stdout: "3 failing", stderr: "boom", actual: "1", expected: "0", exitCode: 1, compareSource: "exitCode" }`:

| Input | Observed | Expected |
| --- | --- | --- |
| `Got exit $endCondition:exitCode, expected $endCondition:expected, fix it` | unchanged, `unresolved: []` | `Got exit 1, expected 0, fix it` |
| `stderr was $endCondition:stderr-please fix` | unchanged | `stderr was boom-please fix` |
| `Tests failed: $endCondition:stdout. Fix them.` | substituted | substituted (control) |

## Steps to Reproduce

1. Write an end condition with `onFail: retry` and a `retryPrompt` of
   `Got exit $endCondition:exitCode, expected $endCondition:expected, fix it`.
2. Make the check fail.
3. The retry prompt sent to the harness still contains both literal `$endCondition:` tokens.

## Root Cause

`parseConditionOutputRefs` (`FileReferenceParser.ts:~422-427`) reuses the `$step` reference regex,
whose field class `[A-Za-z0-9,\-]*` exists to allow ranges such as `$step:1,3-5`. A trailing `,`
or `-` is therefore captured into the field (`exitCode,`), which matches no placeholder, so
`substituteConditionOutputRefs` leaves the text verbatim and doesn't count it as unresolved. The
`$step` parser trims trailing commas; this one doesn't.

## Suggested Fix

Give condition refs their own field pattern, letters only (for example
`\$(preCondition|endCondition)(?::([A-Za-z]+))?`), since every name in `RETRY_PROMPT_PLACEHOLDERS`
is alphabetic. Consider a diagnostic for an unknown field on a recognised phase. Add unit tests for
the comma, hyphen and period cases above, for both `$endCondition` and `$preCondition`.
