# `read_notes` tells the caller to "call read_notes again" after a `since` or `from` read, which skips notes or repeats the page

- **Found:** 2026-11-01 by bug-hunt final step (claude-cli)
- **Area:** `src/mcp-server.ts`, `src/core/orchestration/ExecutionRootCoordination.ts`, `src/core/harness/shared/McpToolDefinitions.ts`
- **Resolution:** fixed in this commit

## Symptom

When a page of notes is truncated, `read_notes` returns `nextCursor` and
`more: "More unread notes remain; call read_notes again to continue."`
(`src/mcp-server.ts:1050-1054`). That wording is only right for a default
unread read, where the stored cursor advances. A read with explicit `since`
or a `from` filter doesn't advance the stored cursor
(`ExecutionRootCoordination.ts:761-764`), as the tests at
`ExecutionRootCoordination.test.ts` around `:1041` and `:1078` intend. So
following the hint:

- After `read_notes { "since": 0 }`, which the tool's own `omittedOlder` hint
  suggests, calling `read_notes {}` returns `entries: []` when the cursor is
  already at the board head. The remaining older notes are never reached.
- After `read_notes { "from": ["P"] }`, calling again with the same arguments
  returns the same first page indefinitely.

## Steps to Reproduce

1. Post more notes than `coordination.readNotesPageSize`.
2. Call `read_notes {}`. You get the newest page and an `omittedOlder` hint to
   pass `"since": 0`.
3. Call `read_notes { "since": 0 }`. You get the oldest page with `nextCursor`
   and the "call read_notes again" hint.
4. Call `read_notes {}`. You get no entries.

## Root Cause

`handleReadNotes` uses one fixed `more` string whenever the store returns
`nextCursor`. It never tells the caller to pass `nextCursor` back as `since`,
and the `since` property description in `McpToolDefinitions.ts` doesn't
mention this either.

## Suggested Fix

When the read used `since` or `from`, word `more` as "call read_notes with
`"since": <nextCursor>`" and keep the same `from`. Keep the current wording
for the default read. Add to the `since` description that it accepts a
returned `nextCursor`. Add MCP server tests for both wordings. Do not change
the cursor-advance semantics; they are deliberate.
