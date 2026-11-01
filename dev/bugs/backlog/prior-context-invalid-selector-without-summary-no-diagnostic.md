# Invalid `$step:` / `$previous:` selectors get no diagnostic unless they include `:summary`

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/PromptDiagnosticRules.ts`
- **Severity:** low

## Symptom

A malformed prior-context selector is silently left as literal text: the run
attaches nothing and the editor shows no warning. The `:summary` form of the
same mistake is flagged.

With `getPriorContextDiagnostics(text, { stepCount: 3, hasFinalStep: false })`:

| Input                       | Diagnostic                                                         |
| --------------------------- | ------------------------------------------------------------------ |
| `see $step:3-1 now`         | none                                                               |
| `see $step:0 now`           | none                                                               |
| `see $previous:0 now`       | none                                                               |
| `see $step:summary:3-1 now` | `Unknown or invalid prior-context selector: $step:summary:3-1`     |

## Steps to Reproduce

1. Put `Review $step:3-1` in a prompt.
2. No warning in the editor; at run time the token is passed through verbatim
   and no step output is attached.

## Root Cause

`getInvalidPriorContextSummaryDiagnostics`
(#selection:src/utils/PromptDiagnosticRules.ts:247-268) skips every body that
lacks a summary segment:
`if (!hasSummarySegment(body) || parseInlinePriorContextBody(body)) continue;`.
`checkPriorContextRefs` only sees tokens that parsed, so an unparseable
`$step:0` or `$step:3-1` reaches neither check. The "unknown `$tokens` pass
through for future syntax" rule (`scanInlinePriorContextRefs` in
`src/utils/FileReferenceParser.ts`) is about unknown kinds; these are a known
kind (`step`, `previous`) with an invalid argument.

## Suggested Fix

Warn with `PRIOR_CONTEXT_INVALID` whenever the body names a known
argument-taking kind followed by `:` and an argument (`step:…`, `previous:…`,
and the `:summary` forms) and `parseInlinePriorContextBody(body)` returns null.
Keep unknown kinds silent, and keep prose such as `$previous: fix it` (already
parsed as `$previous` plus a colon, see
`dev/bugs/implemented/prior-context-ref-trailing-colon-not-expanded.md`) free
of warnings. Rename the function if it no longer only covers summaries. Check
that the dashboard editor's diagnostics use the same rule. Tests in
`src/test/unit/PromptDiagnosticRules.test.ts`.
