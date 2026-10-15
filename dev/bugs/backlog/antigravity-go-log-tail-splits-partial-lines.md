# Antigravity Go-log tailing splits a partially written line in two and drops completion/session markers

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/core/harness/antigravity/AntigravityLogParser.ts`
- **Severity:** low

## Symptom

An Antigravity turn's `RESPONSE_COMPLETED` event (`...clearing ResponsePending` / `Language server shutting down`) or its `SESSION_CREATED` event and session-ID capture (`Starting conversation update stream for <uuid>` / `Print mode: conversation=`) is sometimes missed. This happens when the Go `cli-*.log` is read while agy is partway through writing that line. Completion then depends on the other signals (Stop hook or transcript), and the session ID has to come from fallbacks. Non-ASCII text split at a read boundary is garbled to U+FFFD.

## Steps to Reproduce

1. Create an `AntigravityLogParser` and point `readNewLines` at a temp `cli-YYYYMMDD_HHMMSS.log` file.
2. Append `I1014 12:00:00 Stream completed for 11111111-2222-3333-4444-555555555555, clearing Respon` (no newline) and call `readNewLines`. The result has a `LOG_LINE` event, not `RESPONSE_COMPLETED`.
3. Append `sePending\n` and call `readNewLines` again. The result is another `LOG_LINE` with text `sePending`. `RESPONSE_COMPLETED` is never emitted, and `isComplete()` never returns true from the Go log.
4. Repeat with `Starting conversation update stream for 11111111-2222-33` / `33-4444-555555555555\n`. No `SESSION_CREATED` event is emitted, and `setCachedSessionId` is never called with the full UUID.
5. Repeat with a 3-byte UTF-8 character split across the two appends. Both reads produce U+FFFD.

## Root Cause

`AntigravityLogParser.readNewLines` (`src/core/harness/antigravity/AntigravityLogParser.ts:186`) reads from `lastReadPosition` to the end of the file, sets `this.lastReadPosition = currentSize` (line 211), and then runs `buffer.toString("utf8").split(/\r?\n/)` (line 214). The final segment, which has no newline, is treated as a complete line.

This override does not get the incomplete-tail buffering and `StringDecoder` that `BaseLogParser.readNewLines` provides in `src/core/harness/shared/BaseLogParser.ts`: the `pendingLogText`/`logDecoder` fields (lines 72-74), the remainder handling (lines 422-455), and the reset (lines 467-468). The base class's comment at line 422 explains that this handling exists because fs.watch may fire while the writer is between chunks of the same line.

The marker checks at `AntigravityLogParser.ts:224-246` call `line.includes()` on each fragment, so a marker that is split across two reads matches neither fragment.

## Suggested Fix

Reuse the base class's line splitting instead of duplicating it. Extract the read-and-split part of `BaseLogParser.readNewLines` into a protected helper, for example `readNewCompleteLines(filePath): string[]`. The helper owns `lastReadPosition`, the truncation reset, `pendingLogText` and the `StringDecoder`, and it returns only lines that end in a newline. `AntigravityLogParser.readNewLines` then calls the helper and keeps its own classification (`SESSION_CREATED` / `RESPONSE_COMPLETED` / `LOG_LINE`), the transcript poll and the event ordering.

Add two unit tests:

- Append a completion marker in two writes split mid-token, and assert that exactly one `RESPONSE_COMPLETED` is emitted after the second read.
- Split a multi-byte character across the read boundary, and assert that it decodes correctly.
