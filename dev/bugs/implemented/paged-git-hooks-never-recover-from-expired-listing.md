# Paged git listings never recover after the server expires their snapshot

- **Found:** 2026-11-09 by deferred code-smell review, claude-cli
- **Area:** `src/ui/webview-react/hooks/usePaged{CommitHistory,FileHistory,GitRefDiff}.ts`, `src/ui/webview-react/utils/pagedListing.ts`
- **Resolution:** fixed in this commit

## Symptom

In the workspace viewer's commit history, file history or ref-diff list, leave
the view idle for more than 5 minutes and then scroll: a range fails to load.
That range's Retry button fails every time. Only the full refresh button
recovers.

## Steps to Reproduce

1. Open a long commit log, file history or ref diff in the hosted workspace
   viewer.
2. Wait more than 5 minutes without scrolling.
3. Scroll to an unloaded range. It fails, and its per-page Retry
   (`DiffFileHistoryList.tsx:229`, `DiffRefDiffList.tsx:228`) keeps failing.

## Root Cause

`HostedWorkspaceViewerService` evicts these snapshots after 5 idle minutes
(`IdleLruSnapshotStore`, `HostedWorkspaceViewerService.ts:196`) and answers a
request for an expired one with HTTP 410 (`:2544`, `:2933`, `:3464`). Only
`usePagedWorkspaceDirectory` checks for it (`isExpiredError`,
`usePagedWorkspaceDirectory.ts:165`) and restarts the listing once
(`:447`, `:544`). The three git hooks treat the 410 as an ordinary page error
and retry with the same expired snapshot ID.

A smaller related gap: the three git default fetchers ignore their abort
signal (for example `_signal` at `usePagedFileHistory.ts:147`), because the
matching `hostedApi` functions don't accept one. Cancelled pages still run on
the server.

## Suggested Fix

Move `isExpiredError` and a "restart from the first page once" helper into
`utils/pagedListing.ts`, and use them in the three git hooks. Add expiry tests
modelled on `usePagedWorkspaceDirectory.test.ts:479`/`:507`. Don't merge the
hooks into one generic hook; the code-smell ledger rules that out.
