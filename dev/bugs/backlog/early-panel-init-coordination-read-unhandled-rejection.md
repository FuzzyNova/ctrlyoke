# Early panel INIT lets a coordination board lock timeout escape as an unhandled rejection

- **Found:** 2026-10-16 by Claude Code (production telemetry triage)
- **Area:** `src/ui/CtrlYokeWebviewProvider.ts`, `src/ui/WebviewSettingsSync.ts`
- **Severity:** low

## Symptom

Production telemetry (Azure Application Insights, unhandled errors VS Code reports for
this extension) recorded `FileLockTimeoutError: Timed out waiting for lock: <path>` 6
times, most recently on 2026-10-15. The extension version was not recorded. These
reports are unhandled promise rejections: no ctrlyoke code caught the error.

The panel itself recovers. The early INIT is a best-effort duplicate, and the READY
handler sends INIT again inside the router's `try`. But each occurrence reaches VS Code
as an extension error, and the early INIT message is lost.

## Steps to Reproduce

1. Hold the execution root's coordination board lock (`board.jsonl.lock`) for more
   than 5 s. Two ways this happens: a coordination MCP server is killed during a board
   transaction, which leaves a lock that is not stale until 30 s have passed; or a
   board transaction runs slowly on a synced or slow disk.
2. Open or reload the ctrlyoke panel while the lock is held (`resolveWebviewView` runs).
3. After 5 s, `withFileLock` throws `FileLockTimeoutError`. The rejection is unhandled
   and VS Code reports it against the extension.

## Root Cause

`CtrlYokeWebviewProvider.resolveWebviewView` sends an early INIT without handling a
rejection (`src/ui/CtrlYokeWebviewProvider.ts:232`):

```ts
void this.settingsSync.sendInitialState();
```

`WebviewSettingsSync.sendInitialState` awaits the coordination snapshot with no
`try`/`catch` (`src/ui/WebviewSettingsSync.ts:279-280`). The snapshot read takes a file
lock:

- `WorkflowOrchestrator.getCoordinationScopeSnapshot`
  (`src/core/WorkflowOrchestrator.ts:4965-4978`) calls `readCoordinationScopeSnapshot`.
  It also throws `No workspace execution root is available` (line 4976) when no folder
  is open. That error escapes the same way.
- `readCoordinationScopeSnapshot`
  (`src/core/orchestration/ExecutionRootCoordinationWatchSession.ts:34-45`) runs
  `registry.readEntries()` and `registry.fold()`.
- Both of those read through `ExecutionRootCoordinationStore.readAll`
  (`src/core/orchestration/ExecutionRootCoordination.ts:698-700` and `773-777`, then
  `src/core/orchestration/ExecutionRootCoordinationStore.ts:649-653`).
- `readAll` reads the board under `withFileLock(scope.boardPath, …)`
  (`ExecutionRootCoordinationStore.ts:673`).
- `withFileLock` throws `FileLockTimeoutError` after `LOCK_TIMEOUT_MS` (5 s)
  (`src/utils/FileLockUtils.ts:8`, `:175`). A dead holder's lock is reclaimed only
  after `LOCK_STALE_MS` (30 s) (`FileLockUtils.ts:10`), so every read in that window
  times out.

The other caller is the READY path (`src/ui/WebviewMessageRouter.ts:657`). It awaits
`sendInitialState` inside `routeSingleMessage`'s `try`/`catch` (lines 508-518), so it
logs the error and does not leak it. Only the early INIT leaks.

The rest of the extension treats the coordination snapshot as optional:
`ExecutionRootCoordinationWatchSession.refresh` catches and logs the same read failure,
and the INIT payload already sends `coordinationScope` only when one is present.

The path has existed since execution-root coordination visibility landed (`04d943af0`,
2026-09-11), so it covers every released version. It has not changed since. `16b248087`
(2026-10-15) changed `readAll`'s missing-board handling, but the lock and the uncaught
caller remain.

This is the only uncaught lock path a sweep found. The sweep ran typed
`@typescript-eslint/no-floating-promises` (with `ignoreVoid: false`) and
`no-misused-promises` over the extension sources. Each floating call that can reach
`withFileLock` was then traced by hand. Every other one handles the rejection.

## Suggested Fix

- Make the coordination snapshot optional in `sendInitialState`. Wrap the
  `getCoordinationScopeSnapshot` call in `try`/`catch`, log at debug or warn, and leave
  `coordinationScope` out of the INIT payload. This matches how the watch session
  already treats a failed refresh. The watch session's next refresh, or the READY
  re-send, fills the coordination scope in later.
- Also add `.catch(...)` with a log line to the early
  `void this.settingsSync.sendInitialState()` in `CtrlYokeWebviewProvider`. That way
  any other failure in a best-effort INIT is logged, not left unhandled.
- Add a unit test: make `getCoordinationScopeSnapshot` reject with
  `FileLockTimeoutError`. Assert that `sendInitialState` still emits INIT without
  `coordinationScope`, and that no unhandled rejection occurs.
