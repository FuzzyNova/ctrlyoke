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

## The shape of the fix

Give the log-tail path its own accumulator, mirroring what the coordinator now
does — but note the two places this is **not** a copy of the coordinator's
accumulator, because the consumer is an extractor rather than a per-record
parser.

### 1. Carry the incomplete tail, feed the extractor the joined text

Hold a `splitCompleteLines` remainder inside `HeadlessLogTail` and run
`extractSessionIdFromStdout` over `carry + chunk` **as one string** — not
line-by-line. Feeding records individually would be a regression for
`QwenCliProvider`, whose extractor is brace-balanced
(`CliParseUtils.extractJsonObjectsFromStream`) rather than line-delimited: an
object spanning several lines inside a single chunk matches today and must keep
matching. Passing the joined text makes the new behaviour a strict superset of
the current per-chunk behaviour.

Retain only `splitCompleteLines(carry + chunk).remainder` after a failed match,
so the buffer stays bounded to one incomplete record rather than growing into a
copy of stdout. Clear the carry once a session ID is resolved — capture is
already gated on `!this.sessionId`, and the buffer has no other consumer.

### 2. Flush the unterminated tail in `finish()`

This is the part the coordinator's `flushStdout` already gets right and that a
naive port of the accumulator would drop. Today's raw-chunk path **does** match
a final record that arrives without a trailing newline; a carry-only fix would
stop matching it, turning a fix into a regression for exactly the streams whose
last write is unterminated.

`finish()` must run the leftover carry through `captureSessionId` once, after
`await this.pendingWork` and **before** `enqueueTick("post-exit discovery")`, so
a late-resolved ID still feeds that discovery pass.

### 3. Preserve tick ordering and the stdout clock

`onStdoutChunk` must still queue a read tick for **every** chunk, including one
that contributes no complete record — stdout is the clock for log reads, and
dropping a tick would delay streaming rather than fix it. Whether the carry is
advanced synchronously in `onStdoutChunk` or inside the queued tick is an
implementation choice; either way chunks must be consumed in arrival order,
since `pendingWork` is what serialises them.

### 4. Leave `observeHeadlessStdout` on raw chunks

Confirmed correct and deliberately unchanged: `AntigravityStreamJsonUsage.ingest`
already does its own `splitCompleteLines` buffering
(`src/core/harness/antigravity/AntigravityStreamJsonUsage.ts`), so handing it
pre-split records would double-buffer and strip the line breaks its
`ingest`/`flush` contract expects. Accumulating only for session-ID capture is
both the lower-risk and the correct shape.

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
