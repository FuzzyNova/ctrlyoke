# MCP execution-scope test intermittently fails removing its cwd temp dir on Windows

- **Found:** 2026-09-28 by the follow-up-divider fix session (`npm test`)
- **Area:** `src/test/unit/McpServer.test.ts` (`resolves execution scope from env, run metadata, then cwd`)
- **Severity:** low

## Symptom

The case intermittently fails in its `finally` cleanup, after all assertions pass:

```
Error: EBUSY: resource busy or locked, rmdir 'C:\Users\<user>\AppData\Local\Temp\ctrlyoke-mcp-cwd-root-XXXXXX'
```

Seen in 1 of 3 isolated runs and in a full `npm test` run on 2026-09-28. It did not appear in
any earlier `.ctrlyoke/logs/test-runs/` log, and one isolated run of the same case at `2012812c`
passed, so the failure rate appears low but nonzero.

## Steps to Reproduce

1. `npm run compile-tests`
2. Repeat `MOCHA_GREP="resolves execution scope from env" node ./out/test/runTest.js` a few times.

## Root Cause

Not yet investigated. The test `process.chdir`s into `cwdRoot`, invokes the MCP server, changes
back, and immediately `fs.rm`s the directory. On Windows, something still holds a handle
on the directory at that moment (a process started with that cwd, or a scanner). This is the
same shape as the `EBUSY` cleanup races described in `test.instructions.md`.

## Suggested Fix

Give the cleanup `maxRetries`/`retryDelay` and a `.catch(() => {})`, as the git-backed suites
do. Residual temp-dir cleanup should never fail an otherwise green case.
