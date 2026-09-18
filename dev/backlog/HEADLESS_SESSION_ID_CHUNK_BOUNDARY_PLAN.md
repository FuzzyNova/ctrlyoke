# Headless Session-ID Chunk Boundary Plan

**Status:** Backlog — not started
**Priority:** P3 (recoverable; costs live session-ID resolution, not data)
**Related:** `dev/implemented/STREAM_CHUNK_BOUNDARY_PLAN.md`, which closed the
other three boundary bugs. This is the one exposure that survey deliberately
left open, carved out here so it does not get buried in an implemented doc.

## The problem

`HeadlessLogTail.captureSessionId` (`src/core/harness/shared/HeadlessLogTail.ts`)
runs the provider's `extractSessionIdFromStdout` against **one raw stdout chunk
at a time**:

```ts
const sessionId = this.options.extractSessionIdFromStdout?.(chunk);
```

This is the LOG-mode sibling of issue 2 in the parent plan. That issue was fixed
by giving `CliTransportCoordinator` a per-spawn `splitCompleteLines`
accumulator, so the STDOUT-mode providers now only ever see whole records. The
log-tail path has no such accumulator, so a record split across a chunk boundary
is simply not matched — and when the split record is the init record carrying the
session ID, it is never matched at all.

`AntigravityCliProvider.extractSessionIdFromStdout`'s own doc comment states the
wrong remedy, in the same shape `CopilotLogParser`'s "partial write mid-flush"
comment did:

> A chunk may end mid-record; `parseJsonLines` drops the incomplete line and
> the next chunk retries it.

The next chunk does not retry it. It carries the record's _second half_ plus
whatever followed; the first half is gone. The comment should be corrected as
part of the fix.

## Why it is only P3

It is recoverable twice over, which is why the parent plan ranked it below the
three it fixed:

- `CliResponseCollector.collectHeadlessResponse` re-runs the same extractor over
  the **full accumulated stdout** once the process exits, so the session ID is
  resolved before the response is stored.
- Providers that also implement `extractSessionIdFromLogs` have a second
  independent path.

What is lost is _live_ resolution: `HeadlessLogTail` uses the session ID to
discover and start tailing the log, so a missed init record delays streaming
until the idle poll or post-exit discovery picks the log up. Affects the three
LOG-mode harnesses (`codex-cli`, `antigravity-cli`, `qwen-cli`).

## The shape of the fix

Give the log-tail path its own accumulator, mirroring what the coordinator now
does:

- Hold a `splitCompleteLines` remainder inside `HeadlessLogTail` and feed
  `captureSessionId` (and `onStdoutChunkObserved`, if it turns out to need it)
  complete records only.
- Check `observeHeadlessStdout` before changing what it receives:
  `AntigravityStreamJsonUsageAccumulator` already does its own buffering, so
  handing it pre-split records must not double-buffer or strip the line breaks
  its `ingest`/`flush` contract expects. Keeping the observer on raw chunks and
  accumulating only for session-ID capture is the lower-risk shape.
- Correct the `AntigravityCliProvider.extractSessionIdFromStdout` doc comment.

`harness-cli-providers.instructions.md` documents how timing-sensitive these
paths are; the same caution that applied to issue 2 applies here.

## Deliberately not in scope

- Unifying this accumulator with `CliTransportCoordinator`'s. They have
  different lifetimes (one spawn vs. one tail) and different consumers; sharing
  `splitCompleteLines` is the intended amount of sharing.
