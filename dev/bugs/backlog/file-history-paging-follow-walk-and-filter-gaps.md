# File and commit history paging: full --follow walks, permanent placeholder gaps, unguarded commit count

- **Found:** 2026-10-24 by bug-drain review of f23835182
- **Area:** `src/server/HostedWorkspaceViewerService.ts`, `src/ui/webview-react/hooks/usePagedFileHistory.ts`, `src/ui/webview-react/hooks/usePagedCommitHistory.ts`
- **Severity:** medium

## Symptom

1. **File history still times out for rarely changed files.** Opening the history of
   a file with 30 or fewer commits in a Linux-sized repo still runs a full-history
   `git log --follow` walk, hits the 10 s timeout and returns 500, as in the
   original bug's reproduction. The last page of any file does the same.
2. **Permanent placeholder rows.** The workspace is a subfolder of a monorepo and the
   file was moved in from outside it. Every row from before the move is filtered
   out, so the list scrolls through pages of spinners that never resolve. Before
   f23835182 the list simply ended.
3. **Commit log first page can fail.** The `rev-list --count` used for the commit
   log's total has no try/catch and shares the 10 s git timeout. On a fresh large
   clone without a commit-graph it can time out, and the first page then returns 500.

## Root Cause

1. `HostedWorkspaceViewerService.ts` (around line 2341) requests `pageSize + 1` rows
   to compute `hasMore`. When fewer matching commits exist, git has to walk the
   whole history to prove there are none.
2. The trusted-root filter (around line 2350) now runs after the page slice, but
   `offset` still counts raw git rows. A filtered page returns fewer than `pageSize`
   entries with `hasMore: true`. `usePagedFileHistory.ts` (around line 527) indexes
   rows as `pages.get(offset)?.[index - offset]`, and `pages.has(offset)` stops a
   re-request, so the missing indexes never fill.
3. `rev-list --count` (around line 2576) runs unguarded.

## Suggested Fix

1. Bound the `--follow` walk by time rather than failing. Stream the `git log`
   output, kill it at the deadline, and return the rows received with
   `hasMore: true` and a continuation cursor. Return a 500 only if no row
   arrived and git failed.
2. Separate the raw git cursor from the virtual row index. The server returns
   densely packed filtered rows plus a `nextOffset` (raw cursor). The client
   appends pages sequentially instead of addressing them by raw offset. Change
   `HostedWorkspaceViewerTypes.ts` additively.
3. Catch a count failure or timeout and omit the total. `usePagedCommitHistory`
   must then page on `hasMore` the way the file-history hook already does.

Add server tests for each case, and a hook test showing that a short (filtered)
page doesn't leave permanent placeholders.
