# `read_output` paging splits emoji and other surrogate pairs, and `limit: 0` never advances

- **Found:** 2026-09-27 by the long-running bug-fix workflow final step (claude-cli, helper agent)
- **Area:** `src/mcp-server.ts` (`read_output` paging)
- **Resolution:** fixed in this commit

## Symptom

Reproduced with `node out/mcp-server.js --tool read_output` on a step whose response is `"AB😀CD"`:

- `limit: 3` returns `"AB\ud83d"` with `nextCursor: "3"`.
- `cursor: "3"` and `tail: 3` both return `"\ude00CD"`.

Each page carries half a character, which becomes U+FFFD once encoded. Separately, `limit: 0`
returns `""` with a `nextCursor` equal to the current cursor, so a paging loop never advances.

## Steps to Reproduce

1. Have a step produce output containing an emoji near a page boundary.
2. Page through it with `read_output` using `limit`/`cursor`, or read its `tail`.

## Root Cause

Paging (`mcp-server.ts:~1556-1575`) slices by UTF-16 code units with no surrogate-boundary
adjustment, and `limit` isn't required to be positive.

## Suggested Fix

When a page end would fall between a high and a low surrogate, end the page one unit earlier. When a
tail or cursor start would begin on a low surrogate, move it back or forward to a whole character.
Reject `limit < 1` (or the schema minimum 1). Tests for all three cases.
