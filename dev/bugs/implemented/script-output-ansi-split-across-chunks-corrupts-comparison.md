# ANSI escapes split across output chunks leave junk in script output and break comparisons

- **Found:** 2026-09-28 by lots-of-bug-fixes final step (Claude)
- **Area:** `src/core/WorkflowExecutor.ts` (`executeScriptStep`, `interactive: true` PTY path ~L2606-2633), `src/core/orchestration/ScriptExecutionReporter.ts` (`publishChunk` ~L256)
- **Resolution:** fixed in this commit

## Symptom

A script step with `interactive: true` (run in a PTY) whose condition compares stdout (`compareSource: stdout`,
`operator: eq`, `expected: PASS`) can fail even though the script printed exactly `PASS`. PTY
output is full of color codes, and when one escape sequence is split between two output chunks,
the leftover tail (e.g. `[39m`) ends up in the text the comparison sees. The same junk also shows in
the streamed output that gets persisted to history and shown on the dashboard.

## Steps to Reproduce

Verified with a tsx probe against the real `sanitizeTerminalOutput`:

1. Chunks `["\x1b[32mPASS\x1b[3", "9m\r\n"]` (a color reset split after `\x1b[3`).
2. What the PTY path does: sanitize each chunk, join, sanitize again → `"PASS[39m\n"`.
3. `compareScriptOutput({compareSource:"stdout",operator:"eq",expected:"PASS"})` on that text
   returns `passed: false`, `actual: "PASS[39m"`.
4. Sanitizing the raw joined text once gives `"PASS\n"`, which passes.

## Root Cause

`sanitizeTerminalOutput` (`src/utils/TerminalOutputSanitizer.ts`) is not safe to run on a
stream one piece at a time. On the first chunk, the incomplete `\x1b[3` doesn't match the ANSI
pattern, so the control-character pass deletes only the lone `\x1b` and leaves `[3`. After the
join, `[39m` no longer starts with ESC, so the second pass can't recognize it.

- `WorkflowExecutor.ts:2607` pushes `sanitizeTerminalOutput(chunk)` into `outputChunks`, and
  L2633 sanitizes the join again. The per-chunk pass is redundant, and it's what causes the damage.
- `ScriptExecutionReporter.ts:257` sanitizes each streamed chunk before writing it to history and
  the dashboard, which corrupts the same way. The final `response` (L329) is sanitized from the
  whole stdout and is clean, so only the streamed rows are affected.

## Suggested Fix

- `WorkflowExecutor`: push the raw `chunk` and keep the single sanitize over the joined text.
- `ScriptExecutionReporter.publishChunk`: keep a small carry-over buffer so an unfinished escape
  sequence at the end of a chunk is held back and prepended to the next chunk before
  sanitizing, then flushed when the stream ends. A small stateful helper next to
  `sanitizeTerminalOutput` in `TerminalOutputSanitizer.ts` would let both paths share it.
- Tests: a unit test for the stateful helper with CSI/OSC sequences split at every offset, and
  an executor or reporter test that feeds split chunks and asserts a passing `eq` comparison and
  clean streamed text.
