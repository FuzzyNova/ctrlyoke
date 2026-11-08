# OpenCode 2 subagent follow-up test is flaky

- **Found:** 2026-11-08 by Claude Code, during the 0.5.1 release's `npm test`
- **Area:** `src/test/unit/OpenCodeBackgroundWork.test.ts` (suite "OpenCodeLogParser subagent follow-up output (OpenCode 2)"), subagent follower in `src/core/harness/opencode/`
- **Severity:** low

## Symptom

"keeps the child's output flowing when the export sees its job first" (`src/test/unit/OpenCodeBackgroundWork.test.ts:566`) sometimes fails:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  [ 'LAUNCHED', -  'CHILD-DONE' ]
```

The child's second text part (`CHILD-DONE`), appended to the sidecar after the first child idle, never reaches the follower's callback. It failed once in a full `npm test` run and once in four isolated runs of the file (`npm run test:extension -- src/test/unit/OpenCodeBackgroundWork.test.ts`) on Windows. The test and the follower code both shipped in 0.5.0 (f10d62b30); nothing in `src/core/harness/opencode/` changed between v0.5.0 and this finding apart from c873f96f2 (harness home env vars).

## Steps to Reproduce

1. Run `npm run test:extension -- src/test/unit/OpenCodeBackgroundWork.test.ts` several times.
2. About one run in four reports `17 passing, 1 failing` with the assertion above.

## Root Cause

Not yet determined. The test depends on timing: the follower polls the sidecar every 5 ms, and the test waits a fixed 60 ms (`settle()`) between appends and assertions. Candidates to check:

- The follower reads the first child idle before the export tracker's state (`replay.childVisible`) is consulted, so the idle ends the child and later sidecar records for it are ignored. That would also be a real, if rare, bug where an interactive OpenCode 2 step stops showing a subagent's follow-up output.
- A sidecar read lands between `replay.childVisible.delete(childId)` and the following `poll()`, which the test assumes cannot happen.
- A fixed 60 ms wait is simply too short on a loaded machine.

## Suggested Fix

First find out whether the follower can end a child on an idle that the export tracker would have kept open (the first candidate). If it can, fix the ordering in the follower and keep the test. If the failure is only test timing, replace `settle()` with waiting for the expected callback, or drive the follower's poll by hand instead of using its interval.
