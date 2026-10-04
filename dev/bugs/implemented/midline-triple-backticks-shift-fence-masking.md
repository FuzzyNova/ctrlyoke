# A triple backtick in the middle of a prose line shifts fence masking for the rest of the prompt

- **Found:** 2026-10-02 by bug-hunt final step (Claude)
- **Area:** `src/utils/FileReferenceParser.ts` (`findFencedBlockRanges`)
- **Resolution:** fixed in this commit

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

## Decision

Decided 2026-10-03 by Nathan (supersedes the earlier line-start-fences-only
decision): in prompt text, both fenced code blocks and inline code spans are
literal, so reference tokens inside them are never expanded, attached, or
granted. This replaces the old rule that only triple-backtick fences suppress
expansion. AI-written prompts routinely put identifiers in single backticks: a
queued prompt quoted a test scenario containing a secret grant inside single
backticks, it became a real grant, and the workflow failed, even though the
agent that wrote it had the ctrlyoke-syntax skill saying single backticks still
expand. The output pane already shows backticked text literally, so this also
makes prompts and replies consistent.

One scan in `FileReferenceParser` decides every masked range:

1. Block fence: a run of 3+ backticks opens a block fence only at line start,
   after up to three spaces (CommonMark), and closes at a line-start run of at
   least the opener's length. An opener that is never closed masks nothing.
   Inline-span rules do not apply inside a block fence.
2. Inline span: any other run of N backticks (including 3+ runs mid-line)
   opens a span only when a run of exactly N backticks closes it later on the
   same line; runs pair left to right.
3. A run with no same-length partner later on its line is plain text.
4. Outside a span, a backslash-escaped backtick is not a delimiter.
5. Generated literal fences (`fenceLiteral` / `LITERAL_FENCE_INFO`) are always
   emitted at line start and keep working.

Inline spans mask prompt-reference triggers only. Workflow var
(double-brace placeholder) substitution keeps fence-only masking, because vars
are substituted into script text where backticks are shell command
substitution.
