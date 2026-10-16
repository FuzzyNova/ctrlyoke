# A shared hosted file watcher announces changes under the first subscriber's path spelling

- **Found:** 2026-10-15 by Claude Code (bug-hunt final step; code reading, low confidence on how often it happens)
- **Area:** `src/server/CtrlYokeHostedServer.ts` (`watchWorkspaceFile`, `broadcastWorkspaceFileChanged`), `src/ui/webview-react/components/workspace-viewer/WorkspaceExplorerPane.tsx`
- **Severity:** low

## Symptom

Two dashboard clients watching the same real file under different viewer paths (for example
`link.ts`, a symlink to `real.ts`, and `real.ts` itself) share one watcher. When the file
changes, the broadcast names only the first client's path, so the second client never reloads
and never shows "This file changed on disk".

## Steps to Reproduce

1. In the workspace, create `real.ts` and a symlink `link.ts → real.ts`.
2. Open `link.ts` in one hosted dashboard tab and `real.ts` in another.
3. Edit `real.ts` on disk. Only the `link.ts` tab reacts.

## Root Cause

`watchWorkspaceFile` keys subscriptions by the resolved real path, but the `notify` closure
created by the first subscriber captures that subscriber's raw `viewerPath`
(`CtrlYokeHostedServer.ts`, around `:2938-2977`) and passes it to
`broadcastWorkspaceFileChanged`. Clients match `changed.path` against their selection with exact
string equality (`WorkspaceExplorerPane.tsx`, around `:402-404`).

Not confirmed: whether spellings other than symlinks (e.g. `./src/a.ts`) reach the server
without being normalized.

## Suggested Fix

Keep a per-client `viewerPath` on the subscription and notify each client with its own spelling,
or broadcast every viewer path currently subscribed to that real file.
