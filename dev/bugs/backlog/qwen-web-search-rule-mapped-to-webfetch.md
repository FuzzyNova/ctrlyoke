# Qwen maps a ctrlyoke `web_search` tool-permission rule to `WebFetch`

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli), reproduced by calling the mapper
- **Area:** `src/core/harness/qwen/QwenToolPermissionMapper.ts` (~264-269)
- **Severity:** medium (permission rules enforce the wrong tool)

## Symptom

`deniedTools: ["web_search"]` produces `--exclude-tools WebFetch`. On Qwen, web search
is still allowed, and web fetch, which the user didn't deny, is blocked. Allow-lists are
wrong the same way. No diagnostic is shown.

## Root Cause

`web_search`, `search` and `web_fetch` all map to `WebFetch`. In Qwen, `WebSearch` and
`WebFetch` are separate tools (`web_search -> WebSearch`, `web_fetch -> WebFetch`). The
OpenCode mapper already separates them (`websearch`/`webfetch`).

## Suggested Fix

Map `web_search`/`websearch`/`search` to `WebSearch` and `web_fetch`/`webfetch` to `WebFetch`.
Add cases to `HarnessToolPermissionMappers.test.ts` mirroring the OpenCode ones.
