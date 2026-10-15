# NodeFileWatcher watches the whole subtree recursively with no ignores, even for single-file watches

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/platform/NodeFileWatcher.ts`
- **Resolution:** fixed in this commit

## Symptom

In the standalone `ctrlyoke server` host, two actions make chokidar walk and watch every directory in the repository, including `node_modules`, `.git` and build output: opening a workspace-root file in the browser workspace viewer, and requesting a script-command completion. In large repos this causes a long blocking scan, high CPU and memory use, thousands of handles, and a stream of discarded events during `npm install` or git operations. On Linux it can exhaust inotify watches (`ENOSPC`), which also breaks other watchers on the machine. The VS Code host does not do this.

## Steps to Reproduce

1. In a large repository with a populated `node_modules` (ctrlyoke itself works), run the standalone server with `ctrlyoke server`.
2. Open the dashboard URL in a browser and open a root-level file such as `README.md` in the workspace viewer. This sends a watch request to `CtrlYokeHostedServer.watchWorkspaceFile`.
3. Or type a script command in a script step so the dashboard requests script completions. This calls `ensurePackageJsonWatchers` on the workspace root with `**/package.json`.
4. Watch the server process. Chokidar runs a long directory walk, the handle/inotify count and CPU climb, and every file write anywhere in the tree fires an event (for example during `npm install`). On Linux, the limit in `/proc/sys/fs/inotify/max_user_watches` is soon exceeded and `ENOSPC` errors appear.

## Root Cause

`src/platform/NodeFileWatcher.ts:22` calls `watch(normalizedBasePath, { ignoreInitial: true })` with no `depth`, `ignored` or `followSymlinks: false`. It applies the glob only after an event arrives (line 29). As a result, every directory under `basePath` is watched no matter what the glob says.

Callers pass broad base paths for narrow targets:

- `src/server/CtrlYokeHostedServer.ts:2909-2913` passes `dirname(file)` as the base and the file's basename as the glob.
- `src/completions/ScriptCommandCompletionHelpers.ts:433-436` passes the workspace root and `**/package.json`. That watcher is never disposed.
- `src/core/orchestration/PromptFileWatcher.ts:102-105` passes `dirname(file)` as the base and the file's basename as the glob.

The standalone host wires `NodeFileWatcherFactory` into all of these (`src/platform/NodeHostServices.ts:167`, `264`, `292`, `373`). The VS Code host uses `VsCodeFileWatcherFactory` instead, which applies `files.watcherExclude`, so the two hosts use very different amounts of resources.

## Suggested Fix

- Derive the watch scope from the glob in `NodeFileWatcher`. If the glob has no path separator and no `**` (a single basename or a one-level pattern), watch with `depth: 0`. If it is a literal name, watch the exact file path directly.
- In every case, pass chokidar an `ignored` predicate that prunes directories that cannot match the glob. It should also always exclude `node_modules`, `.git` and similar heavy directories, mirroring VS Code's default `files.watcherExclude` set from a single shared constant. Also set `followSymlinks: false`.
- In `ScriptCommandCompletionHelpers`, either exclude `node_modules` from the `**/package.json` watch or watch only the `package.json` files that were actually discovered. Keep the watcher handle so it can be disposed.
- Add a contract test in `src/test/helpers/fileWatcherContract.ts` asserting that a basename watch does not report changes in subdirectories. Add a Node-specific test asserting that `node_modules` is not watched.

## Decision

Use the default `files.watcherExclude` patterns as one shared constant. The
completion cache reset disposes its retained package watchers, and Chokidar
prunes excluded paths and non-matching directories before traversal.
