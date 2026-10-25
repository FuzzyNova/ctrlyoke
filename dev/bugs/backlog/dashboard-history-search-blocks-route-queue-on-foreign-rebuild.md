# Dashboard history search can freeze every dashboard message for up to 30 minutes

- **Found:** 2026-10-24 by bug-drain review of 76b035219
- **Area:** `src/core/orchestration/historySearchRebuildWorker.ts`, `src/core/orchestration/HistorySearchIndexService.ts`, `src/ui/WebviewMessageRouter.ts`
- **Severity:** high

## Symptom

The CLI or a second VS Code window starts a full history-search rebuild of a large
history. Someone then types in the dashboard search box. Every dashboard message,
in the panel and in every hosted tab, now waits behind that search until the other
process's rebuild finishes, or up to 30 minutes. A newer query cannot pre-empt it.
Before 76b035219 the freeze was capped at 60 s, which was bad enough.

## Root Cause

76b035219 added `waitWhileHolderAlive` with `REBUILD_LOCK_MAX_WAIT_MS = 30 * 60_000`
(`historySearchRebuildWorker.ts`, around line 55). It also applies when the
extension host is the waiter. The dashboard search runs inside the shared
`routeQueue` (`WebviewMessageRouter.ts`, around line 505) and goes through
`HistorySearchIndexService.ensureReady` (around line 349), then `rebuild`, then
`waitForWorker` (around line 1091). The search's abort signal is never passed past
`ensureReady`.

## Suggested Fix

- Interactive (routed dashboard) searches must never wait on a lock that another
  live process holds. When the rebuild lock is held elsewhere, answer at once from
  the existing index, if there is one, with the index state reported as
  `BUILDING`. With no usable index, return an empty result in the `BUILDING`
  state. That is the original bug doc's third option
  (`dev/bugs/implemented/history-search-rebuild-lock-timeout-does-not-scale-with-history.md`).
  Keep the long live-holder wait only for CLI/MCP callers that explicitly want a
  complete index.
- Pass the search's abort signal through `ensureReady` and `rebuild`, so a
  superseded query stops waiting.
- Consider moving history search off the shared `routeQueue` (see
  `OFF_QUEUE_MESSAGE_TYPES`) if its handler is otherwise safe to run concurrently.

Add a test where another process holds a live rebuild lock and a routed search
returns promptly in the `BUILDING` state.
