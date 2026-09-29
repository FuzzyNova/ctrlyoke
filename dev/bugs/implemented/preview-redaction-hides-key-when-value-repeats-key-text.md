# Heuristic redaction hides the key instead of the value when the value text also appears in the key

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/types/PreviewRedactor.ts`, `src/utils/SecretRedactionService.ts`
- **Resolution:** fixed in this commit

## Symptom

Heuristic credential redaction can leave the secret visible. `password=password` is redacted to
`[REDACTED]=password`: the key is hidden and the value is shown.

## Steps to Reproduce

Call `redactPreviewText` with heuristics enabled (the default):

| Input                    | Actual                         | Expected              |
| ------------------------ | ------------------------------ | --------------------- |
| `password=password`      | `[REDACTED]=password`          | `password=[REDACTED]` |
| `token=token=token`      | `[REDACTED]=token`             | `token=[REDACTED]`    |
| `"password": "password"` | first `password` redacted      | value redacted        |
| `api_key=api_key_12345`  | `api_key=[REDACTED]` (correct) | same                  |

## Root Cause

For rules with a `valueGroup` (`credential-assignment`, `bearer-token`), the loop in
`PreviewRedactor.ts` (around line 105) locates the value with `matchText.indexOf(value)`.
`indexOf` returns the first occurrence of the value's text inside the whole match, which is inside
the key whenever the value text also appears earlier in the match. The span computed from that
offset covers the key, and the real value is left untouched.

## Suggested Fix

Use the capture group's real position: add the `d` flag to the rule patterns (or build a `d` copy
in the loop) and use `match.indices[rule.valueGroup][0]`. If every value group is known to end the
match, `matchText.length - value.length` also works, but group indices are robust to future
rules. Add regression tests in `src/test/unit/PreviewRedactor.test.ts` for the inputs above.
