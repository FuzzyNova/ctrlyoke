# Node file watcher has no `error` listener, so a watch failure crashes `ctrlyoke server`

- **Found:** 2026-11-24 by claude-cli while assessing `dev/backlog/CHOKIDAR_6_UPGRADE.md`
- **Area:** `src/platform/NodeFileWatcher.ts`
- **Resolution:** fixed in this commit

## Symptom

`ctrlyoke server` (the standalone hosted dashboard) exits with an uncaught exception when chokidar hits a filesystem error while watching the workspace. Examples are `EACCES`/`EPERM` on an unreadable subfolder, or `EMFILE` when the process runs out of file handles. `NodeHostServices` watches `**/*` under the working directory for completions, so any unreadable folder in the tree is enough.

## Steps to Reproduce

1. Start `ctrlyoke server` in a workspace that contains a folder the current user can't read (POSIX: `chmod 000 some-dir`), or with a low file-handle limit.
2. chokidar emits `error` for the failure.
3. Nothing listens for `error`, so `EventEmitter.emit` rethrows the error and the process dies.

## Root Cause

chokidar 5 (`_handleError` in `node_modules/chokidar/index.js`) emits an `error` event for every filesystem error except `ENOENT` and `ENOTDIR`. `EPERM`/`EACCES` are skipped only when `ignorePermissionErrors` is set, and we don't set it. `NodeFileWatcher` subscribed only to `all`, and an `error` event with no listener throws. The VS Code extension uses `VsCodeFileWatcherFactory` and is unaffected.

The chokidar 6 backlog doc listed adding a listener as part of that upgrade. The bug already existed on 5.x.

## Fix

`NodeFileWatcher` registers an `error` listener. For each watcher, the first error with a given errno code is logged with `Log.warn`, naming the base path and glob. Repeats are logged at debug so an `EMFILE` storm doesn't flood the log. The watcher stays open and keeps reporting the paths it can still read. `NodeFileWatcherFactory` takes an optional chokidar `watch` function so tests can reach the underlying watcher and emit errors.
