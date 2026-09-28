# `PromptFileSplitter` produces chunks larger than `maxLinesPerFile` / `maxTokensPerFile`

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/utils/PromptFileSplitter.ts` (`splitIntoChunks`)
- **Severity:** medium

## Symptom

With the default config (scratch script against compiled `out/`):

- Lines: `split(1700 × "x" lines + "\n\n" + 1000 × "y" lines + "\n\n" + 1700 × "z" lines)` gives
  chunk line counts `[1700, 2701]`. Every chunk should be ≤ 1800 lines; 2701 is also over the
  2000-line read cap the splitter exists to stay under.
- Tokens: paragraphs of ≈8000, ≈1500 and ≈8000 tokens give chunk token counts `[8802, 10453]`,
  over the 10000 limit.

## Steps to Reproduce

Call the splitter with the inputs above.

## Root Cause

The flush condition in `splitIntoChunks` (`PromptFileSplitter.ts:~357-365`) skips flushing when the
current chunk is below `minChunkSize` and a chunk already exists, then appends the next paragraph
even though the combined chunk exceeds the limits. Only the "next paragraph is itself oversized"
path falls back to a line-by-line split.

## Suggested Fix

Only skip the flush when the merged chunk would still be within both limits; otherwise flush (or
route the paragraph through the line-by-line path). Tests: both examples produce chunks within
`maxLinesPerFile` and `maxTokensPerFile`.
