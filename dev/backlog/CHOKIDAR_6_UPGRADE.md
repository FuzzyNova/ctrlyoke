# Upgrade chokidar 5 → 6

**Status:** blocked. Dependabot ignores chokidar majors (`.github/dependabot.yml`); delete that entry to get the PR back.

## Why it's blocked

chokidar 6.0.0 declares `engines.node: ">= 22.22"`. ctrlyoke's `engines.node` floor is `>=22.12.0`, and chokidar runs on the user's own Node: `src/platform/NodeFileWatcher.ts` (via `NodeHostServices`) is the file watcher for the standalone CLI and MCP server. Taking 6.x would break users on Node 22.12–22.21. Dependabot PR #16 was closed for this reason.

## What unblocks it

Raising `engines.node` to `>=22.22` or higher, with a **Changed** entry in `CHANGELOG.md`. When that happens, check whether `engines.vscode` also has to move, because the extension host's bundled Node must meet the floor too.

## What the upgrade has to check

From the 6.0.0 release notes, the parts that touch `NodeFileWatcher`:

- The watcher was rewritten around native recursive `fs.watch` on Windows and macOS (`backend: 'auto'`). Re-run the file-watcher contract tests (`src/test/helpers/fileWatcherContract.ts`) on Windows, macOS and Linux, and watch for event-ordering or duplicate-event changes.
- `ignored` is no longer applied to directories above a watched path. Ours is a function over paths relative to `basePath`; confirm it still filters as expected when the watched path is a literal basename.
- `close()` is now terminal and `add()` throws after it. We never re-add after dispose, but verify.
- `getWatched()` returns a null-prototype object (unused today).
- Errors from `add()` now arrive as `error` events instead of unhandled rejections. `NodeFileWatcher` registers no `error` listener today, and an unhandled `error` event on an EventEmitter throws, so add one (logging through `Log`) as part of the upgrade.
