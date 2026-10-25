# Subprocess timeout follow-ups: Codex probe leak, statusline partial output, timeout detection

- **Found:** 2026-10-24 by bug-drain review of 177222317, 7964b4103 and a6c3d4b98
- **Area:** `src/core/harness/codex/CodexAppServerClient.ts`, `src/scripts/ctrlyoke-statusline-wrapper.js`, `src/core/EndConditionEvaluator.ts`
- **Severity:** medium

## Symptom

1. **Codex app-server child leaks** when the quota probe's 5 s timeout fires while
   the Windows launcher resolution is still pending. The `codex app-server` process
   is never killed.
2. **Statusline loses output on timeout:** a statusline command that prints its line
   and keeps running past 1.5 s now shows blank on a cold cache (it used to show
   the partial output).
3. **Statusline wrapper can crash** if `taskkill` cannot be spawned (no `error`
   listener on that child).
4. **Interpreter probe timeouts are logged as generic failures:** a real
   `execFile` timeout is never recognised as a timeout.

## Root Cause

1. `CodexAppServerClient.ts` (around lines 98-121): spawning now awaits
   `resolveCommand`. If the probe timeout wins the race, `finally` calls
   `teardown(process)` while `process` is still undefined; when resolution then
   finishes, the `signal?.aborted` check does not cover a timeout, so
   `spawnProcess` runs and `performProbe` waits forever on `initialize`.
2. `ctrlyoke-statusline-wrapper.js` (around line 411):
   `if (result.timedOut) return readForwardedOutputCache(harnessId);` ignores
   `result.output`.
3. Same file, around lines 353-357: the `taskkill` spawn has no `'error'` listener.
4. `EndConditionEvaluator.ts` (around lines 1094-1104) checks
   `errorCode === "ETIMEDOUT"`. When `execFile`'s `timeout` kills the child, Node
   sets `killed: true`, `signal: "SIGTERM"`, `code: null`. The test stubs
   `code: "ETIMEDOUT"`, so it never reproduces the real shape. Near-identical
   timeout checks exist in `GitUtils.isTimeoutError` and `ModelRegistry`'s
   CLI-timeout check.

## Suggested Fix

1. Mark the probe settled in `finally` and check it after `await resolveCommand(...)`
   (throw instead of spawning), or tear down any process created after settlement.
   Test with a slow fake resolver.
2. On timeout, return `result.output` when non-empty, else the cache.
3. Add `.once("error", () => {})` to the `taskkill` child.
4. Single-source subprocess timeout detection in one helper (e.g. in
   `src/utils/`) that recognises both `code === "ETIMEDOUT"` and
   `killed === true` with a signal. Use it from all three sites, and fix the test
   to use the real error shape.
