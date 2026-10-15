# MCP registry search results are not matched to their query, so a stale reply can replace the current results

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/ui/webview-react/store/useMcpManagerStore.ts`
- **Severity:** low

## Symptom

On the MCP Manager Registry tab, the results list can show the results of an earlier search while the search box shows a newer query. The stored next-page cursor then also belongs to the earlier query, so Next page sends the old query's cursor with the new query text.

## Steps to Reproduce

1. Open Settings > MCP Manager and switch to the Registry discovery tab.
2. Type `git` and wait more than 500 ms so the debounced search for `git` is sent.
3. Before that reply arrives (on a slow network, or with a delay added in `safeFetchMcpRegistry`), type `hub` so the query becomes `github`. 500 ms later a second search for `github` is sent.
4. If the `github` reply arrives first and the `git` reply arrives after it, the list ends up showing the `git` results while the box reads `github`.
5. Click Next page. `goNextPage` sends the `git` `nextCursor` with query `github`, and the registry returns an unrelated or wrong page.
6. Switching the sort, or pressing Enter, while an earlier request is still pending can produce the same stale overwrite.

## Root Cause

Replies are never matched to the request that produced them, and the latest reply to arrive wins.

1. `src/ui/webview-react/store/useMcpManagerStore.ts:207-211` (`searchRemoteRegistry`) sends `REQUEST_MCP_REGISTRY_SEARCH` with only `query`, `cursor` and `updatedSince`, and no request ID.
2. `src/ui/WebviewMessageRouter.ts:1420-1427` runs each request as its own async handler, with no serialization or cancellation.
3. `src/ui/McpManagerService.ts:158-173` (`handleRequestRegistrySearch`) awaits `safeFetchMcpRegistry` (`src/utils/McpDiscoveryUtils.ts:1028`, no abort or cache) and sends back only `servers`, `nextCursor` and `error`. It does not echo the query or an ID.
4. `src/ui/webview-react/hooks/useMessageHandler.ts:2154-2162` passes every `MCP_REGISTRY_SEARCH_RESULT` to `setRemoteSearchResult` without checking it.
5. `setRemoteSearchResult` (`src/ui/webview-react/store/useMcpManagerStore.ts:142-148`) overwrites `remoteServers` and `remoteNextCursor` and clears `isLoadingRemote`.
6. `goNextPage` (`src/ui/webview-react/store/useMcpManagerStore.ts:214-229`) then pairs that stale `remoteNextCursor` with the current `remoteQuery`.

The 500 ms debounce in `src/ui/webview-react/components/settings/McpManagerSection.tsx:604-617` only spaces out when requests are sent and does not make replies arrive in order.

## Suggested Fix

Add a `requestId` to `RequestMcpRegistrySearchMessage` and `McpRegistrySearchResultMessage` in `src/types/WebviewMessageTypes.ts`:

1. In `searchRemoteRegistry`, increment a store counter (`latestRemoteRequestId`), keep the new value in state, and send it with the request.
2. In `handleRequestRegistrySearch`, echo the `requestId` back in the reply.
3. In `setRemoteSearchResult` (or the `useMessageHandler` handler), drop any reply whose `requestId` differs from `latestRemoteRequestId`, so a stale reply cannot overwrite results, cursor or loading state.

Optionally, also abort the superseded fetch on the extension side.

Add a store test: issue two searches, deliver the replies in reverse order, and assert that the first reply is ignored and `remoteNextCursor` comes from the second.
