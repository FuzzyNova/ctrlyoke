# Stream Chunk Boundary Plan

**Status:** Issue 1 done; issues 2–3 queued — verified against the code
2026-09-17, staged as four steps
(see "Sequencing")
**Priority:** P2 (P1 for issue 1, which is silent data corruption)
**Related:** commit `8e5a09d7` (`fix: stop readline from splitting JSONL records
on U+2028`) introduced `src/utils/TextLines.ts` and single-sourced _where a line
ends_. This doc covers the other half of that survey: what happens at a **read
boundary**, which that commit deliberately did not touch.
`.github/instructions/utils.instructions.md` carries the durable rule from the
first half; nothing here is recorded there yet because none of it is built.

## The problem in one sentence

Four independent places decode a byte stream incrementally, and three of them
get the boundary wrong in a different way — a UTF-8 character split across a
chunk is corrupted permanently, and a JSONL record split across a chunk is
dropped from the live stream — because each one re-derived the "carry the
partial tail to the next read" logic instead of sharing it.

## How this was found

A survey of every line-delimited-JSON site in `src/` (excluding tests), run
while fixing the U+2028 bug. It turned up **13 independent line→`JSON.parse`
implementations**. The splitting rule is now shared; the buffering is not.

There is no JSONL package dependency in this repo — every one of these is
hand-rolled.

## The three issues

### 1. `CliProcessManager` decodes each stdout chunk independently — corrupts multi-byte characters

**Done:** Added `src/utils/StreamTextDecoder.ts` and converted both streams in
`src/utils/CliProcessManager.spawn()`, `src/utils/ModelRegistry.ts`'s
`execWithClosedStdin()`, and `src/dev/DevCommands.ts` to use it. The helper
flushes trailing partial UTF-8 sequences explicitly at successful process
close, and `CliProcessManager` forwards a non-empty stdout flush to
`onStdout`. Coverage is in `src/test/unit/StreamTextDecoder.test.ts`.

`src/utils/CliProcessManager.ts:108-119` (stdout) and `:117-119` (stderr)

```ts
child.stdout?.on("data", (data: Buffer) => {
  const chunk = data.toString(); // <- no StringDecoder, no setEncoding
  stdout += chunk;
  if (options.onStdout) options.onStdout(chunk);
});

child.stderr?.on("data", (data: Buffer) => {
  stderr += data.toString(); // <- same bug, same spawn
});
```

**stderr has the identical defect** and the original survey missed it. It
matters less than stdout (it feeds failure messages, not stored responses) but
it is the same two-line fix in the same function, so it is not worth splitting
out.

The same per-chunk `Buffer.toString()` pattern appears at two more spawn sites —
`src/utils/ModelRegistry.ts:359-360` (`stdout += chunk` over a raw `Buffer`,
model-list output) and `src/dev/DevCommands.ts:146,157` (dev build output
streamed to the webview). Neither is P1, but both are the same three lines, and
fixing them together is what makes a shared decode helper worth having instead
of a third hand-rolled copy.

`spawn()` is called with no `encoding` option and the stream is never given
`setEncoding`, so `data` is a raw `Buffer` and each chunk is decoded in
isolation. A UTF-8 sequence whose bytes straddle a chunk boundary decodes to the
replacement character on both sides.

This is the most severe of the three, because unlike issue 2 it is **not
recoverable downstream**: `stdout` is accumulated from the already-corrupted
strings, so the final response stored in `events.jsonl` carries the replacement
characters too. Every harness is affected (this is the shared headless
transport), and it needs no exotic input — em dashes, curly quotes, box-drawing
characters, emoji and CJK are ordinary in AI output. A ~1 MB response crosses
~16 chunk boundaries.

The fix is one `StringDecoder` per spawn, which is exactly what `BaseLogParser`
already does for file reads (`BaseLogParser.ts:73`). The accumulated `stdout`
must be built from the decoded chunks (it already is), and the decoder needs an
`end()` at process exit to flush a trailing partial sequence.

### 2. `CliTransportCoordinator` hands raw chunks to stateless NDJSON parsers

`src/core/harness/shared/CliTransportCoordinator.ts:468`

```ts
const events = source.parseStdout?.(chunk) ?? [];
```

Called per raw stdout chunk with no accumulator. The three
`HEADLESS_SOURCE_MODES.STDOUT` providers all lose a record that straddles a
boundary:

| Provider | `parseHeadlessStdout` uses                   | What happens to a straddling record |
| -------- | -------------------------------------------- | ----------------------------------- |
| Copilot  | `CliParseUtils.parseJsonLines`               | Both halves fail to parse, skipped  |
| OpenCode | `CliParseUtils.parseJsonLines`               | Both halves fail to parse, skipped  |
| Claude   | `CliParseUtils.extractJsonObjectsFromStream` | `remainder` is destructured away    |

`extractJsonObjectsFromStream` is the sharpest evidence that this is a bug and
not a design: it returns `{ objects, remainder }` and its own doc comment says
"_Parsed objects and remainder for next chunk_" — the API was built to be used
statefully, and **every** call site (`ClaudeCliProvider.ts:176` and `:194`,
`QwenCliProvider.ts:167`) destructures only `{ objects }`.

**Severity is lower than it first looks, but the failure mode is nastier.**
`CliResponseCollector.ts:190` re-parses the _complete_ accumulated stdout at the
end, so the final response is intact (modulo issue 1). What is lost is the
**live** event. Per the `CLI_OUTPUT_EVENTS_APPENDED` rule in
`.github/instructions/orchestration.instructions.md`, the webview renders an
attempt from its activity entries whenever any exist and _drops_ the
`cliOutputRecorded` aggregate they stand in for. So a dropped live event
plausibly means: correct while streaming minus that event, and then on reload
the aggregate that did contain it is discarded in favour of the incomplete
activity entries. That is the same silent-vanish shape
`handleSessionActivityResumed` produced.

**That consequence is inferred from the documented rendering rule, not
observed.** Confirm it against a real capture before sizing the fix — if the
live pump and the final parse both feed the same timeline event, the impact may
be limited to the streaming view only.

### 3. `CopilotLogParser`'s OTel reader has neither a decoder nor a pending-line buffer

`src/core/harness/copilot/CopilotLogParser.ts:282-303`

A byte-offset tail read (`otelReadPosition`) that advances to `currentSize`
unconditionally and then does `splitLines(buffer.toString("utf8"))`. A record
straddling a poll boundary is permanently lost (the read position has already
moved past it), and a multi-byte character on the boundary is corrupted the same
way as issue 1.

Its own comment calls the skipped line a "partial write mid-flush" — the right
diagnosis and the wrong remedy: the partial line should be retained and
completed, not discarded. Per
`.github/instructions/harness-cli-providers.instructions.md`, this OTel export is
"the only genuinely live, per-turn context signal left" for Copilot since CLI
1.0.x removed the others, so losing records here degrades context-window
tracking with no error.

## The shape of the fix

Add one primitive to `src/utils/TextLines.ts` alongside `splitLines` /
`streamFileLines`:

```ts
/** Complete lines plus the unterminated tail, for an incremental reader. */
export function splitCompleteLines(content: string): {
  lines: string[];
  remainder: string;
};
```

That is the single missing piece. Four call sites collapse onto it:

| Site                                                        | Today                                          |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `BaseLogParser.readNewEntries` (`BaseLogParser.ts:416-453`) | correct; `pendingLogText` + `StringDecoder`    |
| `AntigravityTranscriptReader` (`:185-194`)                  | correct; `pendingText` + per-state decoder     |
| `AntigravityStreamJsonUsage` (`:133-146`)                   | correct; `incompleteLine` + explicit `flush()` |
| `CopilotLogParser` OTel (`:282-303`)                        | **missing entirely** — issue 3                 |

The two correct ones are the reference implementations.
`AntigravityStreamJsonUsage.flush()` is the affordance the other two lack an
explicit equivalent of, and any shared helper has to keep it: a stream that ends
without a trailing newline still has one real record pending.

Issues 1 and 2 are _not_ solved by that helper alone:

- **Issue 1** is a `StringDecoder` at the spawn, independent of line semantics.
  Do it first and separately — smallest change, largest correctness win, and
  testable without touching any harness parser.
- **Issue 2** needs the _coordinator_ to own a per-run accumulator, because the
  provider hooks (`parseHeadlessStdout`) are pure functions by design and should
  stay that way. Two candidate shapes: give `CliTransportCoordinator` a
  `splitCompleteLines` accumulator and pass only complete lines to
  `parseStdout`; or give the `stdoutEventPump` the accumulator. Prefer the
  former — `parseStdout`'s contract then becomes "you are given whole records",
  which is what all three providers already assume. Claude's brace-balanced
  parser is the exception to check: it is newline-agnostic, so it wants the
  `remainder` threaded rather than line splitting.

## Sequencing

Staged as four steps, each independently committable:

1. **Issue 1 alone.** One `StringDecoder` per stream in
   `CliProcessManager.spawn` (stdout _and_ stderr), plus `decoder.end()` on
   `close` so a trailing partial sequence is flushed into the accumulated text.
   Single-source the pattern in a small helper and convert `ModelRegistry` and
   `DevCommands` onto it. No harness parser changes. Verifiable with a unit test
   that feeds a split multi-byte sequence through the chunk callback.
2. **`splitCompleteLines` + issue 3.** Add the helper to `TextLines.ts` and
   convert the Copilot OTel reader — the broken one — to it, giving it both the
   pending-line buffer and the `StringDecoder` it lacks. `setOtelFilePath` resets
   `otelReadPosition`, so it must reset the new state too.
3. **Converge the correct readers** (`BaseLogParser.readNewEntries`,
   `AntigravityTranscriptReader`, `AntigravityStreamJsonUsageAccumulator`) onto
   `splitCompleteLines`. Pure refactor, no behaviour change — safe but not
   urgent, hence after the bug fixes. `BaseLogParser`'s trailing-line policy
   (try to parse the tail, retain it only if parsing proves it incomplete) is a
   real behavioural difference from the other two and must survive the
   conversion.
4. **Issue 2 last**, and only after confirming the reload consequence above
   against a real capture. It is the change most likely to perturb live
   streaming behaviour, and `harness-cli-providers.instructions.md` documents how
   sensitive these paths are to timing. Two details confirmed while verifying
   this plan: `CliLogEventPump.processEvent` does no de-duplication, so flushing
   the accumulator's tail after the spawn resolves emits that last record exactly
   once; and the LOG-mode sibling path has the same boundary exposure for a
   different reason — `HeadlessLogTail.captureSessionId` runs
   `extractSessionIdFromStdout` against one raw chunk at a time, so a session ID
   split across chunks is simply not matched (it recovers only because
   `CliResponseCollector` re-runs the same extractor over the full accumulated
   stdout afterwards). Worth a look while the accumulator is being added; not a
   reason to expand this step.

## Deliberately not in scope

- `CodexAppServerClient.ts:126` uses `readline` + `JSON.parse` over the Codex
  app-server's stdio, which the `TextLines` doc comment warns against. It is
  confined to quota probing (`initialize`, `account/read`,
  `account/rateLimits/read`) whose payloads are account metadata, never model
  output or web content, and an unparseable line is silently ignored rather than
  throwing. Low value, non-zero risk; leave it unless the app-server surface
  grows.
- The per-caller bad-line policies (throw / skip+log / stash) are genuinely
  different requirements, not duplication. Do not try to unify them.
