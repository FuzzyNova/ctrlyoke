# Web search rows carry no tool-call id, so parallel searches can take each other's results

- **Found:** 2026-10-24 by Claude (claude-cli) while reviewing subagent output display
- **Area:** `src/types/CliOutputTypes.ts` (`WebSearchData`), `src/core/harness/shared/BaseToolBuilder.ts`, `src/utils/CliEventNormalizer.ts`
- **Severity:** low

## Symptom

When two web searches are in flight at once (most often two subagents searching
in parallel), a search result can be merged into the wrong "Web search" row. One
row then shows the other search's success or error, and the other row stays
pending.

## Steps to Reproduce

1. Run a harness whose web search maps to `CLI_EVENT_TYPES.WEB_SEARCH` (Copilot,
   Antigravity, Codex, or any harness whose tool is named `web_search`, `search`
   or `google_web_search`).
2. Start two web searches before either returns. Two parallel subagents asked to
   search the web will do this.
3. The second search's result can attach to whichever pending search row is
   newest, not to its own.

## Root Cause

`WebSearchData` has no `toolCallId`, unlike every other operation type.

- `BaseToolBuilder.buildInitiatedEvents` (`case CLI_EVENT_TYPES.WEB_SEARCH`) has
  the call's `toolId` but builds `{ query }` only. `CopilotToolBuilder` and
  `AntigravityToolEventBuilder` also leave out the id.
- The normalizer keys a pending web search by `web:${query}` (`getEventKey`) and
  creates its pending entry without a `toolCallId` (`toPendingEvent`).
- `findPendingForResult` can't match the result's `toolCallId` against it, so it
  falls back to "newest pending entry that never had an id". With two id-less
  searches pending, the newest one takes the result, whichever search it
  belongs to.

## Recommendation: keep the existing `webSearch` row type, and give it an id

`CLI_EVENT_TYPES.WEB_SEARCH` (`"webSearch"`) already exists and has its own
renderer (`WebSearchOutput`, "Web search: "<query>""). No new event type is
needed. The fix is to correlate it like every other operation:

1. Add optional `toolCallId?: string` to `WebSearchData`. This only adds a field,
   so recorded timelines still load.
2. Stamp it wherever a web search is built: `BaseToolBuilder`, `CopilotToolBuilder`
   and `AntigravityToolEventBuilder`, and Codex if its builder has the call id.
3. In `CliEventNormalizer`, carry `toolCallId` on the web-search pending entry
   and let `getEventKey` prefer `web:${toolCallId}` over `web:${query}`. The
   existing by-id matching in `findPendingForResult` then pairs results
   correctly. Keep the query fallback for recorded events that have no id.

**Follow-up, only after step 3:** Claude's `WebSearch` tool currently renders as
a generic tool call. `CliEventMapper.classifyTool("WebSearch")` returns
`TOOL_CALL`, because the lowercased name `websearch` is not in
`WEB_SEARCH_TOOLS`. That is the only reason Claude searches pair correctly
today: generic tool calls pair by id. Adding `websearch` to `WEB_SEARCH_TOOLS`
would give Claude the dedicated row. Doing that before the id fix would bring
this bug to Claude. It also needs `WebSearchOutput` to show the result: today
`mergeInitiatedWithResult` copies only `success`/`error` onto a web search, so
the result text that Claude's generic row shows now would be dropped.

`webfetch`/`web_fetch` are deliberately not web searches. They take a URL, not a
query, and stay generic tool calls (see `WEB_FETCH_TOOLS` in `CliEventMapper`).
