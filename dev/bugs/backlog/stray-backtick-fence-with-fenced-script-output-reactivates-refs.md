# Stray authored ``` still re-activates condition output when the output itself contains a ``` fence

- **Found:** 2026-09-30 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/FileReferenceParser.ts` (`maskFencedCodeBlocks` / `fenceLiteral`), `src/core/ConditionOutputRefs.ts`
- **Severity:** medium

Follow-up to `stray-backtick-fence-reactivates-condition-output.md` (fixed in 1b8097110). That fix
only holds when the substituted value contains no backtick fence of its own.

## Symptom

A prompt with an unpaired ``` in its authored text, and a `$endCondition:stdout` (or other
condition-output) value that contains a ``` line, still has the value's text parsed for
references. `@file`, `$previous` and `!SECRET` in script output expand or trigger secret grants.
Script output that contains markdown fences is common, e.g. AI-generated text or test-tool output.

## Steps to Reproduce

Authored prompt:

````text
Wrap code in ``` fences. Output: $endCondition:stdout done
````

stdout value:

````text
a
```
see !CI_TOKEN and @src/a.ts $previous
````

Run it through `substituteConditionOutputRefs` with the preparer's formatter
(`fenceLiteral(v, LITERAL_FENCE_INFO, authoredText)`), then the parsers:
`parseAtReferences` returns `src/a.ts`, `parseInlinePriorContextRefs` returns `$previous`, and
`parseSecretReferences` returns `CI_TOKEN`. All three should return nothing.

## Root Cause

The authored ``` opens a masked block. The generated opener (a longer run with the `text` info
string) is correctly not treated as a closer. But the value's own ``` line (length 3, which is at
least the authored opener's length) closes the authored block. Everything after it in the value is
unmasked, and the generated closing fence then opens a new block that never closes.

## Suggested Fix

Stop relying on the combined text's fence structure. Parse references on the **authored** text
before substitution, then splice the substituted values in by offset, so inserted values are never
seen by the parsers. This is option 1 in the original bug doc. If that's too invasive, change the
masking scanner so that a generated `text` opener seen inside an open authored block ends the
authored block there, and scanning restarts at the generated opener, whose longer fence
guarantees that only its matching closer ends it. Add the repro above as a regression test next to
the existing stray-backtick tests in `conditionOutputRefs.test.ts` / `FileReferenceParser.test.ts`.
