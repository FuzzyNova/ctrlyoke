# OpenCode 2 subagent follow-up test is flaky

- **Found:** 2026-11-08 by Claude Code, during the 0.5.1 release's `npm test`
- **Area:** `src/core/harness/shared/SubagentSourceFollower.ts` (surfaced by `src/test/unit/OpenCodeBackgroundWork.test.ts`, suite "OpenCodeLogParser subagent follow-up output (OpenCode 2)")
- **Resolution:** fixed in this commit

## Symptom

"keeps the child's output flowing when the export sees its job first" sometimes failed:

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  [ 'LAUNCHED', -  'CHILD-DONE' ]
```

The child's last text part (`CHILD-DONE`) never reached the follower's callback. It failed once in a full `npm test` run and once in four isolated runs of the file on Windows. The test and the follower code both shipped in 0.5.0.

## Steps to Reproduce

1. Run `npm run test:extension -- src/test/unit/OpenCodeBackgroundWork.test.ts` several times.
2. About one run in four reported `17 passing, 1 failing` with the assertion above.

The deterministic reproduction is "a completion report during an in-flight read still gets a final read" in `src/test/unit/SubagentSourceFollower.test.ts`.

## Root Cause

This was a real race in `SubagentSourceFollower`, not just test timing. `markChildComplete()` (called by the Claude Code, OpenCode and Antigravity parsers when the parent stream reports a child done) sets `childComplete`, and the next `readSource()` was meant to be one final read that keeps records the child appended just before the report. But `readSource()` checked `childComplete` _after_ its read returned. When the report landed while a read was already in flight, that read, which may have started before the child's last record was written, was treated as the final one and closed the source. The record was never read.

In the test, the follower's 5 ms interval read could start just before `CHILD-DONE` was appended. The export poll then saw the child's final idle and called `markChildComplete`, and the in-flight read returned without the new record.

## Fix

`readSource()` records whether the report had already arrived before each read. Only such a read can complete the source. If the report arrives during a read, `readSource()` immediately reads once more, and that read sees the report and is final. A `reopenChild()` during the read still cancels the report.
