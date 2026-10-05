# Headless script conditions compare raw stdout, so CRLF and ANSI codes break `eq`/`contains`/`matches`

- **Found:** 2026-09-30 by the bug-backlog workflow final step (claude-cli); reproduced against compiled `out/` on Windows
- **Area:** `src/core/EndConditionEvaluator.ts` (`evaluateSuccess` ~949-964), `src/core/orchestration/ScriptProcessRunner.ts` (only `.trim()`s), compared with `src/core/WorkflowExecutor.ts` (~2641, PTY path uses `sanitizeTerminalOutput`)
- **Resolution:** fixed in this commit

## Symptom

The same script condition can pass when run interactively (PTY) and fail when run
headless. The PTY path runs the output through `sanitizeTerminalOutput`, which
normalizes CRLF to LF and strips ANSI codes, before comparing. The headless path
(every non-interactive end condition, pre-condition, and script step) compares
the raw stdout:

| Script                                                  | Condition                        | Result | `actual`                     |
| ------------------------------------------------------- | -------------------------------- | ------ | ---------------------------- |
| pwsh `Write-Output 'build ok'; Write-Output 'tests ok'` | `stdout eq "build ok\ntests ok"` | fail   | `"build ok\r\ntests ok"`     |
| same                                                    | `matches "ok\ntests"`            | fail   |                              |
| cmd `echo a& echo b`                                    | `contains "a\nb"`                | fail   | `"a\r\nb"`                   |
| node printing `\x1b[32mPASS\x1b[39m`                    | `eq "PASS"`                      | fail   | `"\u001b[32mPASS\u001b[39m"` |

This contradicts the docs, which say the comparison uses "the whole trimmed value,
literally" (`docs/workflows/end-conditions.md`). The dashboard also shows the
sanitized output next to the failed verdict, so the user can't see why it failed.
`$endCondition:*` refs carry `\r` as well.

## Root Cause

`evaluateSuccess` passes `result.stdout` straight to `compareScriptOutput`.
Normalization only happens in the PTY caller.

## Suggested Fix

Sanitize stdout and stderr with `sanitizeTerminalOutput` in one place on the
comparison path, either `evaluateSuccess` or `compareScriptOutput`'s source reader,
so both transports compare identical text. Don't sanitize again in the PTY caller,
so the logic stays single-sourced. Add unit tests with CRLF and ANSI input for
`eq`, `contains`, and `matches`.
