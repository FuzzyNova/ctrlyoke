# Headless Session-ID Chunk Boundary Plan

**Status:** Implemented 2026-09-17 — `HeadlessLogTail` now carries incomplete
stdout records across transport chunks, flushes an unterminated tail at exit,
and preserves raw observer chunks and one log-read tick per stdout chunk.
**Priority:** P3 (recoverable; costs live session-ID resolution, not data)
**Related:** `dev/implemented/STREAM_CHUNK_BOUNDARY_PLAN.md`, which closed the
other three boundary bugs. This document records the follow-up implementation
for the remaining log-tail exposure.

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

Two providers' doc comments state the wrong remedy, in the same shape
`CopilotLogParser`'s "partial write mid-flush" comment did —
`AntigravityCliProvider.extractSessionIdFromStdout` and, word for word,
`CodexCliProvider.extractSessionIdFromStdout`:

> A chunk may end mid-record; `parseJsonLines` drops the incomplete line and
> the next chunk retries it.

The next chunk does not retry it. It carries the record's _second half_ plus
whatever followed; the first half is gone. **Both** comments should be corrected
as part of the fix. `QwenCliProvider`'s comment ("from any complete JSON object
in stdout") is already accurate and needs no change.

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

## What was built

The log-tail path received its own accumulator, separate from the coordinator's
per-spawn accumulator. The lifetimes, consumers, and flush points remain
independent; `splitCompleteLines` is the shared boundary helper.

### 1. Carry the incomplete tail and feed the extractor joined text

`HeadlessLogTail` holds the `splitCompleteLines` remainder and runs
`extractSessionIdFromStdout` over `carry + chunk` as one string. Feeding records
individually would be a regression for
`QwenCliProvider`, whose extractor is brace-balanced
(`CliParseUtils.extractJsonObjectsFromStream`) rather than line-delimited: an
object spanning several lines inside a single chunk matches today and must keep
matching, so the joined text preserves the existing behaviour.

After a failed match, only the new remainder is retained, keeping the buffer
bounded to one incomplete record; a resolved ID clears it.

### 2. Flush the unterminated tail in `finish()`

After pending stdout work completes, `finish()` sends the remaining carry
through `captureSessionId` once, directly, before queuing post-exit discovery.
This preserves matching for a final record without a trailing newline and lets
a session ID resolved at exit participate in that discovery pass.

### 3. Preserve tick ordering and the stdout clock

`onStdoutChunk` still queues one read tick for every chunk, including chunks
without a complete record. Capture remains inside `pendingWork`, so chunks are
consumed in arrival order and the existing session-ID gate stops capture after
resolution.

### 4. Leave `observeHeadlessStdout` on raw chunks

`observeHeadlessStdout` remains unchanged and receives raw chunks.
`AntigravityStreamJsonUsage.ingest` already does its own `splitCompleteLines`
(`src/core/harness/antigravity/AntigravityStreamJsonUsage.ts`), so handing it
pre-split records would double-buffer and strip the line breaks its
`ingest`/`flush` contract expects. Accumulating only for session-ID capture is
the correct shape.

`harness-cli-providers.instructions.md` documents how timing-sensitive these
paths are; the same caution that applied to issue 2 applies here.

## Deliberately not in scope

- Unifying this accumulator with `CliTransportCoordinator`'s. They have
  different lifetimes (one spawn vs. one tail), different consumers (a pure
  record parser vs. a session-ID extractor), and different flush points; sharing
  `splitCompleteLines` is the intended amount of sharing.
- Teaching `QwenCliProvider`'s extractor to return its own brace-balanced
  remainder. Its stdout is NDJSON in practice, so the line-boundary carry is
  sufficient; a second remainder protocol on the provider hook is not worth it.
