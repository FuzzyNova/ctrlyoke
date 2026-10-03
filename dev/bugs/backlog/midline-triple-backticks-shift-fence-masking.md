# A triple backtick in the middle of a prose line shifts fence masking for the rest of the prompt

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/utils/FileReferenceParser.ts` (`findFencedBlockRanges`)
- **Severity:** low (design trade-off)

## Symptom

For a prompt whose first line mentions three backticks in prose
(`Use ``` fences for code. Review @src/a.ts now.`) followed by a real fenced
block containing `@x/y.ts`, `parseAtReferences` returns `['x/y.ts']`: the
real `@src/a.ts` is masked and never attached, while `@x/y.ts` inside the
real fenced block expands. That is the opposite of the docs' "References
inside a triple-backtick fenced block are not expanded".

## Steps to Reproduce

`parseAtReferences("Use ``` fences for code. Review @src/a.ts now.\n```\nexample @x/y.ts\n```\n")`

## Root Cause

Any run of three or more backticks anywhere in a line opens or closes a
fence, so a prose mention pairs with the next real fence and shifts every
later block.

## Suggested Fix

Only treat runs at line start (after up to three spaces, CommonMark-style) as
fences. Not queued: the scan is shared by editor chips, secrets, slash tokens
and generated literal fences (`LITERAL_FENCE_INFO`), and single-line inline
prompts may rely on run-anywhere matching, so this needs a deliberate design
pass.
