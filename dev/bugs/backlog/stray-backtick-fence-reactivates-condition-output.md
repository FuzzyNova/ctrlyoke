# An unpaired ``` in the authored prompt re-activates fenced condition output

- **Found:** 2026-09-29 by bug-hunt final step (claude-cli)
- **Area:** `src/utils/FileReferenceParser.ts` (`maskFencedCodeBlocks`), `fenceLiteral` as used by `CliPromptPreparer.ts` (~139-146)
- **Severity:** low

## Symptom

`substituteConditionOutputRefs("Wrap code in ``` fences. Output: $endCondition:stdout done", {endCondition:{stdout:"see !CI_TOKEN and @src/a.ts", …}}, fenceLiteral)`
followed by the reference parsers detects secret `CI_TOKEN` and file ref
`src/a.ts` from the script output, which should be inert. Reproduced with a
scratch script against the real modules. It needs an unpaired triple-backtick
in the authored prompt, which is uncommon.

## Root Cause

`maskFencedCodeBlocks` treats any run of three or more backticks as a fence,
even mid-line. `fenceLiteral` sizes its fence only against backtick runs inside
the value, not the surrounding prompt. So the stray ``` pairs with the inserted
opening fence, leaving the value unmasked.

## Suggested Fix

Either parse references on the authored text before substitution and splice
substituted values in by offset, or size the fence against the longest backtick
run in the whole prompt (plus one). The first is more robust but a larger
change.
