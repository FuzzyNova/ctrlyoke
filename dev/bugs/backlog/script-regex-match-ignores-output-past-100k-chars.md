# `matches` comparisons silently ignore script output past 100,000 characters

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/utils/ScriptComparison.ts` (`compareRegex`)
- **Severity:** medium (needs a design decision)

## Symptom

An end condition, pre-condition or script step using `operator: matches` on
verbose output (an `npm test` or build log) evaluates the regex against only
the first 100,000 characters. A summary line at the end, such as
`3000 passing (12s)` or `1 failing`, is never seen, so the verdict is wrong.
`contains` on the same text sees the whole output, so the two operators
disagree. The `$` anchor that the schema suggests for full matches is tested
against the truncated text. The cap is not mentioned in the schema or docs.

## Steps to Reproduce

`compareScriptOutput({ compareSource: "stdout", operator: "matches", expected: "[0-9]+ passing" }, { stdout: <146 KB log ending in "3000 passing (12s)">, exitCode: 0 })`
returns `passed: false`. The same call on the last 200 characters returns
`true`, and `contains "3000 passing"` returns `true`.

## Root Cause

`compareRegex` runs `new RegExp(pattern).test(actual.slice(0, MAX_REGEX_INPUT_LENGTH))`.
The cap is a deliberate ReDoS guard (the regex runs in the extension host on
model-influenced output), but it keeps the head of the output, while test and
build summaries come at the end.

## Suggested Fix

This needs a decision, because the guard itself is load-bearing. Options:

- Run the regex on the full text in a worker or `vm` context with a timeout,
  and treat a timeout as a failed comparison with a clear reason.
- Keep the cap but evaluate the tail (or head and tail) instead of only the
  head, and document the window in the `operator` schema description.
- At minimum, document the cap and surface "output truncated for regex" in
  the verdict.
