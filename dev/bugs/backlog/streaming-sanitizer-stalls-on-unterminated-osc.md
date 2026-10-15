# An unterminated OSC escape stalls the streaming sanitizer: it buffers and drops the rest of the stream, with quadratic rescans

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/utils/TerminalOutputSanitizer.ts`
- **Severity:** low

## Symptom

If a script step prints an OSC sequence (`ESC ]`) with no BEL or `ESC \` terminator, the step's live streamed output stops at that point. This can come from a mistyped title escape, binary output, an OSC ended by the C1 ST byte `0x9C`, or a process killed partway through a sequence. Nothing after it reaches the dashboard or the timeline's streaming chunk log until the step finishes and the complete output replaces the placeholder.

While the step streams, the extension host keeps buffering the rest of stdout and rescans the growing buffer on every coalesced chunk, so CPU cost is quadratic in output size. If a BEL appears much later, everything between the stray `ESC ]` and that BEL is removed from the streamed text.

## Steps to Reproduce

1. Create a workflow with a script step such as: `printf '\033]0;title'; for i in $(seq 1 200000); do echo line $i; sleep 0; done`
2. Run the workflow and watch the step's live output in the dashboard.
3. Observed: no streamed lines appear after the OSC introducer. The step's streaming chunks in the run's `events.jsonl` stop there, and the full output appears only when the step completes. Extension-host CPU climbs as the output grows.
4. Unit-level: `const s = new TerminalOutputSanitizer(); s.push('a\x1B]0;t'); s.push('line1\n')` returns `''`, every later `push` also returns `''`, and `s.flush()` returns `''`.

## Root Cause

- `isIncompleteEscape` (`src/utils/TerminalOutputSanitizer.ts:158-160`) returns `true` for any `ESC ]` suffix that contains no BEL or `ESC \`, however long that suffix is.
- `findTrailingIncompleteEscape` (lines 133-143) returns the index of that ESC.
- `push()` (lines 112-119) keeps `input.slice(incompleteStart)` as `pendingEscape`, prepends it to every later chunk, and rescans the whole thing (an `indexOf` loop plus a regex over the growing suffix). No further output is released.
- `flush()` (lines 124-130) discards the buffer.
- The non-greedy `\][\s\S]*?(?:\x07|\x1B\\)` branch of `ANSI_ESCAPE_SEQUENCE_PATTERN` (line 2) lets one stray `ESC ]` consume any number of lines up to a distant BEL.

The only stateful consumer is `ScriptExecutionReporter` (`src/core/orchestration/ScriptExecutionReporter.ts:263`, `:307`, `:346`). It streams script stdout through the sanitizer and places no limit on how long a pending escape can grow.

## Suggested Fix

- Limit how much a pending escape can hold. Add a constant such as `MAX_PENDING_ESCAPE_LENGTH` of a few KB, which is enough for real OSC 8 hyperlinks and titles. Once an unterminated `ESC ]` suffix exceeds it, treat the sequence as complete but invalid: drop the `ESC ]` introducer (or the unterminated OSC prefix up to the first newline) and release the rest through `sanitizeTerminalOutput`.
- Accept C1 ST (`0x9C`) as an OSC terminator. Consider ending an OSC at a newline as well, since real OSC payloads never contain one.
- Apply the same rules in `ANSI_ESCAPE_SEQUENCE_PATTERN` so the non-greedy OSC branch cannot span lines.
- Add unit tests to `src/test/unit/TerminalOutputSanitizer.test.ts` that cover an unterminated OSC followed by many chunks.
