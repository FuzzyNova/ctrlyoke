# Harness preCondition-stdout test fails since condition output is fenced

- **Found:** 2026-09-28 by the MCP event pipeline orchestrator review (`npm run test:harness`, copilot-cli / gpt-6-luna)
- **Area:** `src/test/harness/conditions.harness.test.ts`, `src/core/harness/shared/CliPromptPreparer.ts`
- **Severity:** low

## Symptom

`Script Condition Harness Tests › copilot-cli: preCondition comparison matrix covers every
operator and source` fails with `$preCondition:stdout was not expanded into the prompt`. The file
the agent wrote contains the magic value wrapped in fence residue:

```
+ '`\nCY-MAGIC-4817\n`'
- 'CY-MAGIC-4817'
```

## Steps to Reproduce

1. `npm run compile-tests`
2. Run `out/test/harness/conditions.harness.test.js` against copilot-cli with the cheapest model.
3. The reference step's output file holds the value plus backtick/newline residue.

## Root Cause

`b9a3db31` (fix(prompts): keep condition output out of reference parsing) expands condition
output inside a Markdown code fence (`FileReferenceParser`'s fence helper) so it is not parsed
for `@` references. The expansion itself works; the model copies part of the fence into the file,
and the test compares the file content exactly.

## Suggested Fix

Make the test robust to the fenced expansion: tell the agent to write only the value inside the
fence, and/or strip surrounding backticks and whitespace before comparing. Keep the fencing in
production; it is what prevents reference parsing of condition output.
